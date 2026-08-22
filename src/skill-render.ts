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

/**
 * First content line usable as a routing hint: non-empty, not a Markdown
 * heading, not a list marker, not frontmatter. Undefined when the body is
 * effectively empty.
 */
function routingHint(content: string): string | undefined {
	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		if (line.startsWith("#") || line.startsWith("---") || line.startsWith("-") || line.startsWith("*")) continue;
		return oneLine(line);
	}
	return undefined;
}

/** Max rendered frontmatter description length (loaders truncate anyway). */
const MAX_DESCRIPTION_LENGTH = 240;

/**
 * Render a harness skill entry as a discoverable SKILL.md document.
 *
 * 2026-08-22: the frontmatter description now carries a ROUTING HINT —
 * title plus the first meaningful content line — instead of the bare title.
 * The skill catalog matches on description; a title-only description gave
 * loaders nothing to route on (observed: materialized skills were 7-line
 * stubs with a one-line description and no use-when signal).
 */
export function renderSkillMarkdown(entry: HarnessEntry): string {
	const hint = routingHint(entry.content);
	const base = oneLine(entry.title);
	let description: string;
	if (base.length === 0) {
		description = (hint ?? "").slice(0, MAX_DESCRIPTION_LENGTH);
	} else if (hint !== undefined && !base.toLowerCase().includes(hint.toLowerCase())) {
		description = `${base} — use when: ${hint}`.slice(0, MAX_DESCRIPTION_LENGTH);
	} else {
		description = base.slice(0, MAX_DESCRIPTION_LENGTH);
	}
	const lines = [
		"---",
		`name: ${skillNameOf(entry.id)}`,
		`description: ${description}`,
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
