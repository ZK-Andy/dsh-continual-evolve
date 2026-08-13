/**
 * Tests for code-owned scoring: aggregation, entry building, and the
 * non-regressive acceptance rule.
 */
import { describe, expect, it } from "vitest";
import { aggregate, decide, decisionReport, entryFromCells, type AggregateOptions } from "../src/score.js";
import type { CellScore } from "../src/benchmark.js";

const OPTS: AggregateOptions = { passThreshold: 60, regressionTolerance: 0 };

function cells(scores: [string, number][]): CellScore[] {
	return scores.map(([caseId, score], i) => ({
		caseId,
		run: i + 1,
		score,
		passed: score >= 60,
		notes: "",
	}));
}

describe("aggregate", () => {
	it("computes per-case means and overall mean", () => {
		const aggr = aggregate(cells([["a", 80], ["a", 60], ["b", 100]]));
		expect(aggr["a"]).toBe(70);
		expect(aggr["b"]).toBe(100);
		expect(aggr.overall).toBe(80);
	});

	it("clamps out-of-range scores", () => {
		const aggr = aggregate(cells([["a", 150], ["a", -5]]));
		expect(aggr["a"]).toBe(50);
	});

	it("returns null overall for empty cells", () => {
		expect(aggregate([]).overall).toBeNull();
	});
});

describe("entryFromCells", () => {
	it("records code-owned aggregates and optional refinement id", () => {
		const entry = entryFromCells("candidate:r1", cells([["a", 90]]), "r1");
		expect(entry.label).toBe("candidate:r1");
		expect(entry.refinementId).toBe("r1");
		expect(entry.aggregate["a"]).toBe(90);
		expect(entry.overall).toBe(90);
	});
});

describe("decisionReport", () => {
	it("renders per-case deltas and the decision line", () => {
		const reference = entryFromCells("reference", cells([["a", 70], ["b", 80]]));
		const candidate = entryFromCells("candidate", cells([["a", 90], ["b", 85]]));
		const decision = decide(reference, candidate, OPTS);
		const lines = decisionReport(reference, candidate, decision);
		expect(lines.join("\n")).toContain("overall: 75 → 87.5");
		expect(lines.join("\n")).toContain("a: 70 → 90");
		expect(lines.join("\n")).toContain("DECISION: ACCEPTED");
	});
});

describe("decide", () => {
	const reference = entryFromCells("reference", cells([["a", 70], ["b", 80]]));

	it("accepts when overall is strictly higher with no regression", () => {
		const candidate = entryFromCells("candidate", cells([["a", 80], ["b", 90]]));
		const decision = decide(reference, candidate, OPTS);
		expect(decision.accepted).toBe(true);
		expect(decision.reasons).toEqual([]);
	});

	it("rejects when overall is not strictly higher", () => {
		const candidate = entryFromCells("candidate", cells([["a", 80], ["b", 70]]));
		const decision = decide(reference, candidate, OPTS);
		expect(decision.accepted).toBe(false);
		expect(decision.reasons.join(" ")).toMatch(/not improved/);
	});

	it("rejects a case regression even with a higher overall", () => {
		const candidate = entryFromCells("candidate", cells([["a", 90], ["b", 60]]));
		const decision = decide(reference, candidate, OPTS);
		expect(decision.accepted).toBe(false);
		expect(decision.reasons.join(" ")).toMatch(/regressed/);
	});

	it("tolerates regression within the configured tolerance", () => {
		const candidate = entryFromCells("candidate", cells([["a", 90], ["b", 75]]));
		const decision = decide(reference, candidate, { ...OPTS, regressionTolerance: 10 });
		expect(decision.accepted).toBe(true);
	});

	it("rejects incomplete evaluations", () => {
		const incomplete = entryFromCells("candidate", []);
		const decision = decide(reference, incomplete, OPTS);
		expect(decision.accepted).toBe(false);
		expect(decision.reasons.join(" ")).toMatch(/incomplete/);
	});
});
