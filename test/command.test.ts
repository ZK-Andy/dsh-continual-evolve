/**
 * Tests for the /evolve command input parser: comment stripping and
 * angle-bracket tolerance (users paste help-text placeholders verbatim).
 */
import { describe, expect, it } from "vitest";
import { stripAngleBrackets, tokenizeEvolveInput } from "../src/command.js";

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
