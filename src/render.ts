/**
 * Prompt rendering: bounded, model-visible views of harness state and
 * refinement history. Every cap exists to keep token cost predictable no
 * matter how large the store grows.
 */
import type { HarnessEntry, HarnessRefinementEvent, HarnessState, RefinementResult } from "./types.js";
import { SOURCE_SESSION_KEY, SOURCE_SEQS_KEY, isArchived } from "./types.js";

const DEFAULT_MAX_ENTRIES_PER_KIND = 6;
const DEFAULT_MAX_REFINEMENTS = 5;
const DEFAULT_MAX_CONTENT_LENGTH = 180;

export function compactText(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function entryLine(entry: HarnessEntry, maxContentLength: number): string {
	const argumentsText =
		entry.kind === "skill" && Object.keys(entry.arguments).length > 0
			? ` args=${compactText(JSON.stringify(entry.arguments), maxContentLength)}`
			: "";
	const referenceText =
		entry.kind === "skill" && Object.keys(entry.reference).length > 0
			? ` ref=${compactText(JSON.stringify(entry.reference), maxContentLength)}`
			: "";
	const citationText = citationSuffix(entry);
	const archivedText = isArchived(entry) ? " [archived]" : "";
	return `- [${entry.scope}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${archivedText}${referenceText}${argumentsText}${citationText}: ${compactText(entry.content, maxContentLength)}`;
}

/** Trajectory citation suffix (` src=sessionId:1,2`), empty when uncited. */
function citationSuffix(entry: HarnessEntry): string {
	const sessionId = entry.metadata[SOURCE_SESSION_KEY];
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		return "";
	}
	const seqs = entry.metadata[SOURCE_SEQS_KEY];
	const seqText = Array.isArray(seqs) && seqs.length > 0 ? `:${seqs.join(",")}` : "";
	return ` src=${sessionId}${seqText}`;
}

/** Render the full merged state as a bounded overview for the system prompt. */
export function formatHarnessStateForPrompt(state: HarnessState): string {
	const lines: string[] = [
		"# Continual Harness State",
		"",
		"Local entries belong to this session. Global entries persist across sessions.",
		"The base system prompt is immutable; prompt entries are supplemental notes only.",
		"",
	];
	let total = 0;
	for (const kind of Object.keys(state.entries) as (keyof HarnessState["entries"])[]) {
		const entries = Object.values(state.entries[kind]).sort((a, b) =>
			[a.path, a.title, a.id].join("\0").localeCompare([b.path, b.title, b.id].join("\0")),
		);
		total += entries.length;
		lines.push(`${kind}: ${entries.length}`);
		for (const entry of entries.slice(0, DEFAULT_MAX_ENTRIES_PER_KIND)) {
			lines.push(entryLine(entry, DEFAULT_MAX_CONTENT_LENGTH));
		}
		const overflow = entries.length - Math.min(entries.length, DEFAULT_MAX_ENTRIES_PER_KIND);
		if (overflow > 0) {
			lines.push(`- +${overflow} more ${kind} entries`);
		}
		lines.push("");
	}
	if (total === 0) {
		lines.push("No saved harness entries yet.", "");
	}
	lines.push(`recent refinements: ${state.refinements.length}`);
	for (const event of state.refinements.slice(-DEFAULT_MAX_REFINEMENTS)) {
		lines.push(`- [${event.id}] ${compactText(event.trigger, DEFAULT_MAX_CONTENT_LENGTH)}: ${event.changes.join(", ") || "no applied edits"}`);
	}
	return lines.join("\n").trim();
}

/** Render recent refinement results for the planner. */
export function historyForPrompt(history: readonly RefinementResult[]): string {
	if (history.length === 0) {
		return "No prior refinement history.";
	}
	return history
		.slice(-20)
		.map((item) => {
			const edits = item.appliedEdits.map((e) => `${e.applied ? "applied" : "failed"} ${e.action} ${e.kind}:${e.id}`).join(", ");
			const rollback = item.rollbackOf ? ` rollbackOf=${item.rollbackOf}` : "";
			return `[${item.id}]${rollback} ${item.summary}\n${edits}\nExpected outcome: ${item.expectedOutcome}`;
		})
		.join("\n\n");
}

/** Serialize a refinement event for persistence (lightweight). */
export function eventToLine(event: HarnessRefinementEvent): string {
	return JSON.stringify(event);
}
