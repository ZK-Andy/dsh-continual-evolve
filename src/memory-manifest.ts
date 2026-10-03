/**
 * The frozen memory manifest: a deterministic snapshot view of every live
 * memory entry the extractor may see, plus its bounded serialization and
 * manifest-scoped search. Pure functions over harness state.
 */
import type { HarnessEntry, HarnessState } from "./types.js";
import { isArchived, isMemoryType, MEMORY_TYPE_KEY } from "./types.js";
import { tokenize } from "./search.js";
import { compactText } from "./render.js";

/** One manifest row is exactly one live memory entry. */
export type MemoryManifestEntry = HarnessEntry;

export function buildMemoryManifest(state: HarnessState): MemoryManifestEntry[] {
	return Object.values(state.entries.memory)
		.map((entry) => ({ ...entry, metadata: { ...entry.metadata }, reference: {}, arguments: {} }))
		.sort((a, b) => manifestOrder(a).localeCompare(manifestOrder(b), "en"));
}

/** Render a bounded manifest index; full bodies remain available through memory_search. */
export function formatMemoryManifest(entries: readonly MemoryManifestEntry[], maxChars = 8000): string {
	if (entries.length === 0) return "No saved memory entries yet.";
	const lines: string[] = [];
	let used = 0;
	for (const entry of entries) {
		const type = isMemoryType(entry.metadata[MEMORY_TYPE_KEY]) ? entry.metadata[MEMORY_TYPE_KEY] : "untyped";
		const archived = isArchived(entry) ? ", archived" : "";
		const line = `- [${entry.scope}:${entry.id}] ${entry.title} (memoryType=${type}, path=${entry.path}${archived}): ${compactText(entry.content, 240)}`;
		if (used + line.length + 1 > maxChars) break;
		lines.push(line);
		used += line.length + 1;
	}
	const omitted = entries.length - lines.length;
	if (omitted > 0) lines.push(`- +${omitted} more entries; use memory_search with a narrower query.`);
	return lines.join("\n");
}

/** Rank frozen manifest entries with CJK-aware token overlap and stable tie-breaking. */
export function searchMemoryManifest(
	entries: readonly MemoryManifestEntry[],
	query: string,
	maxResults = 8,
): MemoryManifestEntry[] {
	const queryTokens = new Set(tokenize(query));
	if (queryTokens.size === 0) return [];
	return entries
		.map((entry) => {
			const title = tokenize(entry.title);
			const body = tokenize(`${entry.content} ${entry.path} ${String(entry.metadata[MEMORY_TYPE_KEY] ?? "")}`);
			let score = 0;
			for (const token of queryTokens) {
				if (title.includes(token)) score += 2;
				if (body.includes(token)) score += 1;
			}
			if (`${entry.scope}:${entry.id}`.toLowerCase() === query.trim().toLowerCase()) score += 100;
			return { entry, score };
		})
		.filter((hit) => hit.score > 0)
		.sort((a, b) => b.score - a.score || manifestOrder(a.entry).localeCompare(manifestOrder(b.entry), "en"))
		.slice(0, maxResults)
		.map((hit) => hit.entry);
}

/** Inputs for one bounded background memory extraction loop. */
export function manifestResult(entry: MemoryManifestEntry): Record<string, unknown> {
	return {
		scope: entry.scope,
		id: entry.id,
		title: entry.title,
		content: entry.content,
		path: entry.path,
		memoryType: entry.metadata[MEMORY_TYPE_KEY],
		archived: isArchived(entry),
	};
}

function manifestOrder(entry: MemoryManifestEntry): string {
	const scope = entry.scope === "global" ? "0" : entry.scope === "project" ? "1" : "2";
	return `${scope}:${entry.id}:${entry.title}`;
}
