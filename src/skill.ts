/**
 * Skill materializer: syncs skill-kind harness entries to the DSH skills
 * filesystem (`$DSH_HOME/skills/<kebab-name>/SKILL.md`) so the `skill` tool
 * and catalog can discover and load them. Writes are atomic (tmp + rename)
 * so the filesystem watcher never sees a partial file.
 *
 * Skill names must be kebab-case (the harness store ids are underscore slugs;
 * the materialized name converts `_` → `-`).
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { HarnessEntry, RefinementResult } from "./types.js";

/** Convert a harness entry id (underscore slug) to a kebab-case skill name. */
export function skillNameOf(id: string): string {
	return id.toLowerCase().replace(/_/g, "-");
}

/** Resolve and defend the skill directory for an entry id. */
export function skillDir(skillsRoot: string, id: string): string {
	const root = resolve(skillsRoot);
	const dir = resolve(join(root, skillNameOf(id)));
	if (dir !== root && !dir.startsWith(`${root}/`) && !dir.startsWith(`${root}${sep}`)) {
		throw new Error(`skill path escapes skills root: ${dir}`);
	}
	return dir;
}

/** Render a harness skill entry as a discoverable SKILL.md document. */
export function renderSkillMarkdown(entry: HarnessEntry): string {
	const lines = [
		"---",
		`name: ${skillNameOf(entry.id)}`,
		`description: ${oneLine(entry.title)}`,
		"---",
		"",
		entry.content.trim(),
	];
	const reference = entry.reference;
	if (reference && typeof reference === "object" && Object.keys(reference).length > 0) {
		lines.push("", "## Invocation");
		for (const [key, value] of Object.entries(reference)) {
			lines.push(`- ${key}: ${JSON.stringify(value)}`);
		}
	}
	if (Object.keys(entry.arguments).length > 0) {
		lines.push("", "## Arguments", "```json", JSON.stringify(entry.arguments, null, 2), "```");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/** Apply the skill-kind edits of an applied refinement to the skills root. */
export function syncSkillsFromResult(skillsRoot: string, result: RefinementResult): void {
	for (const edit of result.appliedEdits) {
		if (edit.kind !== "skill" || !edit.applied) continue;
		if (edit.action === "delete" || !edit.after) {
			removeSkill(skillsRoot, edit.id);
			continue;
		}
		writeSkill(skillsRoot, edit.after);
	}
}

function writeSkill(skillsRoot: string, entry: HarnessEntry): void {
	const dir = skillDir(skillsRoot, entry.id);
	mkdirSync(dir, { recursive: true });
	const temp = join(dir, `SKILL.md.${process.pid}.tmp`);
	writeFileSync(temp, renderSkillMarkdown(entry), "utf8");
	renameSync(temp, join(dir, "SKILL.md"));
}

function removeSkill(skillsRoot: string, id: string): void {
	const dir = skillDir(skillsRoot, id);
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true });
	}
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
