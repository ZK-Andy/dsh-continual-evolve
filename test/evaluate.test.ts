/**
 * Tests for evaluation cell normalization and the two-stage evaluation
 * runner: the executor child produces evidence WITHOUT ever seeing the
 * rubric, a separate reviewer child grades that evidence against the rubric,
 * failed units become status:"failed" cells (never zeros), and each cell
 * carries the executor session id as a trace evidence pointer.
 */
import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { evaluateState, normalizeCell, normalizeExecutor, caseHash } from "../src/evaluate.js";
import type { BenchmarkCase, CellScore } from "../src/benchmark.js";
import { deriveKey, encryptRubric } from "../src/rubric.js";

const RUBRIC = encryptRubric("criteria text: evidence must be concrete", deriveKey("test-key"));

function caseWith(id: string): BenchmarkCase {
	return { id, title: id, statement: `task ${id}`, rubric: RUBRIC };
}

describe("normalizeCell", () => {
	it("accepts a well-formed structured cell", () => {
		const cell = normalizeCell({ caseId: "c1", run: 2, score: 87.5, passed: true, notes: "evidence" }, "c1", 2, 60);
		expect(cell).toEqual({ caseId: "c1", run: 2, status: "ok", score: 87.5, passed: true, notes: "evidence" });
	});

	it("clamps out-of-range scores", () => {
		expect(normalizeCell({ caseId: "c", run: 1, score: 150, passed: true, notes: "" }, "c", 1, 60)?.score).toBe(100);
		expect(normalizeCell({ caseId: "c", run: 1, score: -5, passed: true, notes: "" }, "c", 1, 60)?.score).toBe(0);
	});

	it("derives passed from the threshold when the flag is missing", () => {
		expect(normalizeCell({ caseId: "c", run: 1, score: 70, notes: "" }, "c", 1, 60)?.passed).toBe(true);
		expect(normalizeCell({ caseId: "c", run: 1, score: 50, notes: "" }, "c", 1, 60)?.passed).toBe(false);
	});

	it("rejects non-numeric scores and non-object values", () => {
		expect(normalizeCell({ caseId: "c", run: 1, score: "high", notes: "" }, "c", 1, 60)).toBeUndefined();
		expect(normalizeCell("not an object", "c", 1, 60)).toBeUndefined();
		expect(normalizeCell([1, 2], "c", 1, 60)).toBeUndefined();
	});
});

describe("normalizeExecutor", () => {
	it("accepts a well-formed executor result with concrete evidence", () => {
		const result = normalizeExecutor({ caseId: "c1", run: 1, evidence: "found the memory via evolve_list" }, "c1", 1);
		expect(result).toEqual({ caseId: "c1", run: 1, evidence: "found the memory via evolve_list" });
	});

	it("rejects an executor result without evidence", () => {
		expect(normalizeExecutor({ caseId: "c1", run: 1 }, "c1", 1)).toBeUndefined();
		expect(normalizeExecutor({ caseId: "c1", run: 1, evidence: "  " }, "c1", 1)).toBeUndefined();
		expect(normalizeExecutor("not an object", "c1", 1)).toBeUndefined();
	});
});

interface SpawnCall {
	isExecutor: boolean;
	promptText: string;
}

/** Fake subagents whose start() lets the test inject executor/reviewer outcomes per call. */
function spawner(opts: {
	executor?: { structured?: unknown; text?: string; stopReason?: string; id?: string; throwOnStart?: boolean };
	reviewer?: { structured?: unknown; text?: string; stopReason?: string; throwOnStart?: boolean };
}): { ctx: Context; calls: SpawnCall[] } {
	const calls: SpawnCall[] = [];
	const ctx = {
		subagents: {
			start: async (_name: string, request: { prompt: { type: string; text: string }[] }) => {
				const promptText = request.prompt[0]?.text ?? "";
				const isExecutor = promptText.includes("You are the agent under evaluation");
				calls.push({ isExecutor, promptText });
				const opt = opts[isExecutor ? "executor" : "reviewer"] ?? opts.executor;
				if (opt?.throwOnStart) {
					throw new Error("start failed");
				}
				return {
					id: opt?.id ?? (isExecutor ? "session-executor" : "session-reviewer"),
					result: Promise.resolve({
						...(opt?.structured !== undefined ? { structured: opt.structured } : {}),
						...(opt?.text !== undefined ? { output: [{ type: "text", text: opt.text }] } : {}),
						stopReason: opt?.stopReason ?? "completed",
					}),
					dispose: () => {},
				};
			},
		},
	} as unknown as Context;
	return { ctx, calls };
}

const agent = { id: "session-bench", options: { provider: "p", model: "m" } } as never;

const baseOptions = {
	cases: [caseWith("c1")],
	runs: 1,
	passThreshold: 60,
	harnessOverview: "memory:lint = Lint first",
	label: "reference",
	rubricKey: deriveKey("test-key"),
};

describe("evaluateState two-stage separation", () => {
	it("runs executor (no rubric in its prompt) then reviewer, and records the executor session id", async () => {
		const { ctx, calls } = spawner({
			executor: { structured: { caseId: "c1", run: 1, evidence: "found the memory via evolve_list" }, id: "session-exec-exact" },
			reviewer: { structured: { caseId: "c1", run: 1, score: 92, passed: true, notes: "concrete evidence" } },
		});
		const outcome = await evaluateState(ctx, agent, baseOptions);
		expect(outcome.cells).toHaveLength(1);
		const cell = outcome.cells[0] as CellScore;
		expect(cell.status).toBe("ok");
		expect(cell.score).toBe(92);
		expect(cell.sessionId).toBe("session-exec-exact");

		expect(calls).toHaveLength(2);
		const [exec, grade] = calls;
		expect(exec?.isExecutor).toBe(true);
		expect(grade?.isExecutor).toBe(false);
		// Rubric isolation: the executor prompt must NEVER contain rubric text.
		expect(exec?.promptText).not.toContain("criteria text");
		expect(exec?.promptText).toContain("task c1");
		expect(grade?.promptText).toContain("criteria text");
		expect(grade?.promptText).toContain("found the memory via evolve_list");
	});

	it("marks the cell failed when the executor crashes (never a zero)", async () => {
		const { ctx } = spawner({ executor: { throwOnStart: true } });
		const outcome = await evaluateState(ctx, agent, baseOptions);
		expect(outcome.cells[0]?.status).toBe("failed");
		expect(outcome.cells[0]?.notes).toMatch(/executor failed/);
	});

	it("marks the cell failed when the reviewer crashes (evidence was gathered, grading failed)", async () => {
		const { ctx } = spawner({
			executor: { structured: { caseId: "c1", run: 1, evidence: "evidence" } },
			reviewer: { throwOnStart: true },
		});
		const outcome = await evaluateState(ctx, agent, baseOptions);
		expect(outcome.cells[0]?.status).toBe("failed");
		expect(outcome.cells[0]?.notes).toMatch(/reviewer failed/);
	});

	it("falls back to the executor's raw text when it returns no structured evidence", async () => {
		const { ctx, calls } = spawner({
			executor: { text: "I ran evolve_list and found memory:lint — evidence" },
			reviewer: { structured: { caseId: "c1", run: 1, score: 80, passed: true, notes: "ok" } },
		});
		const outcome = await evaluateState(ctx, agent, baseOptions);
		expect(outcome.cells[0]?.status).toBe("ok");
		expect(outcome.cells[0]?.score).toBe(80);
		const execPrompt = calls[0]?.promptText ?? "";
		expect(execPrompt).not.toContain("criteria text");
	});
});

describe("evaluateState runtime evidence (A3)", () => {
	it("records provider, model, and caseHash on ok cells", async () => {
		const { ctx } = spawner({
			executor: { structured: { caseId: "c1", run: 1, evidence: "evidence" } },
			reviewer: { structured: { caseId: "c1", run: 1, score: 90, passed: true, notes: "good" } },
		});
		const outcome = await evaluateState(ctx, agent, baseOptions);
		const cell = outcome.cells[0] as CellScore;
		expect(cell.provider).toBe("p");
		expect(cell.model).toBe("m");
		expect(cell.caseHash).toMatch(/^[a-f0-9]{16}$/);
	});

	it("records provider, model, and caseHash on failed cells", async () => {
		const { ctx } = spawner({ executor: { throwOnStart: true } });
		const outcome = await evaluateState(ctx, agent, baseOptions);
		const cell = outcome.cells[0] as CellScore;
		expect(cell.provider).toBe("p");
		expect(cell.model).toBe("m");
		expect(cell.caseHash).toMatch(/^[a-f0-9]{16}$/);
	});

	it("produces different caseHash for different case material", () => {
		expect(caseHash(caseWith("a"))).not.toBe(caseHash(caseWith("b")));
	});

	it("is stable for identical case material", () => {
		const c = caseWith("c1");
		expect(caseHash(c)).toBe(caseHash(c));
		// statement changes must change the hash even when id/title differ
		expect(caseHash({ ...caseWith("x"), statement: "task x" })).not.toBe(caseHash({ ...caseWith("x"), statement: "task y" }));
	});
});