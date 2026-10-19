import { describe, expect, it } from "vitest";
import { ftsPhrase, likePattern, queryTokens, searchAlternatives } from "../src/data/search-query.js";

/** Query vocabulary unit tests: tokenizing, CJK windows, and LIKE escaping. */
describe("queryTokens", () => {
	it("splits on ASCII and full-width whitespace", () => {
		expect(queryTokens("发版 必须　全绿")).toEqual(["发版", "必须", "全绿"]);
	});

	it("drops empties", () => {
		expect(queryTokens("  ")).toEqual([]);
	});
});

describe("searchAlternatives", () => {
	it("passes short and non-CJK tokens through", () => {
		expect(searchAlternatives("ab")).toEqual(["ab"]);
		expect(searchAlternatives("publish")).toEqual(["publish"]);
	});

	it("expands long CJK runs into trigram windows", () => {
		expect(searchAlternatives("什么时候可以")).toEqual(["什么时", "么时候", "时候可", "候可以"]);
	});
});

describe("ftsPhrase", () => {
	it("quotes a token as one FTS phrase", () => {
		expect(ftsPhrase("发版")).toBe('"发版"');
	});

	it("doubles embedded quotes", () => {
		expect(ftsPhrase('a"b')).toBe('"a""b"');
	});
});

describe("likePattern", () => {
	it("wraps the token literally", () => {
		expect(likePattern("发版")).toBe("%发版%");
	});

	it("escapes LIKE metacharacters", () => {
		expect(likePattern("100%_x\\y")).toBe("%100\\%\\_x\\\\y%");
	});
});
