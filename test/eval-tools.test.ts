import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LlmRuntime } from "../src/services/llm-call.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";
import { executeEvalRun, registerEvalTools, type EvalToolFixed } from "../src/surfaces/eval-tools.js";
import type { ToolExec, ToolsService } from "../src/surfaces/evolve-tools.js";

function steadyLlm(): LlmRuntime {
	return {
		stream: async function* () {
			yield { type: "text-delta", text: "CI 全绿" };
			yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
			yield { type: "finish", reason: { kind: "stop" } };
		},
	} as unknown as LlmRuntime;
}

async function testStore(): Promise<{ store: MemoryStore; dir: string; cleanup: () => void }> {
	const dir = mkdtempSync(join(tmpdir(), "evolve-eval-tools-"));
	const store = await openMemoryStore(join(dir, "memory.db"));
	return { store, dir, cleanup: () => store.close() };
}

function execWith(cwd?: string): ToolExec {
	return cwd === undefined ? {} : { agent: { id: "s1", session: { header: { cwd } } } };
}

function fixedWith(llm: LlmRuntime | undefined, route: boolean): EvalToolFixed {
	return {
		llm,
		resolveRoute: () => (route ? { provider: "test", model: "steady" } : undefined),
		injectionFor: () => ({ system: "", preview: "" }),
	};
}

describe("registerEvalTools", () => {
	it("registers evolve_eval_run with a disposer", async () => {
		const { store, cleanup } = await testStore();
		try {
			const seen: unknown[] = [];
			const tools = { register: (def: unknown) => { seen.push(def); return () => undefined; } } as ToolsService;
			const dispose = registerEvalTools(tools, store, fixedWith(steadyLlm(), true));
			expect(seen).toHaveLength(1);
			expect((seen[0] as { name?: string }).name).toBe("evolve_eval_run");
			dispose();
		} finally {
			cleanup();
		}
	});
});

describe("executeEvalRun", () => {
	it("refuses without a workspace at the tool boundary", async () => {
		const { store, cleanup } = await testStore();
		try {
			let captured: { execute: (args: Record<string, unknown>, exec: ToolExec) => Promise<{ text: string }> } | undefined;
			const tools = {
				register: (def: unknown) => {
					captured = def as typeof captured;
					return () => undefined;
				},
			} as ToolsService;
			registerEvalTools(tools, store, fixedWith(steadyLlm(), true));
			const out = await captured?.execute({}, execWith(undefined));
			expect(out?.text).toMatch(/工作区/);
		} finally {
			cleanup();
		}
	});
	it("dry-runs the task set with no model calls", async () => {
		const { store, dir, cleanup } = await testStore();
		try {
			const text = await executeEvalRun(store, fixedWith(undefined, false), dir, execWith(dir), { dryRun: true });
			expect(text).toMatch(/^dry-run: \d+ 条任务可用/);
		} finally {
			cleanup();
		}
	});
	it("fails loud without a model route", async () => {
		const { store, dir, cleanup } = await testStore();
		try {
			const text = await executeEvalRun(store, fixedWith(steadyLlm(), false), dir, execWith(dir), { subset: 1, repeat: 1 });
			expect(text).toMatch(/模型路由/);
		} finally {
			cleanup();
		}
	});
	it("returns compare markdown with a filing note", async () => {
		const { store, dir, cleanup } = await testStore();
		try {
			const text = await executeEvalRun(store, fixedWith(steadyLlm(), true), dir, execWith(dir), { subset: 1, repeat: 1 });
			expect(text).toMatch(/# 四臂对照/);
			expect(text).toMatch(/caseRows: 4/);
			expect(text).toMatch(/compare\.md/);
		} finally {
			cleanup();
		}
	});
	it("accepts a fitting cap and ignores invalid knobs", async () => {
		const { store, dir, cleanup } = await testStore();
		try {
			const text = await executeEvalRun(store, fixedWith(steadyLlm(), true), dir, execWith(dir), {
				subset: 1,
				repeat: 1,
				budgetCapTokens: 100000000,
			});
			expect(text).toMatch(/within cap/);
			const sloppy = await executeEvalRun(store, fixedWith(steadyLlm(), true), dir, execWith(dir), {
				subset: "many",
				repeat: -2,
				budgetCapTokens: Number.NaN,
				dryRun: "yes",
			});
			expect(sloppy).toMatch(/# 四臂对照/);
		} finally {
			cleanup();
		}
	});
});
