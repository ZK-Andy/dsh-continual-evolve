import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findHistoryHits, stripCode } from "../scripts/verify-history-words.js";

describe("stripCode", () => {
	it("removes fenced blocks", () => {
		expect(stripCode("before\n```\npreviously here\n```\nafter")).toBe("before\n\nafter");
	});

	it("removes inline spans but keeps prose", () => {
		expect(stripCode("set `now + 1d` and continue")).toBe("set  and continue");
	});
});

describe("findHistoryHits", () => {
	it("flags previously in prose", () => {
		const hits = findHistoryHits("a.md", "# T\n\nPreviously we used X.\n");
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ file: "a.md", line: 3 });
	});

	it("flags now with trailing space", () => {
		expect(findHistoryHits("a.md", "calls now use it\n")).toHaveLength(1);
	});

	it("ignores now inside a longer word", () => {
		expect(findHistoryHits("a.md", "knowledge grows\n")).toHaveLength(0);
	});

	it("flags no longer, renamed, 曾经 and 后来改成", () => {
		expect(findHistoryHits("a.md", "no longer injected\n")).toHaveLength(1);
		expect(findHistoryHits("a.md", "renamed aside\n")).toHaveLength(1);
		expect(findHistoryHits("a.md", "曾经这样做\n")).toHaveLength(1);
		expect(findHistoryHits("a.md", "后来改成新的\n")).toHaveLength(1);
	});

	it("ignores metalanguage inside code", () => {
		expect(findHistoryHits("a.md", "`probation_until = now + 30d`\n")).toHaveLength(0);
		expect(findHistoryHits("a.md", "要 `now` 却不给 `now`\n")).toHaveLength(0);
	});
});

describe("history-words fixtures", () => {
	it("documents the red-green pair by content", () => {
		expect(findHistoryHits("history.md", "Previously we used a global store for everything.\n")).toHaveLength(1);
		expect(findHistoryHits("other.md", "The store is global.\n")).toHaveLength(0);
	});

	it("keeps the fixture files on disk", () => {
		const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
		const bad = join(root, "test/fixtures/gates/history-words/violation/history.md");
		const good = join(root, "test/fixtures/gates/history-words/clean/other.md");
		expect(existsSync(bad)).toBe(true);
		expect(existsSync(good)).toBe(true);
		expect(findHistoryHits(bad, readFileSync(bad, "utf-8"))).toHaveLength(1);
		expect(findHistoryHits(good, readFileSync(good, "utf-8"))).toHaveLength(0);
	});
});
