/**
 * Tests for the benchmark store: create, list, add-case, scoreboard
 * persistence, id sanitization, and A5 case lifecycle + quality gate.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decryptRubric, deriveKey, DEV_RUBRIC_KEY } from "../src/rubric.js";
import { createEvolutionEngine } from "../src/service.js";
import {
	addCase,
	caseCheckProblems,
	createBenchmark,
	listBenchmarks,
	listCases,
	loadBenchmark,
	loadCaseMeta,
	loadScoreboard,
	rollbackRejectedCandidate,
	saveCaseMeta,
	saveScoreboard,
	sanitizeId,
	transitionCaseStatus,
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

// ── A5: case lifecycle + quality gate ──────────────────────────────────

describe("case meta (A5)", () => {
	it("initializes meta on addCase", () => {
		const base = tmpBase();
		try {
			const def = createBenchmark(base, { title: "Meta Test" });
			addCase(base, def.id, "Test Case", "A valid statement for testing", "rubric");
			const meta = loadCaseMeta(base, def.id, "test_case");
			expect(meta).toBeDefined();
			expect(meta?.status).toBe("draft");
			expect(meta?.capability).toBe("");
			expect(meta?.distinguisher).toBe("");
			expect(meta?.shortcuts).toBe("");
			expect(meta?.calibrationHistory).toHaveLength(0);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("listCases includes status from meta", () => {
		const base = tmpBase();
		try {
			const def = createBenchmark(base, { title: "Status Test" });
			addCase(base, def.id, "Case A", "Statement for case A", "rubric");
			const cases = listCases(base, def.id);
			expect(cases[0]?.status).toBe("draft");
			// Transition to calibrating
			transitionCaseStatus(base, def.id, "case_a", "calibrating");
			const reloaded = listCases(base, def.id);
			expect(reloaded[0]?.status).toBe("calibrating");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("roundtrips case meta", () => {
		const base = tmpBase();
		try {
			const def = createBenchmark(base, { title: "Roundtrip" });
			addCase(base, def.id, "Case", "A valid statement for testing", "rubric");
			const meta = loadCaseMeta(base, def.id, "case")!;
			meta.capability = "tests X";
			meta.distinguisher = "pass vs fail";
			meta.shortcuts = "none known";
			saveCaseMeta(base, def.id, "case", meta);
			const reloaded = loadCaseMeta(base, def.id, "case");
			expect(reloaded?.capability).toBe("tests X");
			expect(reloaded?.distinguisher).toBe("pass vs fail");
			expect(reloaded?.shortcuts).toBe("none known");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("case lifecycle transitions (A5)", () => {
	it("draft → calibrating → frozen", () => {
		const base = tmpBase();
		try {
			const def = createBenchmark(base, { title: "Lifecycle" });
			addCase(base, def.id, "Case", "A valid statement for testing", "rubric");
			const meta1 = transitionCaseStatus(base, def.id, "case", "calibrating");
			expect(meta1.status).toBe("calibrating");
			const meta2 = transitionCaseStatus(base, def.id, "case", "frozen");
			expect(meta2.status).toBe("frozen");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("calibrating → draft (abandon)", () => {
		const base = tmpBase();
		try {
			const def = createBenchmark(base, { title: "Abandon" });
			addCase(base, def.id, "Case", "A valid statement for testing", "rubric");
			transitionCaseStatus(base, def.id, "case", "calibrating");
			const meta = transitionCaseStatus(base, def.id, "case", "draft");
			expect(meta.status).toBe("draft");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("rejects illegal transitions", () => {
		const base = tmpBase();
		try {
			const def = createBenchmark(base, { title: "Illegal" });
			addCase(base, def.id, "Case", "A valid statement for testing", "rubric");
			// draft → frozen (skipping calibrating)
			expect(() => transitionCaseStatus(base, def.id, "case", "frozen")).toThrow(/illegal/);
			// frozen → anything
			transitionCaseStatus(base, def.id, "case", "calibrating");
			transitionCaseStatus(base, def.id, "case", "frozen");
			expect(() => transitionCaseStatus(base, def.id, "case", "draft")).toThrow(/illegal/);
			expect(() => transitionCaseStatus(base, def.id, "case", "calibrating")).toThrow(/illegal/);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("default meta is draft when meta.json is absent", () => {
		const base = tmpBase();
		try {
			const def = createBenchmark(base, { title: "NoMeta" });
			// Manually create a case without meta
			const caseDir = join(base, "evolve/benchmarks", def.id, "cases", "orphan");
			mkdirSync(caseDir, { recursive: true });
			writeFileSync(join(caseDir, "statement.md"), "orphan statement for testing", "utf8");
			writeFileSync(join(caseDir, "rubric.json"), JSON.stringify({ envelope: "test" }), "utf8");
			const meta = loadCaseMeta(base, def.id, "orphan");
			expect(meta).toBeUndefined();
			// listCases should still work (no status field)
			const cases = listCases(base, def.id);
			expect(cases).toHaveLength(1);
			expect(cases[0]?.status).toBeUndefined();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("caseCheckProblems (A5)", () => {
	it("reports no problems for a well-formed case with meta", () => {
		const base = tmpBase();
		try {
			const def = createBenchmark(base, { title: "Quality" });
			addCase(base, def.id, "Good Case", "This is a sufficiently long statement for testing purposes", "rubric text");
			const meta = loadCaseMeta(base, def.id, "good_case")!;
			meta.capability = "tests coding conventions";
			meta.distinguisher = "correct formatting vs incorrect";
			meta.shortcuts = "none known";
			saveCaseMeta(base, def.id, "good_case", meta);
			const problems = caseCheckProblems(base, def.id, "good_case");
			expect(problems).toHaveLength(0);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("reports missing meta fields", () => {
		const base = tmpBase();
		try {
			const def = createBenchmark(base, { title: "Missing" });
			addCase(base, def.id, "Empty Meta", "This is a sufficiently long statement for testing purposes", "rubric");
			// Default meta has empty fields
			const problems = caseCheckProblems(base, def.id, "empty_meta");
			expect(problems).toContain("capability contract is empty");
			expect(problems).toContain("distinguisher is empty");
			expect(problems).toContain("shortcuts annotation is empty");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("reports short statement", () => {
		const base = tmpBase();
		try {
			const def = createBenchmark(base, { title: "Short" });
			addCase(base, def.id, "Short", "too short", "rubric");
			const meta = loadCaseMeta(base, def.id, "short")!;
			meta.capability = "x";
			meta.distinguisher = "y";
			meta.shortcuts = "z";
			saveCaseMeta(base, def.id, "short", meta);
			const problems = caseCheckProblems(base, def.id, "short");
			expect(problems.some((p) => p.includes("statement too short"))).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("reports missing meta.json", () => {
		const base = tmpBase();
		try {
			const def = createBenchmark(base, { title: "NoMeta" });
			addCase(base, def.id, "No Meta File", "This is a sufficiently long statement for testing purposes", "rubric");
			// Delete the meta.json
			rmSync(join(base, "evolve/benchmarks", def.id, "cases", "no_meta_file", "meta.json"));
			const problems = caseCheckProblems(base, def.id, "no_meta_file");
			expect(problems).toContain("meta.json missing (run /evolve benchmark casecheck to initialize)");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("reports missing statement.md", () => {
		const base = tmpBase();
		try {
			const def = createBenchmark(base, { title: "NoStatement" });
			addCase(base, def.id, "No Statement", "statement", "rubric");
			rmSync(join(base, "evolve/benchmarks", def.id, "cases", "no_statement", "statement.md"));
			const problems = caseCheckProblems(base, def.id, "no_statement");
			expect(problems).toContain("statement.md missing");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("reports missing rubric.json", () => {
		const base = tmpBase();
		try {
			const def = createBenchmark(base, { title: "NoRubric" });
			addCase(base, def.id, "No Rubric", "statement", "rubric");
			rmSync(join(base, "evolve/benchmarks", def.id, "cases", "no_rubric", "rubric.json"));
			const problems = caseCheckProblems(base, def.id, "no_rubric");
			expect(problems).toContain("rubric.json missing");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("calibration history (A5)", () => {
	it("stores and loads calibration records", () => {
		const base = tmpBase();
		try {
			const def = createBenchmark(base, { title: "CalHist" });
			addCase(base, def.id, "Case", "A valid statement for testing", "rubric");
			const meta = loadCaseMeta(base, def.id, "case")!;
			meta.calibrationHistory.push({
				runAt: "2026-08-18T00:00:00.000Z",
				score: 75,
				passed: true,
				notes: "good",
				modified: false,
			});
			meta.calibrationHistory.push({
				runAt: "2026-08-18T01:00:00.000Z",
				score: 82,
				passed: true,
				notes: "improved",
				modified: true,
			});
			saveCaseMeta(base, def.id, "case", meta);
			const reloaded = loadCaseMeta(base, def.id, "case")!;
			expect(reloaded.calibrationHistory).toHaveLength(2);
			expect(reloaded.calibrationHistory[0]?.score).toBe(75);
			expect(reloaded.calibrationHistory[1]?.modified).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
