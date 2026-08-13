/**
 * Tests for the skill materializer: name conversion, SKILL.md rendering,
 * create/delete sync, and path-escape defense.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { renderSkillMarkdown, skillDir, skillNameOf, syncSkillsFromResult } from "../src/skill.js";
import type { HarnessEntry, RefinementResult } from "../src/types.js";

function skillEntry(overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	return {
		id: "lint_before_writing_code",
		kind: "skill",
		title: "Lint before writing code",
		content: "Run the applicable linter before writing code.",
		path: "conventions",
		scope: "global",
		reference: { type: "python", import: "lint_tools", callable: "run_lint" },
		arguments: { files: { type: "array", required: true, description: "files to lint" } },
		metadata: {},
		source: "evolve",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		version: 1,
		...overrides,
	};
}

function tmpRoot(): string {
	const base = join(process.cwd(), "test/.tmp");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "/"));
}

describe("skillNameOf", () => {
	it("converts underscore slugs to kebab-case", () => {
		expect(skillNameOf("lint_before_writing_code")).toBe("lint-before-writing-code");
		expect(skillNameOf("already-kebab")).toBe("already-kebab");
	});
});

describe("renderSkillMarkdown", () => {
	it("emits kebab name, description, content, invocation, and arguments", () => {
		const md = renderSkillMarkdown(skillEntry());
		expect(md).toContain("name: lint-before-writing-code");
		expect(md).toContain("description: Lint before writing code");
		expect(md).toContain("Run the applicable linter before writing code.");
		expect(md).toContain("- import: \"lint_tools\"");
		expect(md).toContain("- callable: \"run_lint\"");
		expect(md).toContain('"files"');
	});
});

describe("syncSkillsFromResult", () => {
	it("writes SKILL.md on create and removes it on delete", () => {
		const root = tmpRoot();
		try {
			const created: RefinementResult = {
				id: "r1",
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				appliedEdits: [
					{ action: "create", kind: "skill", id: "lint_before_writing_code", title: "t", content: "c", applied: true, after: skillEntry() },
				],
				harnessStatePath: "",
			};
			syncSkillsFromResult(root, created);
			const mdPath = join(root, "lint-before-writing-code", "SKILL.md");
			expect(existsSync(mdPath)).toBe(true);
			expect(readFileSync(mdPath, "utf8")).toContain("name: lint-before-writing-code");

			const deleted: RefinementResult = {
				...created,
				id: "r2",
				appliedEdits: [{ action: "delete", kind: "skill", id: "lint_before_writing_code", applied: true, before: skillEntry() }],
			};
			syncSkillsFromResult(root, deleted);
			expect(existsSync(join(root, "lint-before-writing-code"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores non-skill edits", () => {
		const root = tmpRoot();
		try {
			const result: RefinementResult = {
				id: "r3",
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				appliedEdits: [{ action: "create", kind: "memory", id: "m", title: "t", content: "c", applied: true }],
				harnessStatePath: "",
			};
			syncSkillsFromResult(root, result);
			expect(existsSync(join(root, "m"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("skillDir defense", () => {
	it("rejects ids that escape the skills root", () => {
		expect(() => skillDir("/tmp/skills-root", "../../etc/passwd")).toThrow(/escapes/);
	});
});
