/**
 * Tests for the model-reply JSON recovery helpers (plan.ts): truncated vs
 * malformed replies are named differently, and non-object JSON is rejected
 * loudly instead of flowing into the planner as an empty proposal.
 */
import { describe, expect, it } from "vitest";
import { extractJsonObject, isIncompleteJson, parseJsonCandidate, parseProposal } from "../src/plan.js";

describe("isIncompleteJson", () => {
	it("detects unclosed strings, objects, and arrays", () => {
		expect(isIncompleteJson('{"a": "open')).toBe(true);
		expect(isIncompleteJson('{"a": 1')).toBe(true);
		expect(isIncompleteJson("[1, 2")).toBe(true);
		expect(isIncompleteJson('{"a": 1}')).toBe(false);
	});

	it("ignores brackets inside strings and honors escapes", () => {
		expect(isIncompleteJson('{"a": "} {"}')).toBe(false);
		expect(isIncompleteJson('{"a": "quote \\" still open')).toBe(true);
	});
});

describe("parseJsonCandidate", () => {
	it("names truncation differently from malformation", () => {
		expect(() => parseJsonCandidate('{"a": "open')).toThrow(/output budget exhausted/);
		expect(() => parseJsonCandidate('{"a": 1,}')).toThrow(/did not return valid JSON/);
	});
});

describe("extractJsonObject", () => {
	it("recovers an object from prose with a broken tail", () => {
		// The sliced span fails JSON.parse (trailing comma), so the extractor
		// retries the slice remainder as a truncation candidate and names it.
		expect(() => extractJsonObject('verdict first {"a": 1,} trailing words')).toThrow(/did not return valid JSON/);
	});

	it("names a truncated brace span as an exhausted budget", () => {
		expect(() => extractJsonObject('prefix {"a": "open tail')).toThrow(/output budget exhausted/);
	});

	it("recovers fenced non-object JSON verbatim (callers reject it)", () => {
		expect(extractJsonObject("```json\n[1, 2]\n```")).toEqual([1, 2]);
	});
});

describe("parseProposal", () => {
	it("rejects a non-object proposal loudly", () => {
		expect(() => parseProposal('```json\n[1, 2]\n```')).toThrow(/must be an object/);
	});
});
