import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_LAST_FOUR_ARM_KEY } from "../src/data/eval-cases.js";
import { EVAL_ARMS } from "../src/data/records.js";
import { judgeOf, runEvalBatch, type EvalRunDeps } from "../src/services/eval-runner.js";
import { loadTaskset, taskDirOfSelf, type EvalTask } from "../src/services/eval-taskset.js";
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
	it("runs the full set with identity and a fitting cap", async () => {
		const { store, cleanup } = await testStore();
		try {
			const out = await runEvalBatch(depsOf(store, steadyLlm()), {
				workspaceId: REPO,
				repeat: 1,
				runId: "eval-manual",
				commit: "abc123",
				budgetCapTokens: 100000000,
			});
			expect(out.report.taskCount).toBe(22);
			expect(out.report.runId).toBe("eval-manual");
			expect(out.report.commit).toBe("abc123");
			expect(out.report.budgetNote).toMatch(/within cap/);
			expect(out.cases).toBe(22 * 4 * 1);
		} finally {
			cleanup();
		}
	});
	it("marks unaccounted usage without failing the task", async () => {
		const { store, cleanup } = await testStore();
		try {
			const bare: LlmRuntime = {
				stream: async function* () {
					yield { type: "text-delta", text: KITCHEN_SINK };
					yield { type: "finish", reason: { kind: "stop" } };
				},
			} as unknown as LlmRuntime;
			const out = await runEvalBatch(depsOf(store, bare), { workspaceId: REPO, subset: 1, repeat: 1 });
			expect(out.report.arms.base.tasks[0]?.note).toMatch(/unaccounted/);
		} finally {
			cleanup();
		}
	});
	it("records ledger-write failures as warnings, not throws", async () => {
		const { store, cleanup } = await testStore();
		try {
			const failing = {
				...store,
				writeEvalCases: () => { throw new Error("disk full"); },
				setState: () => { throw new Error("locked"); },
			} as unknown as MemoryStore;
			const out = await runEvalBatch(depsOf(failing, steadyLlm()), { workspaceId: REPO, subset: 1, repeat: 1 });
			expect(out.cases).toBe(0);
			expect(out.warnings.join("\n")).toMatch(/eval_cases write failed/);
			expect(out.warnings.join("\n")).toMatch(/last-four-arm write failed/);
		} finally {
			cleanup();
		}
	});
	it("notes recall checks the store cannot serve", async () => {
		const { store, cleanup } = await testStore();
		try {
			const blind = { ...store, search: () => { throw new Error("fts down"); } } as unknown as MemoryStore;
			const out = await runEvalBatch(depsOf(blind, steadyLlm()), { workspaceId: REPO, subset: 1, repeat: 1 });
			expect(out.warnings.join("\n")).toMatch(/recall check failed/);
		} finally {
			cleanup();
		}
	});
});

function judgeTask(): EvalTask {
	return {
		id: "task-judge",
		from: "session-test#seq-9",
		prompt: "这个回答好不好？",
		expect: [{ kind: "output-contains", any: ["CI 全绿"] }],
		tags: ["judge"],
	};
}

function judgeLlm(judgeTexts: string[]): LlmRuntime {
	const queue = [...judgeTexts];
	return {
		stream: async function* (options: unknown) {
			const messages = (options as { messages?: { content?: { text?: string }[] }[] }).messages ?? [];
			const prompt = messages.map((message) => (message.content ?? []).map((part) => part.text ?? "").join("")).join("\n");
			const text = prompt.includes("---") ? (queue.shift() ?? "") : "CI 全绿";
			yield { type: "text-delta", text };
			yield { type: "usage", usage: { inputTokens: 5, outputTokens: 5 } };
			yield { type: "finish", reason: { kind: "stop" } };
		},
	} as unknown as LlmRuntime;
}

describe("judgeOf", () => {
	it("passes through non-judge tasks", async () => {
		const { store, cleanup } = await testStore();
		try {
			const verdict = await judgeOf(
				depsOf(store, steadyLlm()),
				{ ...judgeTask(), tags: ["memory"] },
				"CI 全绿",
				[],
			);
			expect(verdict).toEqual({ pass: true, note: "" });
		} finally {
			cleanup();
		}
	});
	it("passes a task the judge confirms twice", async () => {
		const { store, cleanup } = await testStore();
		try {
			const verdict = await judgeOf(depsOf(store, judgeLlm(["PASS\n好", "PASS\n确实好"])), judgeTask(), "CI 全绿", []);
			expect(verdict).toEqual({ pass: true, note: "" });
		} finally {
			cleanup();
		}
	});
	it("fails disagreement and empty verdicts", async () => {
		const { store, cleanup } = await testStore();
		try {
			const warnings: string[] = [];
			expect((await judgeOf(depsOf(store, judgeLlm(["PASS", "FAIL"])), judgeTask(), "CI 全绿", warnings)).note).toMatch(
				/disagreed/,
			);
			expect((await judgeOf(depsOf(store, judgeLlm(["嗯", "嗯"])), judgeTask(), "CI 全绿", warnings)).note).toMatch(
				/no verdict/,
			);
		} finally {
			cleanup();
		}
	});
	it("fails a judge task with no LLM route", async () => {
		const { store, cleanup } = await testStore();
		try {
			const warnings: string[] = [];
			const verdict = await judgeOf({ ...depsOf(store, steadyLlm()), llm: undefined }, judgeTask(), "CI 全绿", warnings);
			expect(verdict.pass).toBe(false);
			expect(warnings.join("\n")).toMatch(/without an LLM route/);
		} finally {
			cleanup();
		}
	});
	it("clamps repeat past 2 to the same two rounds (no cost hole)", async () => {
		const { store, cleanup } = await testStore();
		try {
			const out = await runEvalBatch(depsOf(store, steadyLlm()), { workspaceId: REPO, subset: 1, repeat: 100 });
			expect(out.cases).toBe(1 * 4 * 2);
		} finally {
			cleanup();
		}
	});
	it("stamps a custom runId on case rows", async () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-eval-runid-"));
		const store = await openMemoryStore(join(dir, "memory.db"));
		try {
			const out = await runEvalBatch(depsOf(store, steadyLlm()), {
				workspaceId: REPO,
				subset: 1,
				repeat: 1,
				runId: "op-7",
			});
			expect(out.report.runId).toBe("op-7");
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(join(dir, "memory.db"));
			const rows = db.prepare("SELECT DISTINCT run_id AS runId FROM eval_cases").all() as { runId: string }[];
			db.close();
			expect(rows.map((row) => row.runId).sort()).toEqual(["op-7-r1"]);
		} finally {
			store.close();
		}
	});
});
