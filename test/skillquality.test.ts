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
	splitFrontmatter,
	validateRenderedSkill,
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

describe("readSkillCreatorTemplate read failure", () => {
	it("returns null when the template path throws on read (EISDIR)", () => {
		const root = tmpRoot();
		try {
			const dir = join(root, "skill-creator", "references");
			mkdirSync(dir, { recursive: true });
			// A directory where the file should be: existsSync is true but
			// readFileSync throws, so the reader must degrade to null.
			mkdirSync(join(dir, "template.md"));
			expect(readSkillCreatorTemplate(root)).toBeNull();
			expect(skillQualityGuide(root).source).toBe("builtin");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("splitFrontmatter", () => {
	it("splits yaml and body on delimiters", () => {
		expect(splitFrontmatter("---\nname: x\n---\n\nbody")).toEqual({ yaml: "name: x", body: "\nbody" });
	});

	it("returns null without an opening delimiter", () => {
		expect(splitFrontmatter("name: x\n")).toBeNull();
	});

	it("returns null without a closing delimiter", () => {
		expect(splitFrontmatter("---\nname: x\n")).toBeNull();
	});
});

describe("validateRenderedSkillMarkdown quoted scalars", () => {
	it("accepts single-quoted scalars with an escaped quote", () => {
		const md = "---\nname: 'my-skill'\ndescription: 'Use it''s here'\n---\n\nbody";
		expect(validateRenderedSkillMarkdown(md)).toEqual([]);
	});

	it("accepts double-quoted scalars with escapes", () => {
		const md = '---\nname: "my-skill"\ndescription: "line1\\nline2\\t\\"q\\"\\\\"\n---\n\nbody';
		expect(validateRenderedSkillMarkdown(md)).toEqual([]);
	});

	it("rejects an unterminated single-quoted scalar", () => {
		const md = "---\nname: 'oops\ndescription: y\n---\n\nbody";
		expect(validateRenderedSkillMarkdown(md).join(" ")).toMatch(/invalid YAML frontmatter/);
	});

	it("rejects an unterminated double-quoted scalar", () => {
		const md = '---\nname: "oops\ndescription: y\n---\n\nbody';
		expect(validateRenderedSkillMarkdown(md).join(" ")).toMatch(/invalid YAML frontmatter/);
	});
});

describe("validateRenderedSkillMarkdown yaml subset", () => {
	it("skips blank lines and comment lines", () => {
		const md = "---\n# a comment\n\nname: x\n\n# another\ndescription: y\n---\n\nbody";
		expect(validateRenderedSkillMarkdown(md)).toEqual([]);
	});

	it("accepts literal and folded block scalars", () => {
		expect(validateRenderedSkillMarkdown("---\nname: x\ndescription: |\n  line1\n  line2\n---\n\nbody")).toEqual([]);
		expect(validateRenderedSkillMarkdown("---\nname: x\ndescription: >\n  line1\n  line2\n---\n\nbody")).toEqual([]);
	});

	it("accepts a nested metadata object", () => {
		const md = "---\nname: x\ndescription: y\nmetadata:\n  owner: team\n  level: 1\n---\n\nbody";
		expect(validateRenderedSkillMarkdown(md)).toEqual([]);
	});

	it("accepts a nested key with an empty value", () => {
		const md = "---\nname: x\ndescription: y\nmetadata:\n  owner:\n  level: 1\n---\n\nbody";
		expect(validateRenderedSkillMarkdown(md)).toEqual([]);
	});

	it("rejects an unparseable nested line", () => {
		const md = "---\nname: x\ndescription: y\nmetadata:\n  not a mapping!!\n---\n\nbody";
		expect(validateRenderedSkillMarkdown(md).join(" ")).toMatch(/invalid YAML frontmatter/);
	});

	it("rejects an unparseable top-level line", () => {
		const md = "---\nname: x\njust words here\ndescription: y\n---\n\nbody";
		expect(validateRenderedSkillMarkdown(md).join(" ")).toMatch(/invalid YAML frontmatter/);
	});
});

describe("validateRenderedSkillMarkdown name and routing fields", () => {
	it("rejects a missing name", () => {
		const md = "---\ndescription: y\n---\n\nbody";
		expect(validateRenderedSkillMarkdown(md).join(" ")).toMatch(/requires non-empty `name`/);
	});

	it("rejects a non-kebab name", () => {
		const md = "---\nname: Bad_Name\ndescription: y\n---\n\nbody";
		expect(validateRenderedSkillMarkdown(md).join(" ")).toMatch(/invalid skill name/);
	});

	it("accepts capitalized boolean spellings", () => {
		for (const spelling of ["True", "FALSE", "Yes", "NO", "On", "OFF"]) {
			const md = `---\nname: x\ndescription: y\ndisable-model-invocation: ${spelling}\n---\n\nbody`;
			expect(validateRenderedSkillMarkdown(md)).toEqual([]);
		}
	});

	it("accepts a valid whenToUse", () => {
		const md = "---\nname: x\ndescription: y\nwhenToUse: Use when routing skills.\n---\n\nbody";
		expect(validateRenderedSkillMarkdown(md)).toEqual([]);
	});
});

describe("skillResourceRefs prose shapes", () => {
	it("collects a prose reference at the start of the string", () => {
		expect(skillResourceRefs("references/guide.md")).toEqual(["references/guide.md"]);
	});

	it("collects a dot-relative prose reference without flagging an escape", () => {
		expect(skillResourceRefs("see ./references/x.md for details")).toEqual(["references/x.md"]);
	});

	it("collects markdown links carrying a title plus a parenthesized prose path", () => {
		const refs = skillResourceRefs('See [guide](references/guide.md "Guide") and (scripts/run.mjs).');
		expect(refs).toContain("references/guide.md");
		expect(refs).toContain("scripts/run.mjs");
	});
});

describe("validateRenderedSkill entry materialization", () => {
	it("validates an executable entry through the materializer", () => {
		expect(validateRenderedSkill(skillEntry())).toEqual([]);
	});

	it("validates a guidance entry through the materializer", () => {
		const entry = skillEntry({ skill_kind: "guidance" });
		delete entry.reference;
		delete entry.arguments;
		expect(validateRenderedSkill(entry)).toEqual([]);
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
