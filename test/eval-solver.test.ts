import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkExpects, solveSingleRound, type EvalTask } from "../src/services/eval-solver.js";
import type { LlmRuntime } from "../src/services/llm-call.js";

function task(overrides: Partial<EvalTask> = {}): EvalTask {
	return {
		id: "task-x",
		from: "session-test#seq-1",
		prompt: "什么时候可以 publish？",
		expect: [{ kind: "output-contains", any: ["CI 全绿"] }],
		tags: ["memory"],
		...overrides,
	};
}

function fakeLlm(text: string, usage: unknown = { inputTokens: 10, outputTokens: 5 }): LlmRuntime {
	return {
		stream: async function* () {
			yield { type: "text-delta", text };
			yield { type: "usage", usage };
			yield { type: "finish", reason: { kind: "stop" } };
		},
	} as unknown as LlmRuntime;
}

function throwingLlm(): LlmRuntime {
	return {
		stream: async function* () {
			throw new Error("boom");
			yield { type: "text-delta", text: "" };
		},
	} as unknown as LlmRuntime;
}

describe("solveSingleRound", () => {
	it("returns the reply with accounted usage", async () => {
		const solved = await solveSingleRound(task(), "system", {
			llm: fakeLlm("先看 CI 状态，CI 全绿再发"),
			route: { provider: "p", model: "m" },
			today: "2026-10-19",
			sessionId: "s1",
		});
		expect(solved.error).toBeUndefined();
		expect(solved.reply).toContain("CI 全绿");
		expect(solved.usage.total).toBe(15);
		expect(solved.accounted).toBe(true);
	});
	it("marks unaccounted usage without failing", async () => {
		const solved = await solveSingleRound(task(), "", {
			llm: fakeLlm("CI 全绿", { weird: true }),
			route: { provider: "p", model: "m" },
			today: "2026-10-19",
		});
		expect(solved.accounted).toBe(false);
		expect(solved.usage.total).toBe(0);
	});
	it("carries the failure head instead of throwing", async () => {
		const solved = await solveSingleRound(task(), "", {
			llm: throwingLlm(),
			route: { provider: "p", model: "m" },
			today: "2026-10-19",
		});
		expect(solved.reply).toBe("");
		expect(solved.error).toMatch(/boom/);
	});
});

describe("checkExpects", () => {
	it("matches any-of for output-contains", () => {
		expect(checkExpects(task(), "CI 全绿才行", "/tmp")[0]?.pass).toBe(true);
		expect(checkExpects(task(), "今天天气不错", "/tmp")[0]?.pass).toBe(false);
	});
	it("checks file existence against the workspace", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-solver-"));
		writeFileSync(join(dir, "present.md"), "x");
		const present = task({ expect: [{ kind: "file-exists", path: "present.md" }] });
		const absent = task({ expect: [{ kind: "file-exists", path: "missing.md" }] });
		expect(checkExpects(present, "", dir)[0]?.pass).toBe(true);
		expect(checkExpects(absent, "", dir)[0]?.pass).toBe(false);
		expect(checkExpects(task({ expect: [{ kind: "file-exists" }] }), "", dir)[0]?.pass).toBe(false);
	});
	it("runs test-pass commands with a timeout", () => {
		const ok = task({ expect: [{ kind: "test-pass", cmd: "node -e \"process.exit(0)\"" }] });
		const bad = task({ expect: [{ kind: "test-pass", cmd: "node -e \"process.exit(3)\"" }] });
		expect(checkExpects(ok, "", tmpdir())[0]?.pass).toBe(true);
		expect(checkExpects(bad, "", tmpdir())[0]?.pass).toBe(false);
		expect(checkExpects(task({ expect: [{ kind: "test-pass" }] }), "", tmpdir())[0]?.pass).toBe(false);
	});
	it("reports unspawnable commands instead of throwing", () => {
		const missing = task({ expect: [{ kind: "test-pass", cmd: "node -e \"process.exit(0)\"" }] });
		expect(checkExpects(missing, "", join(tmpdir(), "no-such-dir-eval-solver"))[0]?.pass).toBe(false);
	});
});
