/**
 * The manual eval trigger (P5b): `evolve_eval_run` runs the four-arm batch
 * on the host plane (D11=A) and returns the `compare.md` body for the
 * operator to file under `evals/runs/`. Same tool shape as the unified
 * management tools; the route resolves per call from the calling agent
 * (never from arguments), the arm contexts arrive from the mount.
 */
import type { EvalArm } from "../data/records.js";
import { cwdOf } from "../services/agent.js";
import { runEvalBatch } from "../services/eval-runner.js";
import { loadTaskset, taskDirOfSelf } from "../services/eval-taskset.js";
import type { LlmRuntime } from "../services/llm-call.js";
import type { ModelSelection } from "../services/model-route.js";
import type { MemoryStore } from "../store.js";
import { sessionIdOf, textTool, type ToolExec, type ToolsService } from "./evolve-tools.js";

/** The mount's fixed facts: LLM service, per-call route, arm contexts. */
export interface EvalToolFixed {
	readonly llm: LlmRuntime | undefined;
	readonly resolveRoute: (agent: unknown) => ModelSelection | undefined;
	readonly injectionFor: (arm: EvalArm, workspaceId: string) => { system: string; preview: string };
}

const EVAL_RUN_PARAMETERS = {
	type: "object",
	properties: {
		subset: { type: "number", description: "只跑前 N 条任务（默认全量，上限 30，超限截断）。" },
		repeat: { type: "number", description: "整批重复次数（默认 2；两次 acc 不一致标 flaky；上限 2，超限截断）。" },
		runId: { type: "string", description: "轮次标识（默认按日期；同日重跑会替换上一轮，自定义可保留多轮）。" },
		budgetCapTokens: { type: "number", description: "token 上限（默认无；超限记 budget_exceeded）。" },
		dryRun: { type: "boolean", description: "只校验任务集、不发起模型调用。" },
	},
	required: [],
	additionalProperties: false,
} as const;

/** Subset ceiling, matching the documented上限. */
const EVAL_SUBSET_MAX = 30;

function numArg(args: Record<string, unknown>, key: string, max?: number): number | undefined {
	const value = args[key];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	const floored = Math.floor(value);
	return max === undefined ? floored : Math.min(floored, max);
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		return undefined;
	}
	return value.trim().slice(0, 80);
}

/**
 * Run one manual batch (or dry-run the task set).
 * @param store - The open central store.
 * @param fixed - The mount's LLM service, route resolver, and arm contexts.
 * @param workspaceId - The partition under test.
 * @param exec - The host tool execution context (route source).
 * @param args - The tool arguments.
 * @returns The compare markdown (or dry-run summary) with filing note.
 */
export async function executeEvalRun(
	store: MemoryStore,
	fixed: EvalToolFixed,
	workspaceId: string,
	exec: ToolExec,
	args: Record<string, unknown>,
): Promise<string> {
	if (args.dryRun === true) {
		const loaded = loadTaskset(taskDirOfSelf());
		const subset = numArg(args, "subset");
		const tasks = subset === undefined ? loaded.tasks : loaded.tasks.slice(0, subset);
		const problems = loaded.errors.length === 0 ? "无" : loaded.errors.join("; ");
		return `dry-run: ${tasks.length} 条任务可用，问题：${problems}`;
	}
	const route = fixed.resolveRoute(exec.agent);
	if (route === undefined) {
		return "错误：宿主没有可用的模型路由（agentDefaultModel 缺席），本次评测未跑、未记账。";
	}
	const today = new Date().toISOString().slice(0, 10);
	const out = await runEvalBatch(
		{
			store,
			llm: fixed.llm,
			route,
			sessionId: sessionIdOf(exec),
			today,
			injectionFor: fixed.injectionFor,
		},
		{
			workspaceId,
			...(numArg(args, "subset", EVAL_SUBSET_MAX) === undefined ? {} : { subset: numArg(args, "subset", EVAL_SUBSET_MAX) }),
			...(numArg(args, "repeat") === undefined ? {} : { repeat: numArg(args, "repeat") }),
			...(strArg(args, "runId") === undefined ? {} : { runId: strArg(args, "runId") }),
			...(numArg(args, "budgetCapTokens") === undefined ? {} : { budgetCapTokens: numArg(args, "budgetCapTokens") }),
		},
	);
	const warnings = out.warnings.length === 0 ? "" : `\n警告: ${out.warnings.join("; ")}`;
	return `${out.markdown}\ncaseRows: ${out.cases}${warnings}\n（将上文 compare 存入 evals/runs/<日期>/compare.md 后提交）`;
}

/**
 * Register the manual eval trigger.
 * @param tools - The host tools service.
 * @param store - The open central store.
 * @param fixed - The mount's LLM service, route resolver, and arm contexts.
 * @returns A disposer that removes the tool.
 */
export function registerEvalTools(tools: ToolsService, store: MemoryStore, fixed: EvalToolFixed): () => void {
	const disposer = tools.register(
		textTool(
			"evolve_eval_run",
			"手动跑一次记忆/技能四臂评测（base/current/candidate/reflect，默认重复两次判 flaky）。只在用户明确要求跑评测、发版前或双月外锚时调用；返回 compare.md 正文，调用者负责落盘提交。",
			EVAL_RUN_PARAMETERS,
			async (args, exec: ToolExec) => {
				const cwd = cwdOf(exec.agent);
				if (cwd === undefined) {
					return "错误：当前会话没有可用的工作区路径，无法确定评测分区。";
				}
				return executeEvalRun(store, fixed, cwd, exec, args);
			},
		),
	);
	return () => {
		if (typeof disposer === "function") {
			disposer();
		}
	};
}
