import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedPaths, deriveBase, parseScopeArgs } from "../scripts/change-scope.js";

describe("parseScopeArgs", () => {
	it("defaults head to HEAD with no base", () => {
		expect(parseScopeArgs([])).toEqual({ base: undefined, head: "HEAD" });
	});

	it("reads positional base and head", () => {
		expect(parseScopeArgs(["abc123", "def456"])).toEqual({ base: "abc123", head: "def456" });
	});

	it("reads flag form", () => {
		expect(parseScopeArgs(["--base", "abc123", "--head", "def456"])).toEqual({ base: "abc123", head: "def456" });
	});

	it("lets flags win over positionals", () => {
		expect(parseScopeArgs(["zzz", "--base", "abc123"])).toEqual({ base: "abc123", head: "HEAD" });
	});

	it("rejects unknown flags and missing values", () => {
		expect(() => parseScopeArgs(["--bogus", "x"])).toThrow("unknown flag");
		expect(() => parseScopeArgs(["--base"])).toThrow("--base needs a value");
		expect(() => parseScopeArgs(["--head"])).toThrow("--head needs a value");
	});
});

describe("changedPaths", () => {
	let cwd = "";
	let repo = "";

	const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8" }).trim();

	beforeEach(() => {
		cwd = process.cwd();
		repo = mkdtempSync(join(tmpdir(), "evolve-scope-"));
		process.chdir(repo);
		git("init", "-b", "main");
		git("config", "user.email", "scope@test.invalid");
		git("config", "user.name", "scope");
		writeFileSync(join(repo, "a.txt"), "one\n");
		git("add", "a.txt");
		git("commit", "-qm", "first");
	});

	afterEach(() => {
		process.chdir(cwd);
	});

	it("merges committed, unstaged, and untracked paths deduped", () => {
		const base = git("rev-parse", "HEAD");
		writeFileSync(join(repo, "b.txt"), "two\n");
		git("add", "b.txt");
		git("commit", "-qm", "second");
		writeFileSync(join(repo, "a.txt"), "one-mod\n");
		writeFileSync(join(repo, "c.txt"), "new\n");
		expect(changedPaths(base, "HEAD")).toEqual(["a.txt", "b.txt", "c.txt"]);
	});

	it("derives a base inside real history", () => {
		expect(deriveBase()).toMatch(/^[0-9a-f]{40}$/);
	});
});
