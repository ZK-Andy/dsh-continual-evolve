/**
 * Tests for the benchmark store: create, list, add-case, scoreboard
 * persistence, and id sanitization.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { decryptRubric, deriveKey, DEV_RUBRIC_KEY } from "../src/rubric.js";
import { createEvolutionEngine } from "../src/service.js";
import {
	addCase,
	createBenchmark,
	listBenchmarks,
	listCases,
	loadBenchmark,
	loadScoreboard,
	rollbackRejectedCandidate,
	saveScoreboard,
	sanitizeId,
} from "../src/benchmark.js";

function tmpBase(): string {
	const base = join(process.cwd(), "test/.tmp");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "/"));
}

describe("sanitizeId", () => {
	it("slugs titles and rejects empties", () => {
		expect(sanitizeId("  My Benchmark Title! ")).toBe("my_benchmark_title");
		expect(() => sanitizeId("  ")).toThrow();
	});
});

describe("benchmark store", () => {
	it("creates, lists, and reloads a benchmark", () => {
		const base = tmpBase();
		try {
			const def = createBenchmark(base, { title: "Coding Conventions", runs: 2 });
			expect(def.id).toBe("coding_conventions");
			expect(def.runs).toBe(2);
			expect(loadBenchmark(base, def.id)?.title).toBe("Coding Conventions");
			expect(listBenchmarks(base)).toHaveLength(1);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("rejects duplicate ids", () => {
		const base = tmpBase();
		try {
			createBenchmark(base, { title: "Dup" });
			expect(() => createBenchmark(base, { title: "dup!" })).toThrow(/already exists/);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("adds and lists cases with statement and rubric files", () => {
		const base = tmpBase();
		try {
			const def = createBenchmark(base, { title: "Tasks" });
			const added = addCase(base, def.id, "Fix the bug", "statement text", "rubric text");
			expect(added.rubric).toBe("rubric text"); // in-memory view stays plaintext
			const cases = listCases(base, def.id);
			expect(cases).toHaveLength(1);
			expect(cases[0]?.statement).toBe("statement text");
			// ACL: the stored/listed rubric is ciphertext — plaintext never on disk.
			expect(cases[0]?.rubric).not.toBe("rubric text");
			expect(cases[0]?.rubric.startsWith("v1:")).toBe(true);
			expect(decryptRubric(cases[0]?.rubric ?? "", deriveKey(DEV_RUBRIC_KEY))).toBe("rubric text");
			const disk = readFileSync(join(base, "evolve/benchmarks", def.id, "cases", "fix_the_bug", "rubric.json"), "utf8");
			expect(disk).not.toContain("rubric text");
			expect(existsSync(join(base, "evolve/benchmarks", def.id, "cases", "fix_the_bug", "statement.md"))).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("roundtrips scoreboards", () => {
		const base = tmpBase();
		try {
			const def = createBenchmark(base, { title: "Scores" });
			const board = loadScoreboard(base, def.id);
			board.decisions.push({
				candidateLabel: "candidate:r1",
				refinementId: "r1",
				accepted: false,
				reasons: ["regressed"],
				createdAt: "2026-01-01T00:00:00.000Z",
			});
			saveScoreboard(base, def.id, board);
			const reloaded = loadScoreboard(base, def.id);
			expect(reloaded.decisions).toHaveLength(1);
			expect(reloaded.decisions[0]?.accepted).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("rollbackRejectedCandidate", () => {
	it("reverts a rejected refinement through the engine rollback path", () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const result = engine.apply("local", "session-x", {
				summary: "candidate",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "create", kind: "memory", title: "Doomed entry", content: "value" }],
			});
			expect(engine.load("local", "session-x").entries.memory["doomed_entry"]).toBeDefined();
			const outcome = rollbackRejectedCandidate(engine, "session-x", result.id);
			expect(outcome.rolledBack).toBe(true);
			expect(outcome.message).toContain("auto-rollback");
			expect(outcome.message).toContain(result.id);
			expect(engine.load("local", "session-x").entries.memory["doomed_entry"]).toBeUndefined();
			// the rollback itself is audited as a new refinement
			expect(engine.history("local", "session-x")).toHaveLength(2);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("reports instead of throwing when the refinement is not in this session's history", () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const outcome = rollbackRejectedCandidate(engine, "session-x", "evolve_ghost");
			expect(outcome.rolledBack).toBe(false);
			expect(outcome.message).toMatch(/auto-rollback failed/);
			expect(outcome.message).toMatch(/not found/);
			expect(outcome.message).toMatch(/\/evolve rollback/);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("scopes the rollback to the session the candidate refinement belongs to", () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const result = engine.apply("local", "session-a", {
				summary: "candidate",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "create", kind: "memory", title: "Only in A", content: "value" }],
			});
			// same refinement id, different session: not found there
			const wrongSession = rollbackRejectedCandidate(engine, "session-b", result.id);
			expect(wrongSession.rolledBack).toBe(false);
			// and it still exists in session-a
			expect(engine.load("local", "session-a").entries.memory["only_in_a"]).toBeDefined();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
