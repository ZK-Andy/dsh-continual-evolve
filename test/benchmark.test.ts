/**
 * Tests for the benchmark store: create, list, add-case, scoreboard
 * persistence, and id sanitization.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { decryptRubric, deriveKey, DEV_RUBRIC_KEY } from "../src/rubric.js";
import {
	addCase,
	createBenchmark,
	listBenchmarks,
	listCases,
	loadBenchmark,
	loadScoreboard,
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
