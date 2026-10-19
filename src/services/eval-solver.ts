/**
 * The task solver (P5b): one single-round call per task through the
 * subagent loader (D11=A — the same transport discipline as the extraction
 * and review tracks, no new key custody), plus local execution of the three
 * executable判据 kinds. The `Solver` interface reserves the multi-round
 * tool-loop slot: when the task set grows its first tool-type task, a
 * host-subagent implementation plugs in here without touching the runner
 * (ADR `2026-10-19-p5b-eval-runner`).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SubagentCallError, type LlmRuntime } from "./llm-call.js";
import type { ModelSelection } from "./model-route.js";
import { subagentLoaderFor, type SubagentDefinition } from "./subagent.js";
import { normalizeUsage, zeroUsage, type UsageTotals } from "./token-usage.js";
import type { EvalExpect, EvalTask } from "./eval-taskset.js";

/** What one solve is bound to: the LLM service, the exact route, the session. */
export interface SolverCall {
	readonly llm: LlmRuntime | undefined;
	readonly route: ModelSelection;
	readonly sessionId?: string | undefined;
	readonly today: string;
}

/** One solved task: the reply plus the observed call facts. */
export interface SolvedTask {
	readonly reply: string;
	readonly usage: UsageTotals;
	readonly accounted: boolean;
	readonly error?: string | undefined;
}

/** One判据's verdict. */
export interface ExpectVerdict {
	readonly kind: EvalExpect["kind"];
	readonly pass: boolean;
	readonly detail: string;
}

/** Output budget fallback for one solve (the exact model's cap wins). */
export const EVAL_SOLVE_MAX_TOKENS = 2048;

/** `test-pass` wall clock: a hung command fails the task, never the batch. */
export const EVAL_TEST_TIMEOUT_MS = 60000;

/** Longest command output kept per task (truncated head, never rejected). */
export const EVAL_TEST_OUTPUT_MAX = 4000;

/**
 * The solve job: one definition per arm context (same job id, varying
 * system text — the arm's injection rides the system role exactly as the
 * production section does).
 * @param system - The arm's system context ("" for the base arm).
 * @returns The loader-ready definition.
 */
export function solveDefinitionFor(system: string): SubagentDefinition<string> {
	return {
		id: "eval-solve",
		system,
		maxTokens: EVAL_SOLVE_MAX_TOKENS,
		parse: (text) => text,
	};
}

/**
 * Solve one task with a single loader call.
 * @param task - The task to solve.
 * @param system - The arm's system context ("" for the base arm).
 * @param call - The bound LLM service, route, session, and day.
 * @returns The reply with usage, or the failure head with partial usage.
 */
export async function solveSingleRound(task: EvalTask, system: string, call: SolverCall): Promise<SolvedTask> {
	const loader = subagentLoaderFor({ llm: call.llm, route: call.route, sessionId: call.sessionId, today: call.today });
	try {
		const answer = await loader.run(solveDefinitionFor(system), task.prompt);
		const normalized = normalizeUsage(answer.usage);
		return {
			reply: answer.text,
			usage: normalized ?? zeroUsage(),
			accounted: normalized !== null,
		};
	} catch (error) {
		const usage = error instanceof SubagentCallError ? normalizeUsage(error.usage) : null;
		return {
			reply: "",
			usage: usage ?? zeroUsage(),
			accounted: usage !== null,
			error: error instanceof Error ? error.message.slice(0, 300) : "solve failed",
		};
	}
}

function checkOutputContains(expect: EvalExpect, reply: string): ExpectVerdict {
	const needles = expect.any ?? [];
	const hit = needles.some((needle) => needle.length > 0 && reply.includes(needle));
	return { kind: "output-contains", pass: hit, detail: hit ? `matched 1/${needles.length} assertions` : `no assertion matched (${needles.length} given)` };
}

function checkFileExists(expect: EvalExpect, workspaceId: string): ExpectVerdict {
	if (typeof expect.path !== "string" || expect.path.length === 0) {
		return { kind: "file-exists", pass: false, detail: "判据 lacks a path" };
	}
	const pass = existsSync(join(workspaceId, expect.path));
	return { kind: "file-exists", pass, detail: pass ? expect.path : `absent: ${expect.path}` };
}

function checkTestPass(expect: EvalExpect, workspaceId: string): ExpectVerdict {
	if (typeof expect.cmd !== "string" || expect.cmd.length === 0) {
		return { kind: "test-pass", pass: false, detail: "判据 lacks a cmd" };
	}
	const run = spawnSync(expect.cmd, { cwd: workspaceId, timeout: EVAL_TEST_TIMEOUT_MS, shell: "/bin/sh", encoding: "utf8" });
	const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.slice(0, EVAL_TEST_OUTPUT_MAX);
	if (run.error !== undefined) {
		return { kind: "test-pass", pass: false, detail: `spawn failed: ${run.error.message.slice(0, 200)}` };
	}
	return { kind: "test-pass", pass: run.status === 0, detail: run.status === 0 ? "exit 0" : `exit ${run.status ?? "?"}: ${out.slice(0, 200)}` };
}

/**
 * Execute one task's判据 locally against its reply.
 * @param task - The task whose判据 run.
 * @param reply - The solver's reply text.
 * @param workspaceId - The anchor `file-exists` paths and `test-pass` commands run against.
 * @returns One verdict per判据; the task passes only when all pass.
 */
export function checkExpects(task: EvalTask, reply: string, workspaceId: string): ExpectVerdict[] {
	return task.expect.map((expect) => {
		if (expect.kind === "output-contains") {
			return checkOutputContains(expect, reply);
		}
		if (expect.kind === "file-exists") {
			return checkFileExists(expect, workspaceId);
		}
		return checkTestPass(expect, workspaceId);
	});
}
