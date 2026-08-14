/**
 * Real prompt/spec injection: the dynamic system-prompt section that makes
 * `prompt` entries visible to the model without a tool call, and `subagent`
 * entries available as reusable delegation specs at the delegation seam.
 *
 * Design (design.md §7 Phase 2):
 * - the section text is a provider evaluated at every assembly with the
 *   assembling agent; a section that renders to "" is dropped by the prompt
 *   renderer, so an empty store costs zero tokens;
 * - prompt entries render as an additive section (the base system prompt is
 *   never touched); subagent entries render as delegation specs the parent
 *   follows when delegating, and are inherited by child agents through the
 *   `SessionHeader.parentSession` chain so a freshly spawned subagent carries
 *   its parent's specs without any provider wrapping;
 * - every cap mirrors render.ts (6 entries/kind, 180 chars/entry, stable
 *   sort), keeping the injected cost bounded no matter how the store grows;
 * - full text stays one `evolve_list` call away: the injected block is a
 *   summary index, not a duplicate of the store.
 */
import type { HarnessEntry, HarnessState } from "./types.js";
import type { EvolutionEngine } from "./service.js";
import { mergeHarnessStates } from "./state.js";
import { entryLine } from "./render.js";

/** Prompt sections render at most this many entries per kind. */
export const MAX_INJECTED_ENTRIES_PER_KIND = 6;
/** Per-entry content budget inside the injected block (matches render.ts). */
export const MAX_INJECTED_CONTENT_LENGTH = 180;
/** How many `parentSession` hops a child walks to inherit entries. */
export const MAX_PARENT_CHAIN_DEPTH = 8;

/** The minimal agent shape the section provider needs (duck-typed). */
export interface AgentLike {
	id: string;
	session?: {
		header?: {
			parentSession?: string;
		};
	};
}

/** The section-provider context shape we consume (subset of AssembleContext). */
export interface InjectContext {
	agent?: AgentLike;
}

function sortedEntries(entries: readonly HarnessEntry[]): HarnessEntry[] {
	return [...entries].sort((a, b) =>
		[a.path, a.title, a.id].join("\0").localeCompare([b.path, b.title, b.id].join("\0")),
	);
}

/** True when the state carries at least one entry of any kind. */
export function hasAnyEntries(state: HarnessState): boolean {
	return Object.values(state.entries).some((byKind) => Object.keys(byKind).length > 0);
}

/** The additive prompt-notes block (empty when there are no prompt entries). */
export function formatPromptEntriesSection(entries: readonly HarnessEntry[]): string {
	if (entries.length === 0) {
		return "";
	}
	const lines = [
		"# Continual Harness — Prompt Notes",
		"Supplemental prompt notes (the base system prompt is immutable). Use evolve_list for the full text of any note.",
	];
	for (const entry of sortedEntries(entries).slice(0, MAX_INJECTED_ENTRIES_PER_KIND)) {
		lines.push(entryLine(entry, MAX_INJECTED_CONTENT_LENGTH));
	}
	const overflow = entries.length - Math.min(entries.length, MAX_INJECTED_ENTRIES_PER_KIND);
	if (overflow > 0) {
		lines.push(`- +${overflow} more prompt notes (evolve_list)`);
	}
	return lines.join("\n");
}

/** The reusable delegation-specs block (empty when there are no subagent entries). */
export function formatSubagentSpecsSection(entries: readonly HarnessEntry[]): string {
	if (entries.length === 0) {
		return "";
	}
	const lines = [
		"# Continual Harness — Delegation Specs",
		"Reusable subagent specs: when you delegate work that matches a spec, assemble the child prompt from its content. Children inherit these specs through their parent chain.",
	];
	for (const entry of sortedEntries(entries).slice(0, MAX_INJECTED_ENTRIES_PER_KIND)) {
		lines.push(entryLine(entry, MAX_INJECTED_CONTENT_LENGTH));
	}
	const overflow = entries.length - Math.min(entries.length, MAX_INJECTED_ENTRIES_PER_KIND);
	if (overflow > 0) {
		lines.push(`- +${overflow} more delegation specs (evolve_list)`);
	}
	return lines.join("\n");
}

/**
 * Walk the parent-session chain from `agent` upward and return the nearest
 * session whose local store is non-empty, if any. Children inherit their
 * ancestor's prompt notes and delegation specs; the chain walk stops at the
 * first store that has entries (deep descendants do not re-inject ancestors
 * beyond the nearest carrying store).
 */
export function nearestLocalStateWithEntries(engine: EvolutionEngine, agent: AgentLike): HarnessState | undefined {
	let cursor: AgentLike | undefined = agent;
	for (let depth = 0; cursor !== undefined && depth < MAX_PARENT_CHAIN_DEPTH; depth += 1) {
		const state = engine.load("local", cursor.id);
		if (hasAnyEntries(state)) {
			return state;
		}
		cursor = cursor.session?.header?.parentSession
			? { id: cursor.session.header.parentSession }
			: undefined;
	}
	return undefined;
}

/**
 * Compose the full injected block for one assembling agent: global entries
 * merged with the nearest carrying local store (local wins on id collision).
 * Returns "" when nothing is injectable — the prompt renderer then drops the
 * section, so an empty store adds zero tokens to every assembly.
 */
export function entriesSectionText(engine: EvolutionEngine, agent: AgentLike | undefined): string {
	if (!agent) {
		return "";
	}
	const globalState = engine.load("global", undefined);
	const localState = nearestLocalStateWithEntries(engine, agent);
	const merged = localState ? mergeHarnessStates(globalState, localState) : globalState;
	const promptEntries = Object.values(merged.entries.prompt);
	const subagentEntries = Object.values(merged.entries.subagent);
	const parts = [formatPromptEntriesSection(promptEntries), formatSubagentSpecsSection(subagentEntries)].filter(
		(part) => part.length > 0,
	);
	return parts.join("\n\n");
}
