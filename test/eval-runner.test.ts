import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_LAST_FOUR_ARM_KEY } from "../src/data/eval-cases.js";
import { EVAL_ARMS } from "../src/data/records.js";
import { runEvalBatch, type EvalRunDeps } from "../src/services/eval-runner.js";
import { loadTaskset, taskDirOfSelf } from "../src/services/eval-taskset.js";
import type { LlmRuntime } from "../src/services/llm-call.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const KITCHEN_SINK = "CI 全绿 npm .env EXA_API_KEY Clash 备用机场 临时切换 memory.db 唯一写者 提案 门禁 实体拷贝 发版 不建 禁止 不重试 fail-open 直接上报 根因 临时 缓存 重启 人工批准 版本号 30 实习 引用 付费 变现 不知道";

function steadyLlm(): LlmRuntime {
	return {
		stream: async function* () {
			yield { type: "text-delta", text: KITCHEN_SINK };
			yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } };
			yield { type: "finish", reason: { kind: "stop" } };
		},
	} as unknown as LlmRuntime;
}

function alternatingLlm(): LlmRuntime {
	let calls = 0;
	return {
		stream: async function* () {
			calls += 1;
			if (calls % 2 === 0) {
				throw new Error("mid-stream wobble");
			}
			yield { type: "text-delta", text: KITCHEN_SINK };
			yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } };
			yield { type: "finish", reason: { kind: "stop" } };
		},
	} as unknown as LlmRuntime;
}

async function testStore(): Promise<{ store: MemoryStore; cleanup: () => void }> {
	const dir = mkdtempSync(join(tmpdir(), "evolve-eval-runner-"));
	const store = await openMemoryStore(join(dir, "memory.db"));
	return { store, cleanup: () => store.close() };
}

function depsOf(store: MemoryStore, llm: LlmRuntime): EvalRunDeps {
	return {
		store,
		llm,
		route: { provider: "test", model: "steady" },
		sessionId: "eval-test",
		today: "2026-10-19T00:00:00.000Z",
		injectionFor: (arm) => (arm === "base" ? { system: "", preview: "" } : { system: "injected", preview: "injected" }),
	};
}

describe("runEvalBatch", () => {
	it("runs every arm once and lands case rows plus the state key", async () => {
		const { store, cleanup } = await testStore();
		try {
			const out = await runEvalBatch(depsOf(store, steadyLlm()), { workspaceId: REPO, subset: 2, repeat: 1 });
			expect(out.report.taskCount).toBe(2);
			for (const arm of EVAL_ARMS) {
				expect(out.report.arms[arm].tasks).toHaveLength(2);
			}
			expect(out.cases).toBe(2 * 4 * 1);
			expect(out.report.flakyIds).toEqual([]);
			expect(out.report.budgetNote).toMatch(/^实测/);
			const stamped = JSON.parse(store.state("", EVAL_LAST_FOUR_ARM_KEY) ?? "{}") as { date?: string };
			expect(stamped.date).toBe("2026-10-19T00:00:00.000Z");
			expect(out.markdown).toMatch(/# 四臂对照/);
		} finally {
			cleanup();
		}
	});
	it("flags flaky tasks when repeats disagree and honors the budget cap", async () => {
		const { store, cleanup } = await testStore();
		try {
			const out = await runEvalBatch(depsOf(store, alternatingLlm()), {
				workspaceId: REPO,
				subset: 1,
				repeat: 2,
				budgetCapTokens: 1,
			});
			expect(out.report.flakyIds.length).toBeGreaterThan(0);
			expect(out.report.budgetNote).toMatch(/budget_exceeded/);
			expect(out.cases).toBe(1 * 4 * 2);
		} finally {
			cleanup();
		}
	});
	it("counts recall QA separately from acc", async () => {
		const { store, cleanup } = await testStore();
		try {
			const expected = loadTaskset(taskDirOfSelf()).tasks.filter((task) => task.recall !== undefined).length;
			const out = await runEvalBatch(depsOf(store, steadyLlm()), { workspaceId: REPO, subset: 6, repeat: 1 });
			expect(out.report.arms.current.totals.recallTotal).toBeLessThanOrEqual(expected);
			expect(out.warnings).toEqual([]);
		} finally {
			cleanup();
		}
	});
});
