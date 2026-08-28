/**
 * Auto-case capture tests (P1, #17): failed evolution attempts land as draft
 * cases in the dedicated auto-regression container benchmark — statement
 * scaffold, unscorable rubric, per-capture uniqueness, and container
 * isolation from user benchmarks.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_RUBRIC_KEY, deriveKey } from "../src/rubric.js";
import { listCases, loadBenchmark, loadCaseMeta } from "../src/benchmark.js";
import { AUTO_CASE_BENCHMARK_ID, captureAutoCase, renderAutoCaseRubric, renderAutoCaseStatement } from "../src/autocase.js";

const KEY = deriveKey(DEV_RUBRIC_KEY);

function base(): string {
	return mkdtempSync(join(tmpdir(), "autocase-"));
}

function input(overrides: Partial<Parameters<typeof captureAutoCase>[0]> = {}): Parameters<typeof captureAutoCase>[0] {
	return {
		baseDir: "",
		rubricKey: KEY,
		source: "benchmark_rejection" as const,
		sessionId: "session-abc12345",
		summary: "bench candidate evolve_x1y2z3",
		reasons: ["case totalDurationMs regressed: 100 < 120 - 0"],
		refinementId: "evolve_x1y2z3",
		...overrides,
	};
}

describe("captureAutoCase", () => {
	it("creates the container benchmark on first use and a draft case per capture", () => {
		const dir = base();
		try {
			const first = captureAutoCase(input({ baseDir: dir, now: Date.parse("2026-08-28T13:00:00.000Z") }));
			expect(first.bid).toBe(AUTO_CASE_BENCHMARK_ID);
			expect(loadBenchmark(dir, AUTO_CASE_BENCHMARK_ID)).toBeDefined();

			const second = captureAutoCase(input({ baseDir: dir, source: "gate_no_consent", now: Date.parse("2026-08-28T13:00:01.000Z") }));
			const cases = listCases(dir, AUTO_CASE_BENCHMARK_ID);
			expect(cases).toHaveLength(2);
			expect(cases.map((c) => c.id)).toContain(first.caseId);
			expect(cases.map((c) => c.id)).toContain(second.caseId);

			// Every capture is a draft with full case metadata (A5 lifecycle).
			for (const c of cases) {
				expect(loadCaseMeta(dir, AUTO_CASE_BENCHMARK_ID, c.id)?.status).toBe("draft");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("captures the failure trail in the statement scaffold", () => {
		const dir = base();
		try {
			const captured = captureAutoCase(input({ baseDir: dir, now: Date.parse("2026-08-28T13:00:00.000Z") }));
			const statement = listCases(dir, AUTO_CASE_BENCHMARK_ID).find((c) => c.id === captured.caseId)!.statement;
			expect(statement).toContain("source: benchmark_rejection");
			expect(statement).toContain("session: session-abc12345");
			expect(statement).toContain("refinement: evolve_x1y2z3");
			expect(statement).toContain("case totalDurationMs regressed");
			expect(statement).toContain("never enters a user");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("millisecond-stamped titles stay unique under the 40-char id cap", () => {
		const dir = base();
		try {
			const now = Date.parse("2026-08-28T13:00:00.000Z");
			const first = captureAutoCase(input({ baseDir: dir, now }));
			const second = captureAutoCase(input({ baseDir: dir, now: now + 1 }));
			expect(first.caseId).not.toBe(second.caseId);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("auto-case scaffolds", () => {
	it("statement renders a session-less, refinement-less capture without empty fields", () => {
		const text = renderAutoCaseStatement(input({ sessionId: undefined, refinementId: undefined }), "20260828T130000000Z");
		expect(text).toContain("session: (unknown)");
		expect(text).not.toContain("refinement:");
	});

	it("rubric states the captured signal and its own unscorability", () => {
		const rubric = renderAutoCaseRubric(input());
		expect(rubric).toContain("authored at calibration time");
		expect(rubric).toContain("case totalDurationMs regressed");
	});
});
