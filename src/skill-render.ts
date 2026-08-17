/**
 * Skill rendering: pure functions that convert harness entries into
 * SKILL.md documents. Extracted from skill.ts to break the circular
 * dependency between skill.ts ↔ skillquality.ts.
 *
 * Both skill.ts (materializer) and skillquality.ts (validator) need
 * these rendering functions; importing from this shared leaf module
 * keeps the dependency graph acyclic.
 */
import type { HarnessEntry } from "./types.js";

/** Convert a harness entry id (underscore slug) to a kebab-case skill name. */
export function skillNameOf(id: string): string {
	return id.toLowerCase().replace(/_/g, "-");
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

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
