/**
 * The evaluation matrix runner: executes every case × run as a fresh
 * structured-output subagent, with the provider/model frozen to the calling
 * agent's own route. Raw per-cell scores come back to the host; aggregation
 * and acceptance happen in code (`src/score.ts`).
 *
 * Uses the host-plane `subagents` service (available in every profile) with
 * the native `outputSchema` structured-output seam: the provider validates
 * the child's reply against the cell schema, so the host never parses
 * model text for evaluations. (The workflow engine was rejected because the
 * web profile keeps it in a per-agent isolated realm a host plugin cannot
 * resolve.)
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { BenchmarkCase, CellScore } from "./benchmark.js";
import { mapPool } from "./pool.js";

export interface EvaluateOptions {
	cases: readonly BenchmarkCase[];
	runs: number;
	passThreshold: number;
	/** Serialized harness state under test (the candidate's guidance). */
	harnessOverview: string;
	label: string;
	signal?: AbortSignal;
}

const EVAL_SYSTEM_PROMPT = `You are one evaluation unit in a benchmark matrix.

You are the agent under evaluation. Perform the case task using your tools,
then score your own execution strictly against the rubric. The harness
guidance attached to the state under test is included in the task.

Your reply is structured (see the requested output schema): caseId, run,
score (0-100), passed (true iff score >= the stated threshold), and notes
(concrete evidence for the score).`;

const CELL_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		caseId: { type: "string" },
		run: { type: "number" },
		score: { type: "number" },
		passed: { type: "boolean" },
		notes: { type: "string" },
	},
	required: ["caseId", "run", "score", "passed", "notes"],
};

interface SubagentsService {
	start(
		name: string,
		request: {
			label?: string;
			prompt: { type: "text"; text: string }[];
			parent: Agent;
			signal: AbortSignal;
			outputSchema?: unknown;
		},
	): Promise<{
		result: Promise<{ output?: { type: string; text?: string }[]; structured?: unknown; stopReason?: string }>;
		dispose(): void;
	}>;
}

export interface EvaluationOutcome {
	label: string;
	cells: CellScore[];
	stopReason: string;
}

/** How many evaluation units may run concurrently (bounded subagent fan-out). */
export const DEFAULT_EVALUATION_CONCURRENCY = 4;

export async function evaluateState(ctx: Context, agent: Agent, options: EvaluateOptions): Promise<EvaluationOutcome> {
	if (!agent.options.provider || !agent.options.model) {
		throw new Error("evolve: benchmark evaluation requires a provider/model route");
	}
	const subagents = (ctx as unknown as { subagents?: SubagentsService }).subagents;
	if (!subagents) {
		throw new Error("evolve: benchmark evaluation requires the subagents service");
	}
	const units: { case: BenchmarkCase; run: number }[] = [];
	for (const c of options.cases) {
		for (let run = 1; run <= options.runs; run += 1) {
			units.push({ case: c, run });
		}
	}
	const cells = await mapPool(units, DEFAULT_EVALUATION_CONCURRENCY, (unit) =>
		runUnit(subagents, agent, options, unit.case, unit.run),
	);
	return { label: options.label, cells, stopReason: "completed" };
}

async function runUnit(
	subagents: SubagentsService,
	agent: Agent,
	options: EvaluateOptions,
	c: BenchmarkCase,
	run: number,
): Promise<CellScore> {
	const prompt = [
		EVAL_SYSTEM_PROMPT,
		"---",
		"Your harness guidance (state under test):",
		`<harness_overview>\n${options.harnessOverview}\n</harness_overview>`,
		`Case ${c.id} — task (statement):\n${c.statement}`,
		`Rubric — score yourself strictly against these criteria:\n${c.rubric}`,
		`Run ${run} of ${options.runs}. passThreshold = ${options.passThreshold}.`,
		"Execute the task with your tools, then produce the structured evaluation.",
	].join("\n\n");
	try {
		const runObj = await subagents.start("spawn", {
			label: `${c.id} r${run}`,
			prompt: [{ type: "text", text: prompt }],
			parent: agent,
			signal: options.signal ?? new AbortController().signal,
			outputSchema: CELL_SCHEMA,
		});
		try {
			const settled = await runObj.result;
			if (settled.stopReason !== "completed") {
				throw new Error(`child stopped: ${settled.stopReason ?? "unknown"}`);
			}
			const parsed =
				normalizeCell(settled.structured, c.id, run, options.passThreshold) ??
				fromOutputText(settled.output, c.id, run, options.passThreshold);
			if (!parsed) {
				throw new Error("child returned neither a structured value nor usable text");
			}
			return parsed;
		} finally {
			runObj.dispose();
		}
	} catch (cause) {
		return {
			caseId: c.id,
			run,
			score: 0,
			passed: false,
			notes: `unit failed: ${cause instanceof Error ? cause.message : String(cause)}`,
		};
	}
}

/** Validate a provider-validated structured cell; returns undefined when malformed. */
export function normalizeCell(value: unknown, caseId: string, run: number, passThreshold: number): CellScore | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const score = Number(record["score"]);
	if (!Number.isFinite(score)) return undefined;
	return {
		caseId: typeof record["caseId"] === "string" && record["caseId"].length > 0 ? record["caseId"] : caseId,
		run: typeof record["run"] === "number" && Number.isFinite(record["run"]) ? Math.trunc(record["run"]) : run,
		score: Math.min(100, Math.max(0, score)),
		passed: record["passed"] === true || score >= passThreshold,
		notes: typeof record["notes"] === "string" ? record["notes"] : "",
	};
}

/** Fallback: recover a cell from the child's text blocks when no structured value arrived. */
function fromOutputText(
	blocks: { type: string; text?: string }[] | undefined,
	caseId: string,
	run: number,
	passThreshold: number,
): CellScore | undefined {
	if (!Array.isArray(blocks)) return undefined;
	const text = blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
	if (text.length === 0) return undefined;
	try {
		const value = JSON.parse(text) as unknown;
		return normalizeCell(value, caseId, run, passThreshold);
	} catch {
		return undefined;
	}
}
