import { describe, expect, it } from "vitest";
import { normalizeUsage, sumUsage, zeroUsage } from "../src/token-usage.js";

describe("normalizeUsage", () => {
	it("normalizes every payload shape observed in the real ledger", () => {
		expect(normalizeUsage({ inputTokens: 101, outputTokens: 1011, totalTokens: 1737, cacheReadTokens: 625 })).toEqual({
			input: 101,
			output: 1011,
			cacheRead: 625,
			cacheWrite: 0,
			reasoning: 0,
			total: 1737,
		});
		expect(
			normalizeUsage({ inputTokens: 108, outputTokens: 2266, cacheReadTokens: 1408, cacheWriteTokens: 0, reasoningTokens: 1439 }),
		).toMatchObject({ input: 108, output: 2266, cacheRead: 1408, reasoning: 1439, total: 2374 });
		expect(normalizeUsage({ inputTokens: 1270, outputTokens: 299, totalTokens: 1569 })).toMatchObject({
			total: 1569,
		});
	});

	it("returns null for non-objects and payloads without usable signal", () => {
		for (const raw of [undefined, null, 42, "tokens", [], { durationMs: 5 }, { inputTokens: -3 }]) {
			expect(normalizeUsage(raw)).toBeNull();
		}
	});

	it("treats non-finite and negative fields as zero", () => {
		expect(normalizeUsage({ inputTokens: Number.NaN, outputTokens: 10 })).toMatchObject({
			input: 0,
			output: 10,
			total: 10,
		});
	});
});

describe("sumUsage", () => {
	it("adds field-wise over the zero value", () => {
		const total = sumUsage(
			{ input: 100, output: 200, cacheRead: 50, cacheWrite: 0, reasoning: 10, total: 300 },
			{ input: 5, output: 7, cacheRead: 0, cacheWrite: 1, reasoning: 0, total: 12 },
		);
		expect(total).toEqual({ input: 105, output: 207, cacheRead: 50, cacheWrite: 1, reasoning: 10, total: 312 });
		expect(sumUsage(zeroUsage(), zeroUsage())).toEqual(zeroUsage());
	});
});
