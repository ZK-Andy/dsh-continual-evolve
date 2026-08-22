/**
 * Tests for the skill-quality integration: reading the skill-creator
 * template facts, the builtin distilled guide fallback, and
 * the code-enforced mechanical frontmatter/content rules (mirroring
 * skill-creator's validate-frontmatter.mjs).
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	BUILTIN_SKILL_QUALITY_GUIDE,
	readSkillCreatorTemplate,
	skillQualityGuide,
	skillResourceRefs,
	validateRenderedSkillMarkdown,
	validateSkillEntryContent,
} from "../src/skillquality.js";
import { renderSkillMarkdown, syncSkillsFromResult } from "../src/skill.js";
import type { HarnessEntry, RefinementResult } from "../src/types.js";

function tmpRoot(): string {
	const base = join(process.cwd(), "test/.tmp");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "/"));
}

function skillEntry(overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	return {
		id: "my_skill",
		kind: "skill",
		title: "My skill",
		content: "# My skill\n\nRun the procedure.",
		path: "general",
		scope: "local",
		reference: { type: "python", import: "pkg.mod", callable: "run" },
		arguments: { input: { type: "string", required: true, description: "input" } },
		metadata: {},
		source: "evolve",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		version: 1,
		...overrides,
	};
}

describe("readSkillCreatorTemplate", () => {
	it("reads the template facts when installed", () => {
		const root = tmpRoot();
		try {
			const dir = join(root, "skill-creator", "references");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "template.md"), "# DSH 技能模板事实\n\n7 条结构特征…\n", "utf8");
			expect(readSkillCreatorTemplate(root)).toContain("7 条结构特征");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns null when the skills are not installed", () => {
		expect(readSkillCreatorTemplate(tmpRoot())).toBeNull();
	});

	it("returns null when the template file is empty", () => {
		const root = tmpRoot();
		try {
			const dir = join(root, "skill-creator", "references");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "template.md"), "   \n", "utf8");
			expect(readSkillCreatorTemplate(root)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("skillQualityGuide", () => {
	it("prefers the on-disk template over the builtin guide", () => {
		const root = tmpRoot();
		try {
			const dir = join(root, "skill-creator", "references");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "template.md"), "# Official facts\n\nOnly real trigger scenarios.\n", "utf8");
			const guide = skillQualityGuide(root);
			expect(guide.source).toBe("template");
			expect(guide.text).toContain("Official facts");
			expect(guide.text).toContain("skill-creator");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to the builtin guide without a skills root", () => {
		const guide = skillQualityGuide(undefined);
		expect(guide.source).toBe("builtin");
		expect(guide.text).toBe(BUILTIN_SKILL_QUALITY_GUIDE);
	});

	it("falls back to the builtin guide when the template is unreadable", () => {
		const guide = skillQualityGuide(tmpRoot());
		expect(guide.source).toBe("builtin");
	});

	it("never throws", () => {
		expect(() => skillQualityGuide(join("/nonexistent", "root"))).not.toThrow();
	});
});

describe("BUILTIN_SKILL_QUALITY_GUIDE", () => {
	it("carries the schema facts: kebab-case name and description routing", () => {
		expect(BUILTIN_SKILL_QUALITY_GUIDE).toMatch(/kebab-case/i);
		expect(BUILTIN_SKILL_QUALITY_GUIDE).toMatch(/use when/i);
	});

	it("carries the 7 structural features", () => {
		for (const feature of ["1.", "2.", "3.", "4.", "5.", "6.", "7."]) {
			expect(BUILTIN_SKILL_QUALITY_GUIDE).toContain(feature);
		}
		expect(BUILTIN_SKILL_QUALITY_GUIDE).toMatch(/boundary declaration/i);
		expect(BUILTIN_SKILL_QUALITY_GUIDE).toMatch(/Sources of truth/i);
	});

	it("carries the paragraph skeleton and creation rules", () => {
		expect(BUILTIN_SKILL_QUALITY_GUIDE).toMatch(/paragraph skeleton/i);
		expect(BUILTIN_SKILL_QUALITY_GUIDE).toMatch(/real trigger scenario/i);
		expect(BUILTIN_SKILL_QUALITY_GUIDE).toMatch(/do not duplicate/i);
	});

	it("rejects legacy camelCase invocation keys", () => {
		expect(BUILTIN_SKILL_QUALITY_GUIDE).toMatch(/camelCase/i);
	});
});

describe("validateSkillEntryContent", () => {
	it("accepts a normal skill body", () => {
		expect(validateSkillEntryContent("# My skill\n\nRun the procedure.")).toEqual([]);
	});

	it("rejects empty content", () => {
		expect(validateSkillEntryContent("   ").join(" ")).toMatch(/empty/);
	});

	it("rejects content opening with a frontmatter block", () => {
		const problems = validateSkillEntryContent("---\nname: x\n---\n\nbody");
		expect(problems.join(" ")).toMatch(/must not start with a `---`/);
	});

	it("rejects parent-relative resource references in prose and links", () => {
		const problems = validateSkillEntryContent(
			"Run `references/../evil.mjs`, see `scripts/../x.md` and [link](references/../../etc/x.md).",
		);
		expect(problems.join(" ")).toMatch(/escapes the skill directory/);
		expect(problems).toHaveLength(3);
	});

	it("does not flag non-resource absolute paths as references", () => {
		expect(validateSkillEntryContent("Read `/etc/passwd` for context.")).toEqual([]);
	});

	it("accepts skill-local resource references", () => {
		expect(validateSkillEntryContent("See `references/examples.md` and [scripts/run.mjs](scripts/run.mjs).")).toEqual([]);
	});
});

describe("validateRenderedSkillMarkdown", () => {
	it("accepts a mechanically valid rendered SKILL.md", () => {
		expect(validateRenderedSkillMarkdown(renderSkillMarkdown(skillEntry()))).toEqual([]);
	});

	it("rejects missing frontmatter delimiters", () => {
		const problems = validateRenderedSkillMarkdown("name: x\ndescription: y\n\nbody");
		expect(problems.join(" ")).toMatch(/missing YAML frontmatter/);
	});

	it("rejects an unparseable generated description (unclosed quote in title)", () => {
		// skillNameOf normalizes ids (underscore → dash), so a rendered name
		// is always kebab-case; the remaining rendered-frontmatter failure is
		// an unparseable description, e.g. a title opening a quote it never
		// closes (the YAML-subset parser rejects it like the platform would).
		const md = renderSkillMarkdown(skillEntry({ title: '"unclosed' }));
		const problems = validateRenderedSkillMarkdown(md);
		expect(problems.join(" ")).toMatch(/invalid YAML frontmatter/);
	});

	it("rejects a missing description", () => {
		// Renderer falls back to a content routing hint; with neither title nor
		// content there is nothing to route on and the description stays empty.
		const md = renderSkillMarkdown(skillEntry({ title: "", content: "" }));
		const problems = validateRenderedSkillMarkdown(md);
		expect(problems.join(" ")).toMatch(/requires non-empty `description`/);
	});

	it("rejects legacy camelCase keys", () => {
		const md = "---\nname: x\ndescription: y\ndisableModelInvocation: true\n---\n\nbody";
		const problems = validateRenderedSkillMarkdown(md);
		expect(problems.join(" ")).toMatch(/legacy key "disableModelInvocation"/);
	});

	it("rejects bad invocation boolean spellings", () => {
		const md = "---\nname: x\ndescription: y\ndisable-model-invocation: maybe\n---\n\nbody";
		const problems = validateRenderedSkillMarkdown(md);
		expect(problems.join(" ")).toMatch(/must be a boolean/);
	});

	it("accepts all accepted boolean spellings", () => {
		for (const spelling of ["true", "false", "yes", "no", "on", "off", "1", "0"]) {
			const md = `---\nname: x\ndescription: y\nuser-invocable: ${spelling}\n---\n\nbody`;
			expect(validateRenderedSkillMarkdown(md)).toEqual([]);
		}
	});

	it("rejects an empty whenToUse and a non-object metadata", () => {
		const md = "---\nname: x\ndescription: y\nwhenToUse: \nmetadata: [1]\n---\n\nbody";
		const problems = validateRenderedSkillMarkdown(md);
		expect(problems.join(" ")).toMatch(/whenToUse/);
		expect(problems.join(" ")).toMatch(/metadata/);
	});

	it("rejects unparseable YAML", () => {
		const md = "---\nname: x\ndescription: y\n  indented: bad\n---\n\nbody";
		const problems = validateRenderedSkillMarkdown(md);
		expect(problems.join(" ")).toMatch(/invalid YAML frontmatter/);
	});

	it("tolerates CRLF line endings", () => {
		const md = "---\r\nname: x\r\ndescription: y\r\n---\r\n\r\nbody";
		expect(validateRenderedSkillMarkdown(md)).toEqual([]);
	});
});

describe("skillResourceRefs", () => {
	it("collects markdown link and prose resource references", () => {
		const refs = skillResourceRefs("See [examples](references/examples.md) and `scripts/run.mjs`.");
		expect(refs).toContain("references/examples.md");
		expect(refs).toContain("scripts/run.mjs");
	});

	it("skips parent-relative and generic enumeration targets", () => {
		const refs = skillResourceRefs("See `../skill-creator/references/template.md` and the references/scripts/agents categories.");
		expect(refs).toEqual([]);
	});
});

describe("syncSkillsFromResult materialization warnings", () => {
	it("warns about dangling resource references without failing the write", () => {
		const root = tmpRoot();
		try {
			const entry = skillEntry({ content: "See `references/examples.md`." });
			const result: RefinementResult = {
				id: "r1",
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				appliedEdits: [{ action: "create", kind: "skill", id: entry.id, title: "t", content: "c", applied: true, after: entry }],
				harnessStatePath: "",
			};
			const warnings = syncSkillsFromResult(root, result);
			expect(warnings.join("\n")).toMatch(/references missing resource references\/examples\.md/);
			// the file still materialized
			expect(warnings.join("\n")).toContain("my_skill");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("warns when the rendered SKILL.md would be ignored by the platform", () => {
		const root = tmpRoot();
		try {
			const entry = skillEntry({ title: '"unclosed' });
			const result: RefinementResult = {
				id: "r2",
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				appliedEdits: [{ action: "create", kind: "skill", id: entry.id, title: "t", content: "c", applied: true, after: entry }],
				harnessStatePath: "",
			};
			const warnings = syncSkillsFromResult(root, result);
			expect(warnings.join("\n")).toMatch(/would be ignored by the platform/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
