/**
 * Tests for skill rendering (extracted from skill.ts to break circular
 * dependency): skillNameOf conversion and renderSkillMarkdown output.
 */
import { describe, expect, it } from "vitest";
import { skillNameOf, renderSkillMarkdown } from "../src/skill-render.js";
import type { HarnessEntry } from "../src/types.js";

function entry(overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	return {
		id: "my_skill",
		kind: "skill",
		title: "My Skill Title",
		content: "Skill body content.",
		path: "",
		scope: "global",
		reference: {},
		arguments: {},
		metadata: {},
		source: "evolve",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		version: 1,
		...overrides,
	};
}

describe("skillNameOf", () => {
	it("converts underscores to hyphens and lowercases", () => {
		expect(skillNameOf("my_cool_skill")).toBe("my-cool-skill");
	});

	it("leaves kebab-case unchanged", () => {
		expect(skillNameOf("already-kebab")).toBe("already-kebab");
	});

	it("lowercases mixed case", () => {
		expect(skillNameOf("MySkill")).toBe("myskill");
	});
});

describe("renderSkillMarkdown", () => {
	it("produces frontmatter with kebab name and description", () => {
		const md = renderSkillMarkdown(entry());
		expect(md).toContain("---");
		expect(md).toContain("name: my-skill");
		expect(md).toContain("description: My Skill Title");
		expect(md).toContain("Skill body content.");
	});

	it("includes Invocation section when reference is non-empty", () => {
		const md = renderSkillMarkdown(entry({ reference: { type: "python", import: "mod", callable: "fn" } }));
		expect(md).toContain("## Invocation");
		expect(md).toContain('- type: "python"');
	});

	it("omits Invocation section when reference is empty", () => {
		const md = renderSkillMarkdown(entry({ reference: {} }));
		expect(md).not.toContain("## Invocation");
	});

	it("includes Arguments section when arguments is non-empty", () => {
		const md = renderSkillMarkdown(entry({ arguments: { files: { type: "array" } } }));
		expect(md).toContain("## Arguments");
		expect(md).toContain('"files"');
	});

	it("omits Arguments section when arguments is empty", () => {
		const md = renderSkillMarkdown(entry({ arguments: {} }));
		expect(md).not.toContain("## Arguments");
	});

	it("trims whitespace from content", () => {
		const md = renderSkillMarkdown(entry({ content: "  trimmed  \n" }));
		// Content is trimmed but the blank line between frontmatter and body is structural
		expect(md).toContain("trimmed");
		expect(md).not.toContain("  trimmed  ");
	});

	it("normalizes whitespace in title (oneLine)", () => {
		const md = renderSkillMarkdown(entry({ title: "Multi   line   title" }));
		expect(md).toContain("description: Multi line title");
	});

	it("ends with a single newline", () => {
		const md = renderSkillMarkdown(entry());
		expect(md.endsWith("\n")).toBe(true);
		expect(md.endsWith("\n\n")).toBe(false);
	});
});

describe("description routing hint (2026-08-22)", () => {
	it("appends the first meaningful content line as a use-when hint", () => {
		const md = renderSkillMarkdown(entry({
			id: "release_check",
			kind: "skill",
			title: "Release check",
			content: "# Steps\nRun the release checklist before tagging a version.",
		}));
		expect(md).toMatch(/description: Release check — use when: Run the release checklist before tagging a version\./);
	});

	it("falls back to bare content hint when the title is empty", () => {
		const md = renderSkillMarkdown(entry({ id: "x", kind: "skill", title: "", content: "Only the body speaks." }));
		expect(md).toContain("description: Only the body speaks.");
	});
});
