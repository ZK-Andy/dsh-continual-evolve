import { describe, expect, it } from "vitest";
import {
	DEFAULT_INDEX_MAX_TOKENS,
	estimateTokens,
	fitTiered,
	resolveIndexBudget,
	type IndexRow,
} from "../src/services/token-budget.js";

function rowsOf(count: number, titleLength = 4): IndexRow[] {
	const rows: IndexRow[] = [];
	for (let index = 0; index < count; index += 1) {
		const id = `m-${String(index)}`;
		rows.push({ id, line: `- [${id}] ${"题".repeat(titleLength)} — 钩子（user）` });
	}
	return rows;
}

describe("estimateTokens", () => {
	it("prices an empty string at zero", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("prices CJK at 1.5 tokens per character", () => {
		expect(estimateTokens("记忆")).toBe(3);
		expect(estimateTokens("记住这条规则")).toBe(9); // 6 CJK chars × 1.5
	});

	it("prices latin text at four characters per token", () => {
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcdefgh")).toBe(2);
	});

	it("prices mixed text by part and rounds up", () => {
		// 2 CJK (3) + 4 latin (1) = 4
		expect(estimateTokens("记忆 abcd")).toBe(5); // 3 + ceil(5/4)
	});
});

describe("fitTiered", () => {
	it("renders every row in full when the budget allows", () => {
		const rows = rowsOf(3);
		const fit = fitTiered(rows, 10_000);
		expect(fit.fullCount).toBe(3);
		expect(fit.idOnlyCount).toBe(0);
		expect(fit.omittedCount).toBe(0);
		expect(fit.text.split("\n")).toHaveLength(3);
	});

	it("degrades the tail to id-only rows when full rows stop fitting", () => {
		const rows = rowsOf(3);
		const fit = fitTiered(rows, 20);
		expect(fit.fullCount).toBeGreaterThan(0);
		expect(fit.fullCount).toBeLessThan(3);
		expect(fit.idOnlyCount).toBeGreaterThan(0);
		const lines = fit.text.split("\n");
		expect(lines).toContain("- [m-1]");
	});

	it("counts the rows it could not even name", () => {
		const rows = rowsOf(40);
		const fit = fitTiered(rows, 30);
		expect(fit.omittedCount).toBeGreaterThan(0);
		expect(fit.text).toContain("未展开");
	});

	it("renders nothing for an empty budget or no rows", () => {
		expect(fitTiered(rowsOf(2), 0)).toMatchObject({ text: "", fullCount: 0, omittedCount: 2 });
		expect(fitTiered([], 100)).toMatchObject({ text: "", fullCount: 0, omittedCount: 0 });
	});

	it("never emits a partial row", () => {
		const rows = rowsOf(5);
		const fit = fitTiered(rows, 25);
		for (const line of fit.text.split("\n")) {
			expect(line === "" || line.startsWith("- [") || line.startsWith("（其余")).toBe(true);
		}
	});
});

describe("resolveIndexBudget", () => {
	it("takes an explicit token budget", () => {
		expect(resolveIndexBudget({ maxTokens: 4000 })).toEqual({ tokens: 4000, fromLegacy: false });
	});

	it("converts the legacy character cap once", () => {
		expect(resolveIndexBudget({ maxChars: 6000 })).toEqual({ tokens: 4000, fromLegacy: true });
	});

	it("ignores the legacy cap after the migration marker", () => {
		expect(resolveIndexBudget({ maxChars: 6000, migrated: true })).toEqual({
			tokens: DEFAULT_INDEX_MAX_TOKENS,
			fromLegacy: false,
		});
	});

	it("falls back to the default when nothing is configured", () => {
		expect(resolveIndexBudget({})).toEqual({ tokens: DEFAULT_INDEX_MAX_TOKENS, fromLegacy: false });
		expect(resolveIndexBudget({ maxTokens: 0, maxChars: -1 })).toEqual({
			tokens: DEFAULT_INDEX_MAX_TOKENS,
			fromLegacy: false,
		});
	});
});
