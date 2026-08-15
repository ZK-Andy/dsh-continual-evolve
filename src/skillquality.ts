/**
 * Skill-quality integration: makes the official DSH skill standard
 * (skill-creator / skill-audit) usable INSIDE the self-evolution loop.
 *
 * The planner and review gate are raw `ctx.llm` calls — they do not live in
 * an agent session, so they cannot load skills through the `skill` tool.
 * The official skills stay the single source of truth on disk; this module
 * only:
 *
 * 1. reads the official template facts at runtime
 *    (`<skillsRoot>/skill-creator/references/template.md`, 85 lines) and
 *    hands them to the planner as a `<skill_quality_standard>` block —
 *    the official file wins, a built-in distilled guide is the fallback for
 *    installs without the official skills;
 * 2. code-enforces the mechanical frontmatter rules of
 *    `skill-creator/scripts/validate-frontmatter.mjs` (the platform would
 *    IGNORE a file that fails them), so a skill entry can never materialize
 *    a SKILL.md the platform refuses to load.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEntry } from "./types.js";
import { renderSkillMarkdown, skillNameOf } from "./skill.js";

/** Skill-name regex the platform enforces (skill-filesystem). */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TRUE_WORDS = new Set(["true", "yes", "on", "1"]);
const FALSE_WORDS = new Set(["false", "no", "off", "0"]);
const LEGACY_KEYS = ["disableModelInvocation", "modelInvocable", "userInvocable"];
const CANONICAL_KEYS: Record<string, string> = {
	disableModelInvocation: "disable-model-invocation",
	modelInvocable: "disable-model-invocation",
	userInvocable: "user-invocable",
};

/** Relative location of the official skill-creator template facts. */
export const SKILL_CREATOR_TEMPLATE_REL = join("skill-creator", "references", "template.md");

/**
 * Read the official skill-creator template facts
 * (`<skillsRoot>/skill-creator/references/template.md`). Returns null when
 * the official skills are not installed — callers fall back to the builtin
 * distilled guide. Reading is a runtime reference, never a copy: template
 * updates in the official skill are picked up automatically.
 */
export function readSkillCreatorTemplate(skillsRoot: string): string | null {
	const path = join(skillsRoot, SKILL_CREATOR_TEMPLATE_REL);
	try {
		if (!existsSync(path)) return null;
		const text = readFileSync(path, "utf8");
		return text.trim().length > 0 ? text : null;
	} catch {
		return null;
	}
}

/**
 * Builtin distilled skill-quality guide (fallback when the official
 * skill-creator template is not installed). Condenses the official template
 * facts — frontmatter schema, the 7 structural features, paragraph skeleton,
 * and the no-duplication / real-trigger rules — so a planner still authors
 * skills to the official standard on installs without the official skills.
 */
export const BUILTIN_SKILL_QUALITY_GUIDE = `DSH skill quality standard (distilled from the official skill-creator template; the full facts live in <skillsRoot>/skill-creator/references/template.md when installed):

Frontmatter schema (platform-enforced; violations make the platform IGNORE the whole file):
- name: required, kebab-case only (^[a-z0-9]+(?:-[a-z0-9]+)*$)
- description: required, non-empty; write "use when / do not use when" routing so the model can select it correctly
- invocation booleans accept true/false/yes/no/on/off/1/0; legacy camelCase keys (disableModelInvocation / modelInvocable / userInvocable) are rejected
- whenToUse (optional): non-empty string; metadata (optional): object

The 7 structural features of good official skills:
1. Frontmatter is routing metadata, not a summary (description = when to use / when not to use)
2. Opens with a boundary declaration (guidance, not a script; mechanical flow skills may omit the disclaimer)
3. Prerequisites + exclusions: explicit required input, stop when missing (report the required input and stop), excluded scenarios
4. Layered information: Sources of truth (link only, do not re-summarize) -> numbered blocking requirements -> manual checks -> verification commands -> report format; all executable, no slogans
5. Skill interlinks: reference a single source of truth instead of duplicating it
6. Verifiable completion criteria: explicit verification commands and report format
7. Real use + iteration: a real trigger scenario must exist; calibration conclusions distill into references/

Paragraph skeleton (writing order): frontmatter -> H1 + boundary declaration -> Sources of truth -> numbered requirements / workflow (full commands) -> exclusions / stop conditions -> verification and report.

Creation rules: only create a skill for a REAL trigger scenario (who, in what real task, what signal) grounded in the trajectory — never invent one to pad the store; do not duplicate the official 11 skills or existing entries; skill bodies should be a SKILL.md document (this is what materializes under <skillsRoot>/<kebab-name>/SKILL.md).`;

export interface SkillQualityGuide {
	/** Where the guide text came from. */
	source: "official" | "builtin";
	text: string;
}

/**
 * The quality guide handed to the planner: the official skill-creator
 * template facts when the official skills are installed, otherwise the
 * builtin distilled guide. Never throws — a missing/unreadable template
 * degrades to the builtin.
 */
export function skillQualityGuide(skillsRoot: string | undefined): SkillQualityGuide {
	if (skillsRoot) {
		const official = readSkillCreatorTemplate(skillsRoot);
		if (official !== null) {
			return {
				source: "official",
				text: `The official skill-creator template facts (single source of truth, read from <skillsRoot>/skill-creator/references/template.md):\n\n${official}`,
			};
		}
	}
	return { source: "builtin", text: BUILTIN_SKILL_QUALITY_GUIDE };
}

/** Split frontmatter out of a raw SKILL.md. Returns { yaml, body } or null when delimiters are missing. */
export function splitFrontmatter(raw: string): { yaml: string; body: string } | null {
	const lines = raw.split(/\r?\n/);
	if (lines[0] !== "---") return null;
	const close = lines.indexOf("---", 1);
	if (close < 0) return null;
	return { yaml: lines.slice(1, close).join("\n"), body: lines.slice(close + 1).join("\n") };
}

/** Parse one scalar in the YAML subset the platform's schema keys use. */
function parseScalar(raw: string, lineNo: number): string {
	const value = raw.trim();
	if (value === "") return "";
	if (value.startsWith("'")) {
		if (!value.endsWith("'")) throw new Error(`unterminated single-quoted scalar at line ${lineNo}`);
		return value.slice(1, -1).replace(/''/g, "'");
	}
	if (value.startsWith('"')) {
		if (!value.endsWith('"')) throw new Error(`unterminated double-quoted scalar at line ${lineNo}`);
		return value
			.slice(1, -1)
			.replace(/\\n/g, "\n")
			.replace(/\\t/g, "\t")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}
	return value;
}

/** Minimal YAML-subset parser for the flat schema the platform reads (mirrors validate-frontmatter.mjs). */
function parseMiniYaml(text: string): Record<string, unknown> {
	const data: Record<string, unknown> = {};
	const lines = text.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		const lineNo = i + 1;
		i += 1;
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		if (line.length - line.trimStart().length > 0) {
			throw new Error(`unsupported indented construct at line ${lineNo}: ${trimmed}`);
		}
		const match = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(trimmed);
		if (!match) throw new Error(`unparseable line ${lineNo}: ${trimmed}`);
		const key = match[1] ?? "";
		let value = match[2] ?? "";
		if (value === "|" || value === ">") {
			const block: string[] = [];
			while (i < lines.length && (lines[i] ?? "").trim() !== "" && (lines[i] ?? "").startsWith(" ")) {
				block.push(lines[i] ?? "");
				i += 1;
			}
			data[key] = block.join("\n");
			continue;
		}
		if (value === "" && i < lines.length && (lines[i] ?? "").startsWith(" ") && (lines[i] ?? "").trim() !== "") {
			const nested: Record<string, unknown> = {};
			while (i < lines.length && (lines[i] ?? "").trim() !== "" && (lines[i] ?? "").startsWith(" ")) {
				const nm = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec((lines[i] ?? "").trim());
				if (!nm) throw new Error(`unparseable nested line ${i + 1}: ${(lines[i] ?? "").trim()}`);
				nested[nm[1] ?? ""] = parseScalar(nm[2] ?? "", i + 1);
				i += 1;
			}
			data[key] = nested;
			continue;
		}
		data[key] = parseScalar(value, lineNo);
	}
	return data;
}

/**
 * Mechanical frontmatter validation of a rendered SKILL.md, mirroring
 * `skill-creator/scripts/validate-frontmatter.mjs` (and the platform's
 * skill-filesystem rules): delimiter structure, name kebab-case, non-empty
 * description, invocation-boolean spellings, legacy camelCase key rejection,
 * whenToUse/metadata types. Returns human-readable problems; an empty array
 * means the file would load.
 */
export function validateRenderedSkillMarkdown(markdown: string): string[] {
	const problems: string[] = [];
	const split = splitFrontmatter(markdown);
	if (!split) {
		return [
			"missing YAML frontmatter (first line `---` with a closing `---`) — platform would IGNORE this file",
		];
	}
	let data: Record<string, unknown>;
	try {
		data = parseMiniYaml(split.yaml);
	} catch (cause) {
		return [`invalid YAML frontmatter: ${cause instanceof Error ? cause.message : String(cause)} — platform would IGNORE this file`];
	}

	const name = typeof data["name"] === "string" && data["name"].length > 0 ? data["name"] : undefined;
	if (name === undefined) {
		problems.push("frontmatter requires non-empty `name` — platform would IGNORE this file");
	} else if (!NAME_RE.test(name)) {
		problems.push(`invalid skill name "${name}" (must match ${NAME_RE}) — platform would IGNORE this file`);
	}
	const description = typeof data["description"] === "string" && data["description"].length > 0 ? data["description"] : undefined;
	if (description === undefined) {
		problems.push("frontmatter requires non-empty `description` — platform would IGNORE this file");
	}
	for (const legacy of LEGACY_KEYS) {
		if (Object.hasOwn(data, legacy)) {
			problems.push(`legacy key "${legacy}" is unsupported; use "${CANONICAL_KEYS[legacy]}" — platform would IGNORE this file`);
		}
	}
	for (const key of ["disable-model-invocation", "user-invocable"]) {
		if (!Object.hasOwn(data, key)) continue;
		const value = data[key];
		if (typeof value === "boolean") continue;
		const word = String(value).toLowerCase();
		if (TRUE_WORDS.has(word) || FALSE_WORDS.has(word)) continue;
		problems.push(
			`frontmatter field "${key}" must be a boolean (accepted: true/false/yes/no/on/off/1/0), got ${JSON.stringify(value)} — platform would IGNORE this file`,
		);
	}
	if (Object.hasOwn(data, "whenToUse") && !(typeof data["whenToUse"] === "string" && data["whenToUse"].length > 0)) {
		problems.push("`whenToUse` must be a non-empty string when present");
	}
	if (Object.hasOwn(data, "metadata") && (typeof data["metadata"] !== "object" || data["metadata"] === null || Array.isArray(data["metadata"]))) {
		problems.push("`metadata` must be an object when present");
	}
	return problems;
}

/**
 * Mechanical validation of a skill entry's raw `content` (the SKILL.md body
 * that materializes under the generated frontmatter). Code-enforced at
 * apply time so a bad entry never reaches the store:
 * - empty content is rejected;
 * - content must not open with a `---` block: the materializer generates
 *   its own frontmatter, and a second frontmatter in the body would be
 *   parsed instead of the generated one (the platform reads the FIRST
 *   closing `---`), so the file could be ignored or routed wrongly;
 * - resource references (`references/…`, `scripts/…`) must be skill-local
 *   relative paths — parent-relative (`../`) or absolute targets escape the
 *   skill directory and are rejected.
 * Returns human-readable problems; an empty array means the content is
 * mechanically acceptable.
 */
export function validateSkillEntryContent(content: string): string[] {
	const problems: string[] = [];
	const trimmed = content.trim();
	if (trimmed.length === 0) {
		problems.push("skill content is empty");
		return problems;
	}
	if (trimmed.startsWith("---")) {
		problems.push(
			"skill content must not start with a `---` frontmatter block (the materializer generates frontmatter from id/title; a body-level `---` would shadow it and the platform could IGNORE the file)",
		);
	}
	for (const match of trimmed.matchAll(/(?<![\w])(references|scripts)\/[^\s)]+/g)) {
		const ref = match[0] ?? "";
		if (ref.startsWith("../") || ref.includes("/../") || ref.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(ref)) {
			problems.push(`skill content resource reference escapes the skill directory: ${ref}`);
		}
	}
	return problems;
}

/**
 * Validate the FULL rendered SKILL.md of an entry (generated frontmatter +
 * body) — the exact bytes that materialize on disk. Used as the final
 * code-enforced line after materialization; problems here mean the platform
 * would refuse to load the file.
 */
export function validateRenderedSkill(entry: HarnessEntry): string[] {
	return validateRenderedSkillMarkdown(renderSkillMarkdown(entry));
}

/**
 * Resource references (`references/…`, `scripts/…`) found in a skill body —
 * the same scanning policy as validate-frontmatter.mjs: markdown link
 * targets starting with the category, plus backticked/prose paths carrying
 * a filename extension. Used after materialization to warn about dangling
 * references (a body referencing a resource the entry never ships).
 */
export function skillResourceRefs(content: string): string[] {
	const refs = new Set<string>();
	for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
		const target = ((match[1] ?? "").trim().split(/\s+/)[0] ?? "").trim();
		if (/^(references|scripts)\/[\w./-]+$/.test(target) && !target.startsWith("../")) {
			refs.add(target);
		}
	}
	const stripped = content.replace(/\[[^\]]*\]\([^)]*\)/g, "");
	for (const match of stripped.matchAll(/(?<![\w])(references|scripts)\/[\w./-]+\.\w+/g)) {
		const path = match[0] ?? "";
		// Cross-skill interlinks (`../skill-creator/...`) resolve against the
		// sibling skill's directory, not this one — skip references whose
		// prose prefix walks up a directory (mirrors validate-frontmatter.mjs).
		let cursor = (match.index ?? 0) - 1;
		while (cursor >= 0 && /[\w./-]/.test(stripped[cursor] ?? "")) cursor -= 1;
		if (!stripped.slice(cursor + 1, match.index ?? 0).includes("..")) {
			refs.add(path);
		}
	}
	return [...refs];
}

/** Kebab-case name under which the entry materializes (exported for diagnostics). */
export { skillNameOf };
