/**
 * Tests for the /evolve command input parser: comment stripping and
 * angle-bracket tolerance (users paste help-text placeholders verbatim).
 */
import { describe, expect, it } from "vitest";
import { findEntryById, stripAngleBrackets, tokenizeEvolveInput } from "../src/command.js";
import { emptyHarnessState, type HarnessEntry } from "../src/types.js";

describe("tokenizeEvolveInput", () => {
	it("splits on whitespace", () => {
		expect(tokenizeEvolveInput("  plan 记住我的约定 ")).toEqual(["plan", "记住我的约定"]);
	});

	it("strips trailing shell-style comments", () => {
		expect(tokenizeEvolveInput("rollback evolve_x    # 验证确定性回滚（条目应消失）")).toEqual(["rollback", "evolve_x"]);
	});

	it("handles empty and comment-only input", () => {
		expect(tokenizeEvolveInput("   ")).toEqual([]);
		expect(tokenizeEvolveInput("# just a comment")).toEqual([]);
	});

	it("groups double-quoted words into one token and strips the quotes", () => {
		expect(tokenizeEvolveInput('benchmark add-case git_workflow "Commit hygiene" "Run pnpm test" "Message format"')).toEqual([
			"benchmark",
			"add-case",
			"git_workflow",
			"Commit hygiene",
			"Run pnpm test",
			"Message format",
		]);
	});

	it("supports single quotes and mixed quoting", () => {
		expect(tokenizeEvolveInput("plan '记住 这条 约定' 提交规范")).toEqual(["plan", "记住 这条 约定", "提交规范"]);
	});

	it("does not strip a # inside quotes", () => {
		expect(tokenizeEvolveInput('add-case b "fix #123" rest')).toEqual(["add-case", "b", "fix #123", "rest"]);
	});
});

describe("stripAngleBrackets", () => {
	it("strips wrapping angle brackets from pasted placeholder ids", () => {
		expect(stripAngleBrackets("<evolve_msrwsdy5_l3xzgn>")).toBe("evolve_msrwsdy5_l3xzgn");
		expect(stripAngleBrackets("evolve_msrwsdy5_l3xzgn")).toBe("evolve_msrwsdy5_l3xzgn");
		expect(stripAngleBrackets("")).toBe("");
	});
});

describe("findEntryById", () => {
	function fullEntry(id: string, kind: HarnessEntry["kind"]): HarnessEntry {
		return {
			id,
			kind,
			title: id,
			content: "body",
			path: "general",
			scope: "local",
			reference: {},
			arguments: {},
			metadata: {},
			source: "evolve",
			created_at: "2026-08-14T00:00:00.000Z",
			updated_at: "2026-08-14T00:00:00.000Z",
			version: 1,
		};
	}

	it("finds an entry across kinds", () => {
		const state = emptyHarnessState();
		state.entries.memory["m1"] = fullEntry("m1", "memory");
		state.entries.skill["s1"] = fullEntry("s1", "skill");
		expect(findEntryById(state, "s1")?.[0]).toBe("skill");
		expect(findEntryById(state, "s1")?.[1].id).toBe("s1");
		expect(findEntryById(state, "m1")?.[0]).toBe("memory");
	});

	it("returns undefined for unknown ids and empty stores", () => {
		expect(findEntryById(emptyHarnessState(), "nope")).toBeUndefined();
		const state = emptyHarnessState();
		state.entries.prompt["p1"] = fullEntry("p1", "prompt");
		expect(findEntryById(state, "p2")).toBeUndefined();
	});
});
