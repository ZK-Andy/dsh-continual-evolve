import { describe, expect, it } from "vitest";
import {
	globalSkillsDir,
	MAX_SKILL_DESCRIPTION_LENGTH,
	projectSkillsDir,
	renderSkillMarkdown,
	SKILL_GENERATED_MARKER,
	skillDir,
	skillFieldGateReasons,
	SKILL_SCOPES,
	validateRenderedSkill,
} from "../src/skill-rules.js";
import { isValidMemoryId, slugifyId } from "../src/memory-rules.js";

const FIELDS = { title: "Deploy checklist", description: "pre-release steps", body: "1. build\n2. verify\n3. publish" };

describe("skill field gates", () => {
	it("accepts a complete record", () => {
		expect(skillFieldGateReasons(FIELDS)).toEqual([]);
	});

	it("rejects empty fields and oversized bodies", () => {
		expect(skillFieldGateReasons({ ...FIELDS, title: "  " })[0]).toMatch("title must not be empty");
		expect(skillFieldGateReasons({ ...FIELDS, description: "" })[0]).toMatch("description must not be empty");
		expect(skillFieldGateReasons({ ...FIELDS, body: " " })[0]).toMatch("body must not be empty");
		expect(skillFieldGateReasons({ ...FIELDS, body: "x".repeat(65_537) })[0]).toMatch("body exceeds");
		expect(skillFieldGateReasons({ ...FIELDS, title: "t".repeat(201) })[0]).toMatch("title exceeds");
		expect(skillFieldGateReasons({ ...FIELDS, description: "d".repeat(501) })[0]).toMatch("description exceeds");
	});

	it("screens secrets across every field", () => {
		expect(skillFieldGateReasons({ ...FIELDS, body: "key is ghp_12345678901234567890" })[0]).toMatch("possible GitHub token");
		expect(skillFieldGateReasons({ title: "sk-ant-1234567890123456 here", description: "d", body: "b" })[0]).toMatch("possible Anthropic");
	});

	it("reuses the memory id shape and slug fallback", () => {
		expect(isValidMemoryId("deploy-checklist")).toBe(true);
		expect(isValidMemoryId("Deploy_Checklist")).toBe(false);
		expect(slugifyId("部署清单")).toMatch(/^m-[0-9a-f]{8}$/);
		expect(slugifyId("Deploy Checklist")).toBe("deploy-checklist");
	});
});

describe("SKILL.md rendering", () => {
	it("renders frontmatter with the author's description and the generated marker", () => {
		const text = renderSkillMarkdown({ id: "deploy-checklist", ...FIELDS });
		const lines = text.split("\n");
		expect(lines[0]).toBe("---");
		expect(lines[1]).toBe("name: deploy-checklist");
		expect(lines[2]).toBe("description: pre-release steps");
		expect(lines[3]).toBe("---");
		expect(text).toContain(SKILL_GENERATED_MARKER);
		expect(text.endsWith("3. publish\n")).toBe(true);
	});

	it("falls back to title plus routing hint when the description is blank", () => {
		const text = renderSkillMarkdown({ id: "x", title: "Deploy checklist", description: "   ", body: "# head\nrun book then verify" });
		expect(text).toContain("description: Deploy checklist — use when: run book then verify");
	});

	it("uses the first meaningful body line as the hint, skipping headings and lists", () => {
		const text = renderSkillMarkdown({ id: "x", title: "t", description: "", body: "# Title\n- item\n---\nreal first line" });
		expect(text).toContain("description: t — use when: real first line");
	});

	it("keeps the rendered description within the loader limit", () => {
		const text = renderSkillMarkdown({ id: "x", title: "t".repeat(300), description: "", body: "b" });
		const description = text.split("\n")[2] ?? "";
		expect(description.length).toBeLessThanOrEqual(`description: `.length + MAX_SKILL_DESCRIPTION_LENGTH);
	});
});

describe("rendered validation", () => {
	it("accepts a well-formed skill", () => {
		expect(validateRenderedSkill({ id: "deploy-checklist", description: "does things" })).toEqual([]);
	});

	it("flags names the loader ignores and unusable descriptions", () => {
		expect(validateRenderedSkill({ id: "Bad_Name", description: "d" })[0]).toMatch("kebab-case");
		expect(validateRenderedSkill({ id: "ok", description: "  " })[0]).toMatch("empty description");
		expect(validateRenderedSkill({ id: "ok", description: "d".repeat(MAX_SKILL_DESCRIPTION_LENGTH + 1) })[0]).toMatch("exceeds");
		expect(validateRenderedSkill({ id: "ok", description: "one\ntwo" })[0]).toMatch("spans lines");
	});
});

describe("skill directories", () => {
	it("materializes projects under the workspace and globals under DSH home", () => {
		expect(projectSkillsDir("/ws/a")).toContain(".agents");
		expect(projectSkillsDir("/ws/a").endsWith("skills")).toBe(true);
		expect(globalSkillsDir().endsWith("skills")).toBe(true);
	});

	it("contains skill directories inside their root", () => {
		expect(skillDir("/ws/a/.agents/skills", "deploy-checklist").endsWith("deploy-checklist")).toBe(true);
		expect(() => skillDir("/ws/a/.agents/skills", "../escape")).toThrow("escapes skills root");
	});

	it("exports the scope vocabulary", () => {
		expect([...SKILL_SCOPES].sort()).toEqual(["global", "project"]);
	});
});
