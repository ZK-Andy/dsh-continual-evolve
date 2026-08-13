/**
 * Tests for evaluation cell normalization: score clamping, field coercion,
 * and malformed-input rejection.
 */
import { describe, expect, it } from "vitest";
import { normalizeCell } from "../src/evaluate.js";

describe("normalizeCell", () => {
	it("accepts a well-formed structured cell", () => {
		const cell = normalizeCell({ caseId: "c1", run: 2, score: 87.5, passed: true, notes: "evidence" }, "c1", 2, 60);
		expect(cell).toEqual({ caseId: "c1", run: 2, score: 87.5, passed: true, notes: "evidence" });
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
