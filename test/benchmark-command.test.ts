/**
 * Tests for the `/evolve benchmark` subcommand handler (benchmark-command.ts):
 * store-driven subcommands (new/list/add-case/reset/status/casecheck/freeze/
 * meta) and the evaluation surface (run/pilot) with evaluateState mocked —
 * the command's wiring (label, cells, scoreboard writes, decisions,
 * auto-rollback) is what is under test, not the LLM.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createEvolutionEngine } from "../src/service.js";
import type { CellScore, EvaluationOutcome } from "../src/evaluate.js";
import { executeBenchmarkCommand } from "../src/benchmark-command.js";
import { addCase, createBenchmark, loadCaseMeta, loadScoreboard, saveCaseMeta, saveScoreboard } from "../src/benchmark.js";
import { deriveKey, DEV_RUBRIC_KEY } from "../src/rubric.js";

vi.mock("../src/evaluate.js", () => ({ evaluateState: vi.fn() }));

import { evaluateState } from "../src/evaluate.js";
const evaluateStateMock = vi.mocked(evaluateState);

function tmpBase(): string {
	const base = join(process.cwd(), "test/.tmp");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "/"));
}

function invocationOf(sessionId: string) {
	return { agent: { id: sessionId } as unknown as Agent, signal: undefined } as never;
}

const rubricKey = deriveKey(DEV_RUBRIC_KEY);
const runtime = { rubricKey, autoRollbackOnReject: true };

function cell(caseId: string, score: number, passed?: boolean): CellScore {
	return {
		caseId,
		run: 1,
		status: "ok",
		score,
		passed: passed ?? score >= 60,
		notes: "evidence",
		durationMs: 100,
		provider: "deepseek",
		model: "test",
		caseHash: "hash",
	};
}

function outcomeOf(label: string, cells: CellScore[]): EvaluationOutcome {
	return { label, cells, stopReason: "complete" };
}

/** Create a benchmark with one long-statement, fully-meta'd case. */
function seededBenchmark(base: string, title = "Benchmark One"): { bid: string; cid: string } {
	const def = createBenchmark(base, { title });
	const added = addCase(base, def.id, "Follow the repo conventions in every change", "This is a sufficiently long statement about repo conventions and hygiene practices for evaluation.", "Rubric text for scoring the conventions followed by the agent.");
	saveCaseMeta(base, def.id, added.id, {
		status: "draft",
		capability: "conventions",
		distinguisher: "follows conventions",
		shortcuts: "none",
	});
	return { bid: def.id, cid: added.id };
}

describe("usage and dispatch", () => {
	it("shows usage for the empty subcommand", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const result = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), [], runtime);
			expect(result.kind).toBe("success");
			expect(result.text).toContain("Usage:");
			expect(result.text).toContain("benchmark new <title>");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("rejects an unknown subcommand", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const result = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["frobnicate"], runtime);
			expect(result.kind).toBe("error");
			expect(result.text).toContain("unknown benchmark subcommand: frobnicate");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("new / list / add-case / reset", () => {
	it("new requires a title", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const result = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["new"], runtime);
			expect(result.kind).toBe("error");
			expect(result.text).toContain("benchmark new requires a title");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("new creates a benchmark with default runs", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const result = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["new", "First"], runtime);
			expect(result.kind).toBe("success");
			expect(result.text).toContain("benchmark first created (runs=1, passThreshold=60)");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("new accepts an explicit runs count and rejects malformed ones", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const ok = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["new", "Runs", "3"], runtime);
			expect(ok.kind).toBe("success");
			expect(ok.text).toContain("runs=3");
			await expect(executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["new", "Bad", "0"], runtime)).rejects.toThrow(/runs must be a positive integer/);
			await expect(executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["new", "Bad2", "abc"], runtime)).rejects.toThrow(/runs must be a positive integer/);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("list reports no benchmarks, then the seeded one with case count", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const empty = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["list"], runtime);
			expect(empty.text).toBe("(no benchmarks yet — use /evolve benchmark new <title>)");
			seededBenchmark(base);
			const listed = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["list"], runtime);
			expect(listed.kind).toBe("success");
			expect(listed.text).toContain("benchmark_one (1 cases, runs=1) no-reference");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("add-case validates arguments and benchmark existence", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const missing = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["add-case", "b", "t", "s"], runtime);
			expect(missing.kind).toBe("error");
			expect(missing.text).toContain("needs <bid> <title> <statement> <rubric>");
			const notFound = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["add-case", "ghost", "t", "statement", "rubric"], runtime);
			expect(notFound.kind).toBe("error");
			expect(notFound.text).toContain("benchmark ghost not found");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("add-case adds a draft case and tolerates angle brackets", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			createBenchmark(base, { title: "Target" });
			const result = await executeBenchmarkCommand(
				{} as never,
				engine,
				invocationOf("s1"),
				["add-case", "<target>", "Case one", "A statement that is long enough to pass quality checks later.", "A rubric text for scoring."],
				runtime,
			);
			expect(result.kind).toBe("success");
			expect(result.text).toContain("case case_one added to target (status: draft)");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("reset clears the scoreboard", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const { bid } = seededBenchmark(base);
			saveScoreboard(base, bid, {
				reference: { label: "ref", createdAt: "x", cells: [cell("c", 90)], aggregate: {}, overall: 90 },
				candidates: [],
				decisions: [],
			});
			const result = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["reset", bid], runtime);
			expect(result.kind).toBe("success");
			expect(result.text).toContain(`scoreboard reset for ${bid}`);
			expect(loadScoreboard(base, bid).reference).toBeUndefined();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("reset validates its arguments", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const missing = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["reset"], runtime);
			expect(missing.kind).toBe("error");
			expect(missing.text).toContain("benchmark reset needs a <bid>");
			const notFound = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["reset", "ghost"], runtime);
			expect(notFound.kind).toBe("error");
			expect(notFound.text).toContain("benchmark ghost not found");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("status", () => {
	it("shows the empty state, then reference and decisions", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const { bid } = seededBenchmark(base);
			const empty = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["status", bid], runtime);
			expect(empty.text).toContain("(no reference evaluation yet)");
			saveScoreboard(base, bid, {
				reference: { label: "reference", createdAt: "x", cells: [cell("c1", 90)], aggregate: {}, overall: 90 },
				candidates: [
					{ label: "candidate:evolve_x", refinementId: "evolve_x", createdAt: "x", cells: [cell("c1", 50)], aggregate: {}, overall: 50 },
				],
				decisions: [{ candidateLabel: "candidate:evolve_x", refinementId: "evolve_x", accepted: false, reasons: ["below pass threshold"], createdAt: "x" }],
			});
			const full = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["status", bid], runtime);
			expect(full.kind).toBe("success");
			expect(full.text).toContain("reference \"reference\": overall=90");
			expect(full.text).toContain("candidate \"candidate:evolve_x\": overall=50");
			expect(full.text).toContain("decision: rejected candidate:evolve_x — below pass threshold");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("annotates failed cells in status output", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const { bid } = seededBenchmark(base);
			saveScoreboard(base, bid, {
				reference: { label: "reference", createdAt: "x", cells: [cell("c1", 90), { ...cell("c2", 0), status: "failed", notes: "executor crash" }], aggregate: {}, overall: 90 },
				candidates: [],
				decisions: [],
			});
			const full = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["status", bid], runtime);
			expect(full.text).toContain("cells=2 (1 failed)");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("run", () => {
	it("validates the benchmark and requires cases", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const notFound = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["run", "ghost"], runtime);
			expect(notFound.kind).toBe("error");
			expect(notFound.text).toContain("benchmark ghost not found");
			createBenchmark(base, { title: "Empty" });
			const noCases = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["run", "empty"], runtime);
			expect(noCases.kind).toBe("error");
			expect(noCases.text).toContain("has no cases");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("records a reference run and refuses a second reference", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const { bid, cid } = seededBenchmark(base);
			evaluateStateMock.mockResolvedValue(outcomeOf("reference", [cell(cid, 90)]));
			const first = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["run", bid], runtime);
			expect(first.kind).toBe("success");
			expect(first.text).toContain("evaluation \"reference\": 1 cells, overall=90");
			expect(first.text).toContain("reference evaluation recorded as the baseline");
			expect(loadScoreboard(base, bid).reference?.overall).toBe(90);
			expect(evaluateStateMock).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ id: "s1" }),
				expect.objectContaining({ label: "reference", runs: 1, passThreshold: 60 }),
			);
			const second = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["run", bid], runtime);
			expect(second.kind).toBe("error");
			expect(second.text).toContain("reference already evaluated");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("records a candidate without a reference (no decision)", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const { bid, cid } = seededBenchmark(base);
			evaluateStateMock.mockResolvedValue(outcomeOf("candidate:evolve_x", [cell(cid, 90)]));
			const result = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["run", bid, "candidate", "evolve_x"], runtime);
			expect(result.kind).toBe("success");
			expect(result.text).toContain("(no reference yet — this run only recorded the candidate)");
			const board = loadScoreboard(base, bid);
			expect(board.candidates).toHaveLength(1);
			expect(board.candidates[0]?.refinementId).toBe("evolve_x");
			expect(board.decisions).toHaveLength(0);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("accepts a candidate that clears the reference and records the decision", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const { bid, cid } = seededBenchmark(base);
			saveScoreboard(base, bid, {
				reference: { label: "reference", createdAt: "x", cells: [cell(cid, 80)], aggregate: {}, overall: 80 },
				candidates: [],
				decisions: [],
			});
			evaluateStateMock.mockResolvedValue(outcomeOf("candidate:evolve_x", [cell(cid, 90)]));
			const result = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["run", bid, "candidate", "evolve_x"], runtime);
			expect(result.kind).toBe("success");
			expect(result.text).toContain("ACCEPTED");
			const board = loadScoreboard(base, bid);
			expect(board.decisions).toHaveLength(1);
			expect(board.decisions[0]?.accepted).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("rejects a regression and auto-rolls back the refinement", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const { bid, cid } = seededBenchmark(base);
			saveScoreboard(base, bid, {
				reference: { label: "reference", createdAt: "x", cells: [cell(cid, 90)], aggregate: {}, overall: 90 },
				candidates: [],
				decisions: [],
			});
			// A real local refinement to roll back.
			const created = engine.apply("local", "s1", {
				summary: "candidate refinement",
				rationale: "test",
				expectedOutcome: "entry exists",
				edits: [{ action: "create", kind: "memory", id: "candidate_mem", title: "Candidate memory", content: "durable lesson" }],
			});
			evaluateStateMock.mockResolvedValue(outcomeOf(`candidate:${created.id}`, [cell(cid, 50)]));
			const result = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["run", bid, "candidate", created.id], runtime);
			expect(result.kind).toBe("success");
			expect(result.text).toContain("REJECTED");
			expect(result.text).toContain(`auto-rollback: reverted refinement ${created.id}`);
			// The rolled-back entry is gone from the local store.
			expect(engine.load("local", "s1").entries.memory["candidate_mem"]).toBeUndefined();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("skips auto-rollback when disabled", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const { bid, cid } = seededBenchmark(base);
			saveScoreboard(base, bid, {
				reference: { label: "reference", createdAt: "x", cells: [cell(cid, 90)], aggregate: {}, overall: 90 },
				candidates: [],
				decisions: [],
			});
			const created = engine.apply("local", "s1", {
				summary: "candidate refinement",
				rationale: "test",
				expectedOutcome: "entry exists",
				edits: [{ action: "create", kind: "memory", id: "keep_mem", title: "Keep", content: "lesson" }],
			});
			evaluateStateMock.mockResolvedValue(outcomeOf(`candidate:${created.id}`, [cell(cid, 50)]));
			const result = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["run", bid, "candidate", created.id], { ...runtime, autoRollbackOnReject: false });
			expect(result.kind).toBe("success");
			expect(result.text).not.toContain("auto-rollback");
			expect(engine.load("local", "s1").entries.memory["keep_mem"]).toBeDefined();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("re-marks drifted candidate cells as failed via the material-drift check", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const { bid, cid } = seededBenchmark(base);
			saveScoreboard(base, bid, {
				reference: { label: "reference", createdAt: "x", cells: [cell(cid, 90)], aggregate: {}, overall: 90 },
				candidates: [],
				decisions: [],
			});
			evaluateStateMock.mockResolvedValue(outcomeOf(`candidate:evolve_x`, [{ ...cell(cid, 95), caseHash: "different-hash" }]));
			const result = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["run", bid, "candidate", "evolve_x"], runtime);
			expect(result.kind).toBe("success");
			expect(result.text).toContain("1 cells, 1 failed");
			expect(result.text).toContain("materials changed");
			expect(loadScoreboard(base, bid).decisions[0]?.accepted).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("casecheck / pilot / freeze / meta", () => {
	it("casecheck flags a short statement and missing meta", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const def = createBenchmark(base, { title: "Gate" });
			addCase(base, def.id, "Short", "tiny", "rubric");
			const result = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["casecheck", def.id], runtime);
			expect(result.kind).toBe("success");
			expect(result.text).toContain("✗ 4 problems found");
			expect(result.text).toContain("statement too short");
			expect(result.text).toContain("capability contract is empty");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("casecheck passes a fully-prepared case", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const { bid } = seededBenchmark(base);
			const result = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["casecheck", bid], runtime);
			expect(result.kind).toBe("success");
			expect(result.text).toContain("✓ all cases pass quality gate");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("casecheck validates its arguments", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const missing = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["casecheck"], runtime);
			expect(missing.kind).toBe("error");
			expect(missing.text).toContain("benchmark casecheck needs a <bid>");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("pilot runs a single cell, transitions to calibrating, and records history", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const { bid, cid } = seededBenchmark(base);
			evaluateStateMock.mockResolvedValue(outcomeOf(`pilot:${cid}`, [cell(cid, 75)]));
			const result = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["pilot", bid, cid], runtime);
			expect(result.kind).toBe("success");
			expect(result.text).toContain(`pilot ${cid}: 75 (passed)`);
			expect(result.text).toContain("status: calibrating");
			const meta = loadCaseMeta(base, bid, cid);
			expect(meta?.status).toBe("calibrating");
			expect(meta?.calibrationHistory).toHaveLength(1);
			expect(meta?.calibrationHistory[0]?.score).toBe(75);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("pilot refuses a frozen case", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const { bid, cid } = seededBenchmark(base);
			saveCaseMeta(base, bid, cid, { status: "frozen", capability: "c", distinguisher: "d", shortcuts: "s" });
			const result = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["pilot", bid, cid], runtime);
			expect(result.kind).toBe("error");
			expect(result.text).toContain("is frozen and cannot be calibrated");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("pilot validates its arguments", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const missing = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["pilot"], runtime);
			expect(missing.kind).toBe("error");
			expect(missing.text).toContain("benchmark pilot needs <bid> <cid>");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("freeze requires a clean quality gate", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const def = createBenchmark(base, { title: "FreezeGate" });
			const added = addCase(base, def.id, "Bad case", "too short", "rubric");
			const result = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["freeze", def.id, added.id], runtime);
			expect(result.kind).toBe("error");
			expect(result.text).toContain("has 4 quality problems");
			expect(loadCaseMeta(base, def.id, added.id)?.status).not.toBe("frozen");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("freeze transitions a clean calibrated case to frozen and refuses refreezing", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const { bid, cid } = seededBenchmark(base);
			// The A5 state machine only allows calibrating → frozen, so a
			// pilot run must happen first.
			evaluateStateMock.mockResolvedValue(outcomeOf(`pilot:${cid}`, [cell(cid, 75)]));
			const pilot = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["pilot", bid, cid], runtime);
			expect(pilot.kind).toBe("success");
			const first = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["freeze", bid, cid], runtime);
			expect(first.kind).toBe("success");
			expect(first.text).toContain("frozen as formal baseline (immutable)");
			expect(loadCaseMeta(base, bid, cid)?.status).toBe("frozen");
			const second = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["freeze", bid, cid], runtime);
			expect(second.kind).toBe("error");
			expect(second.text).toContain("is already frozen");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("meta updates fields but refuses unknown fields and frozen cases", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const { bid, cid } = seededBenchmark(base);
			const ok = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["meta", bid, cid, "capability", "conventions and tools"], runtime);
			expect(ok.kind).toBe("success");
			expect(ok.text).toContain("capability updated");
			expect(loadCaseMeta(base, bid, cid)?.capability).toBe("conventions and tools");
			const bad = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["meta", bid, cid, "nonsense", "value"], runtime);
			expect(bad.kind).toBe("error");
			expect(bad.text).toContain("unknown meta field");
			saveCaseMeta(base, bid, cid, { status: "frozen", capability: "c", distinguisher: "d", shortcuts: "s" });
			const frozen = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["meta", bid, cid, "capability", "x"], runtime);
			expect(frozen.kind).toBe("error");
			expect(frozen.text).toContain("is frozen and cannot be modified");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("meta validates its arguments", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const missing = await executeBenchmarkCommand({} as never, engine, invocationOf("s1"), ["meta", "b", "c"], runtime);
			expect(missing.kind).toBe("error");
			expect(missing.text).toContain("benchmark meta needs <bid> <cid> <field> <value>");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});