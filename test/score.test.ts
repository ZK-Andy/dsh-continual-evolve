/**
 * Tests for code-owned scoring: aggregation, entry building, and the
 * non-regressive acceptance rule.
 */
import { describe, expect, it } from "vitest";
import { aggregate, decide, decisionReport, entryFromCells, flagMaterialDrift, type AggregateOptions } from "../src/score.js";
import type { CellScore } from "../src/benchmark.js";

const OPTS: AggregateOptions = { passThreshold: 60, regressionTolerance: 0, maxFailedCells: 0 };

function cells(scores: [string, number][]): CellScore[] {
	return scores.map(([caseId, score], i) => ({
		caseId,
		run: i + 1,
		status: "ok",
		score,
		passed: score >= 60,
		notes: "",
	}));
}

function failedCells(caseIds: string[]): CellScore[] {
	return caseIds.map((caseId, i) => ({
		caseId,
		run: i + 1,
		status: "failed",
		score: 0,
		passed: false,
		notes: "unit failed: provider down",
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
		expect(aggregate([]).failed).toBe(0);
	});

	it("excludes failed cells from means and counts them (failure-cell protocol)", () => {
		const aggr = aggregate([...cells([["a", 80]]), ...failedCells(["a", "b"])]);
		expect(aggr["a"]).toBe(80);
		expect(aggr["b"]).toBeUndefined();
		expect(aggr.overall).toBe(80);
		expect(aggr.failed).toBe(2);
		expect(aggr.total).toBe(3);
	});

	it("reports null per-case and overall when a case has only failed cells", () => {
		const aggr = aggregate(failedCells(["a"]));
		expect(aggr["a"]).toBeUndefined();
		expect(aggr.overall).toBeNull();
		expect(aggr.failed).toBe(1);
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

	it("rejects when the candidate has failed cells beyond the threshold", () => {
		const candidate = entryFromCells("candidate", [...cells([["a", 90]]), ...failedCells(["b"])]);
		const decision = decide(reference, candidate, OPTS);
		expect(decision.accepted).toBe(false);
		expect(decision.reasons.join(" ")).toMatch(/failed cells/);
	});

	it("rejects when the reference has failed cells beyond the threshold", () => {
		const badReference = entryFromCells("reference", [...cells([["a", 70]]), ...failedCells(["b"])]);
		const candidate = entryFromCells("candidate", cells([["a", 90], ["b", 85]]));
		const decision = decide(badReference, candidate, OPTS);
		expect(decision.accepted).toBe(false);
		expect(decision.reasons.join(" ")).toMatch(/reference has 1 failed/);
	});

	it("ignores failures inside a nonzero maxFailedCells threshold", () => {
		const reference = entryFromCells("reference", cells([["a", 70]]));
		// One ok cell + one failed cell for the SAME case: the failed run is
		// tolerated, the mean still comes from real data and stays comparable.
		const candidate = entryFromCells("candidate", [cells([["a", 90]])[0]!, ...failedCells(["a"])]);
		const decision = decide(reference, candidate, { ...OPTS, maxFailedCells: 1 });
		expect(decision.accepted).toBe(true);
	});
});

describe("decisionReport with failed cells", () => {
	it("flags failed cases and reports failure counts", () => {
		const reference = entryFromCells("reference", [...cells([["a", 70]]), ...failedCells(["b"])]);
		const candidate = entryFromCells("candidate", [...cells([["a", 90]]), ...failedCells(["b2"])]);
		const decision = decide(reference, candidate, OPTS);
		const lines = decisionReport(reference, candidate, decision).join("\n");
		expect(lines).toMatch(/failed cells: reference 1\/2 · candidate 1\/2/);
	});
});

// ── Gap C3: duration tracking ─────────────────────────────────────────

describe("aggregate duration (C3)", () => {
	it("sums durationMs from all cells", () => {
		const c: CellScore[] = [
			{ caseId: "a", run: 1, status: "ok", score: 80, passed: true, notes: "", durationMs: 1000 },
			{ caseId: "a", run: 2, status: "ok", score: 90, passed: true, notes: "", durationMs: 1500 },
			{ caseId: "b", run: 1, status: "failed", score: 0, passed: false, notes: "crash", durationMs: 200 },
		];
		const aggr = aggregate(c);
		expect(aggr.totalDurationMs).toBe(2700);
	});

	it("handles missing durationMs gracefully", () => {
		const c: CellScore[] = [
			{ caseId: "a", run: 1, status: "ok", score: 80, passed: true, notes: "" },
			{ caseId: "b", run: 1, status: "ok", score: 90, passed: true, notes: "", durationMs: 500 },
		];
		const aggr = aggregate(c);
		expect(aggr.totalDurationMs).toBe(500);
	});

	it("returns 0 when no cells have durationMs", () => {
		const aggr = aggregate(cells([["a", 80]]));
		expect(aggr.totalDurationMs).toBe(0);
	});
});

describe("decisionReport duration (C3)", () => {
	it("shows duration summary when available", () => {
		const reference = entryFromCells("ref", cells([["a", 70]]));
		// Inject durationMs into the aggregate manually
		reference.aggregate.totalDurationMs = 5000;
		const candidate = entryFromCells("cand", cells([["a", 90]]));
		candidate.aggregate.totalDurationMs = 3000;
		const decision = decide(reference, candidate, OPTS);
		const lines = decisionReport(reference, candidate, decision);
		expect(lines.some((l) => l.includes("duration:"))).toBe(true);
	});

	it("omits duration when both are 0", () => {
		const reference = entryFromCells("ref", cells([["a", 70]]));
		const candidate = entryFromCells("cand", cells([["a", 90]]));
		const decision = decide(reference, candidate, OPTS);
		const lines = decisionReport(reference, candidate, decision);
		expect(lines.some((l) => l.includes("duration:"))).toBe(false);
	});
});

// ── Gap A3: material-drift detection (version_changed semantics) ──────

describe("flagMaterialDrift (A3)", () => {
	function okCell(caseId: string, hash: string): CellScore {
		return { caseId, run: 1, status: "ok", score: 90, passed: true, notes: "", caseHash: hash };
	}

	it("re-marks a candidate cell failed when its case hash no longer matches the reference", () => {
		const reference = entryFromCells("ref", [okCell("a", "hash-v1")]);
		const flagged = flagMaterialDrift(reference, [okCell("a", "hash-v2")]);
		expect(flagged[0]?.status).toBe("failed");
		expect(flagged[0]?.passed).toBe(false);
		expect(flagged[0]?.notes).toMatch(/materials changed: case a hash hash-v2 ≠ reference hash-v1/);
	});

	it("leaves matching cells untouched", () => {
		const reference = entryFromCells("ref", [okCell("a", "hash-v1")]);
		const flagged = flagMaterialDrift(reference, [okCell("a", "hash-v1")]);
		expect(flagged[0]).toEqual({ ...okCell("a", "hash-v1") });
	});

	it("leaves candidate cells whose case has no reference hash untouched (new case)", () => {
		const reference = entryFromCells("ref", [okCell("a", "hash-v1")]);
		const flagged = flagMaterialDrift(reference, [okCell("b", "hash-x")]);
		expect(flagged[0]?.status).toBe("ok");
	});

	it("ignores pre-A3 cells without hashes on either side", () => {
		const reference = entryFromCells("ref", cells([["a", 70]]));
		const candidate = cells([["a", 90]]);
		const flagged = flagMaterialDrift(reference, candidate);
		expect(flagged).toEqual(candidate);
	});

	it("does not touch cells already failed", () => {
		const reference = entryFromCells("ref", [okCell("a", "hash-v1")]);
		const alreadyFailed: CellScore = { caseId: "a", run: 1, status: "failed", score: 0, passed: false, notes: "reviewer crashed", caseHash: "hash-v2" };
		const flagged = flagMaterialDrift(reference, [alreadyFailed]);
		expect(flagged[0]).toEqual(alreadyFailed);
	});

	it("feeds the failure-cell protocol: drifted cells exclude from the mean and reject the round", () => {
		const reference = entryFromCells("ref", [okCell("a", "hash-v1")]);
		const candidate = entryFromCells("cand", [...flagMaterialDrift(reference, [okCell("a", "hash-v2")])]);
		expect(candidate.aggregate.failed).toBe(1);
		expect(candidate.overall).toBeNull();
		expect(decide(reference, candidate, OPTS).accepted).toBe(false);
	});
});
