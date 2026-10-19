/**
 * The four-arm batch runner (P5b): tasks × arms × `--repeat 2`, deterministic
 * 判据 locally executed, recall QA from the store's own search, case rows
 * through the store's sole write path. LLM contact is single-round
 * direct-call only (D11=A); the only host-plane needs — route, session, and
 * the current-arm injection text — arrive as dependencies, so this module
 * never touches host services itself.
 */
import { EVAL_LAST_FOUR_ARM_KEY } from "../data/eval-cases.js";
import { EVAL_ARMS, type EvalArm, type EvalCaseWrite } from "../data/records.js";
import type { MemoryStore } from "../store.js";
import { qaRecallVerdict, judgeTwice } from "./eval-judge.js";
import { renderCompare, totalArm, type ArmResult, type ArmTaskRecord, type CompareReport } from "./eval-report.js";
import { checkExpects, solveSingleRound } from "./eval-solver.js";
import { loadTaskset, taskDirOfSelf, type EvalTask } from "./eval-taskset.js";
import type { LlmRuntime } from "./llm-call.js";
import type { ModelSelection } from "./model-route.js";
import { subagentLoaderFor } from "./subagent.js";

/** Everything one batch run is bound to (host-plane facts, injected). */
export interface EvalRunDeps {
	readonly store: MemoryStore;
	readonly llm: LlmRuntime | undefined;
	readonly route: ModelSelection;
	readonly sessionId?: string | undefined;
	readonly today: string;
	/** Arm context: base is "", current is the production section text. */
	readonly injectionFor: (arm: EvalArm, workspaceId: string) => { system: string; preview: string };
}

/** Batch options (all knobs the manual tool exposes). */
export interface EvalRunOptions {
	readonly workspaceId: string;
	readonly subset?: number | undefined;
	readonly repeat?: number | undefined;
	readonly runId?: string | undefined;
	readonly commit?: string | undefined;
	readonly budgetCapTokens?: number | undefined;
}

/** A finished batch: the report, its markdown, and the write count. */
export interface EvalBatchOut {
	readonly report: CompareReport;
	readonly markdown: string;
	readonly cases: number;
	readonly warnings: string[];
}

interface ScoredTask {
	readonly record: ArmTaskRecord;
	readonly reply: string;
	readonly preview: string;
	readonly query: string;
}

function recallOf(deps: EvalRunDeps, workspaceId: string, task: EvalTask, warnings: string[]): boolean | null {
	if (task.recall === undefined) {
		return null;
	}
	try {
		const ids = deps.store.search(workspaceId, task.recall.query ?? task.prompt, 10).map((record) => record.id);
		return qaRecallVerdict(ids, task.recall.expectIds, task.recall.negative ?? false);
	} catch {
		warnings.push(`${task.id}: recall check failed`);
		return null;
	}
}

async function judgeOf(
	deps: EvalRunDeps,
	task: EvalTask,
	reply: string,
	warnings: string[],
): Promise<{ pass: boolean; note: string }> {
	if (!task.tags.includes("judge")) {
		return { pass: true, note: "" };
	}
	if (deps.llm === undefined) {
		warnings.push(`${task.id}: judge task without an LLM route`);
		return { pass: false, note: "no judge route" };
	}
	const loader = subagentLoaderFor({ llm: deps.llm, route: deps.route, sessionId: deps.sessionId, today: deps.today });
	const pair = await judgeTwice(loader, `${task.prompt}\n---\n${reply}`);
	if (!pair.consistent || pair.first === null) {
		return { pass: false, note: pair.consistent ? "judge returned no verdict" : "judge disagreed with itself" };
	}
	return { pass: pair.first, note: "" };
}

async function scoreTask(deps: EvalRunDeps, workspaceId: string, arm: EvalArm, task: EvalTask, warnings: string[]): Promise<ScoredTask> {
	const built = deps.injectionFor(arm, workspaceId);
	const solved = await solveSingleRound(task, built.system, { llm: deps.llm, route: deps.route, sessionId: deps.sessionId, today: deps.today });
	if (solved.error !== undefined) {
		return {
			record: { id: task.id, pass: false, flaky: false, rounds: 1, toolCalls: 0, cost: solved.usage.total, recallHit: null, note: solved.error },
			reply: "",
			preview: built.preview,
			query: task.recall?.query ?? task.prompt,
		};
	}
	const verdicts = checkExpects(task, solved.reply, workspaceId);
	const failed = verdicts.filter((verdict) => !verdict.pass);
	const judged = await judgeOf(deps, task, solved.reply, warnings);
	const pass = failed.length === 0 && judged.pass;
	const notes = [...failed.map((verdict) => verdict.detail), judged.note].filter((note) => note.length > 0).join("; ");
	return {
		record: {
			id: task.id,
			pass,
			flaky: false,
			rounds: 1,
			toolCalls: 0,
			cost: solved.usage.total,
			recallHit: recallOf(deps, workspaceId, task, warnings),
			note: solved.accounted ? notes : `unaccounted usage; ${notes}`,
		},
		reply: solved.reply,
		preview: built.preview,
		query: task.recall?.query ?? task.prompt,
	};
}

function mergeRepeats(first: ScoredTask, second: ScoredTask): { record: ArmTaskRecord; reply: string; preview: string; query: string } {
	const flaky = first.record.pass !== second.record.pass;
	return {
		record: {
			...first.record,
			pass: first.record.pass && second.record.pass,
			flaky,
			cost: first.record.cost + second.record.cost,
			note: flaky ? `flaky across repeats; ${first.record.note}` : first.record.note,
		},
		reply: first.reply,
		preview: first.preview,
		query: first.query,
	};
}

function caseRow(runId: string, repeat: number, arm: EvalArm, workspaceId: string, scored: ScoredTask, today: string): EvalCaseWrite {
	return {
		runId: `${runId}-r${repeat}`,
		taskId: scored.record.id,
		arm,
		workspaceId,
		query: scored.query,
		injectionPreview: scored.preview,
		reply: scored.reply,
		createdAt: today,
	};
}

/**
 * Run the full batch: every task on every arm, twice.
 * @param deps - The bound store, route, session, and arm contexts.
 * @param options - Workspace, subset, repeat count, identity, budget cap.
 * @returns The report with markdown, case-row count, and warnings.
 */
export async function runEvalBatch(deps: EvalRunDeps, options: EvalRunOptions): Promise<EvalBatchOut> {
	const warnings: string[] = [];
	const loaded = loadTaskset(taskDirOfSelf());
	for (const error of loaded.errors) {
		warnings.push(error);
	}
	const tasks = options.subset === undefined ? loaded.tasks : loaded.tasks.slice(0, options.subset);
	const runId = options.runId ?? `eval-${deps.today.slice(0, 10)}`;
	const repeats = options.repeat ?? 2;
	const arms = {} as Record<EvalArm, ArmResult>;
	const flakyIds: string[] = [];
	const rows: EvalCaseWrite[] = [];
	for (const arm of EVAL_ARMS) {
		const records: ArmTaskRecord[] = [];
		for (const task of tasks) {
			const first = await scoreTask(deps, options.workspaceId, arm, task, warnings);
			rows.push(caseRow(runId, 1, arm, options.workspaceId, first, deps.today));
			let merged = mergeRepeats(first, first);
			if (repeats > 1) {
				const second = await scoreTask(deps, options.workspaceId, arm, task, warnings);
				rows.push(caseRow(runId, 2, arm, options.workspaceId, second, deps.today));
				merged = mergeRepeats(first, second);
			}
			if (merged.record.flaky) {
				flakyIds.push(`${arm}/${task.id}`);
			}
			records.push(merged.record);
		}
		arms[arm] = totalArm(arm, records);
	}
	let cases = 0;
	try {
		cases = deps.store.writeEvalCases(rows);
	} catch {
		warnings.push("eval_cases write failed");
	}
	try {
		deps.store.setState("", EVAL_LAST_FOUR_ARM_KEY, JSON.stringify({ date: deps.today, commit: options.commit ?? "" }));
	} catch {
		warnings.push("eval:last-four-arm write failed");
	}
	const totalCost = EVAL_ARMS.reduce((sum, arm) => sum + arms[arm].totals.cost, 0);
	const cap = options.budgetCapTokens;
	const budgetNote = cap === undefined
		? `实测 ${totalCost} tokens（已记为下次基线）`
		: totalCost <= cap ? `within cap ${cap}（实测 ${totalCost}）` : `budget_exceeded: ${totalCost} > ${cap}`;
	const report: CompareReport = {
		runId,
		date: deps.today,
		commit: options.commit ?? "",
		taskCount: tasks.length,
		arms,
		flakyIds,
		budgetNote,
	};
	return { report, markdown: renderCompare(report), cases, warnings };
}
