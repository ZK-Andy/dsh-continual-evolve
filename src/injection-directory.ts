/**
 * The entry directory: a lightweight one-line-per-entry index of ALL
 * non-archived entries across kinds, appended after the curated top-N
 * injection sections so the model has a zero-cost overview of what exists
 * and can ask for full text via `evolve_list`.
 */
import type { HarnessEntry } from "./types.js";
import { MEMORY_TYPE_KEY, isArchived, isMemoryType } from "./types.js";
import { rankEntries } from "./injection-rank.js";
import { MAX_INJECTED_ENTRIES_PER_KIND } from "./injection-caps.js";

/** Directory lines injected per build before folding into a counter. */
export const DEFAULT_DIRECTORY_LINES = 15;

/** One directory index line: memory lines carry their recall-type hook. */
export function directoryLine(entry: HarnessEntry): string {
	if (entry.kind === "memory") {
		const type = entry.metadata[MEMORY_TYPE_KEY];
		const hook = isMemoryType(type) ? `:${type}` : "";
		return `- [memory${hook}:${entry.id}] ${entry.title}`;
	}
	return `- [${entry.kind}:${entry.id}] ${entry.title}`;
}

/** Positional contract for the directory variadics: the first two arrays
 * must be the content-section kinds (prompt, subagent) — the redundancy
 * check counts exactly those as already visible. Callers pass
 * (prompt, subagent, memory, skill); any other order miscounts. */
const CONTENT_SECTION_KINDS = 2;

export function formatEntriesDirectory(
	...kindEntries: readonly HarnessEntry[][]
): string {
	return formatEntriesDirectoryCapped(DEFAULT_DIRECTORY_LINES, ...kindEntries);
}

/** {@link formatEntriesDirectory} with an explicit cap (configurable). */
export function formatEntriesDirectoryCapped(
	maxLines: number,
	...kindEntries: readonly HarnessEntry[][]
): string {
	return formatEntriesDirectoryRanked(maxLines, undefined, ...kindEntries);
}

/**
 * {@link formatEntriesDirectoryCapped} with a relevance query: entries are
 * ordered by {@link rankEntries} (relevance first, then recency) so the cap
 * folds the least relevant entries — never the dictionary tail. An empty
 * query degrades to the valence/recency/stable order, still deterministic.
 */
export function formatEntriesDirectoryRanked(
	maxLines: number,
	query: string | undefined,
	...kindEntries: readonly HarnessEntry[][]
): string {
	const total = kindEntries.flat().filter((e) => !isArchived(e)).length;
	if (total === 0) {
		return "";
	}
	// Suppressed (every entry already content-visible) renders as "" — the
	// prompt renderer then drops the section entirely.
	const shown = rankedDirectoryEntries(maxLines, query, ...kindEntries);
	if (shown.length === 0) {
		return "";
	}
	const lines = ["# Continual Harness — Entry Directory", "All entries (use evolve_list for full text of any entry):"];
	for (const entry of shown) {
		lines.push(directoryLine(entry));
	}
	const hidden = total - shown.length;
	if (hidden > 0) {
		lines.push(`- …and ${hidden} more entries (evolve_list for the full index)`);
	}
	return lines.join("\n");
}

/**
 * The directory entries actually shown under the cap, in display order —
 * the single source for both the rendered text and usage accounting (so a
 * memory's injection IS its directory line even with the `:type` hook).
 * Returns [] when the directory is suppressed or empty.
 */
export function rankedDirectoryEntries(
	maxLines: number,
	query: string | undefined,
	...kindEntries: readonly HarnessEntry[][]
): HarnessEntry[] {
	const allEntries = kindEntries.flat().filter((e) => !isArchived(e));
	if (allEntries.length === 0) {
		return [];
	}
	// Skip the directory only when EVERY entry is already content-visible.
	// Only the first two arrays (prompt, subagent) have curated sections —
	// memories and skills have NO content injection, so they are invisible
	// unless the directory lists them (pre-2026-08-22 the redundancy check
	// wrongly counted them as "already shown", hiding small stores entirely).
	const contentVisible = kindEntries
		.slice(0, CONTENT_SECTION_KINDS)
		.reduce((sum, entries) => sum + Math.min(entries.filter((e) => !isArchived(e)).length, MAX_INJECTED_ENTRIES_PER_KIND), 0);
	if (allEntries.length <= contentVisible) {
		return [];
	}
	return rankEntries(allEntries, query).slice(0, Math.max(maxLines, 1));
}
