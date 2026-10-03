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
 *
 * Split (2026-10-03 refactor): ranking lives in `injection-rank.ts`, the
 * entry directory in `injection-directory.ts`, shared caps in
 * `injection-caps.ts`; this module owns section rendering and the
 * three-store merge. Moved symbols are re-exported here so the public
 * surface stays on one module.
 */
import type { HarnessEntry, HarnessState } from "./types.js";
import { isArchived } from "./types.js";
import type { EvolutionEngine } from "./service.js";
import { mergeHarnessStates } from "./state.js";
import { projectKeyOf } from "./project.js";
import { entryLine } from "./render.js";
import { recordInjection } from "./usage.js";
import {
	recentUserText,
	rankEntries,
	type AgentLike,
} from "./injection-rank.js";
import { formatEntriesDirectoryRanked, rankedDirectoryEntries } from "./injection-directory.js";
import { MAX_INJECTED_ENTRIES_PER_KIND, MAX_INJECTED_CONTENT_LENGTH } from "./injection-caps.js";
import { DEFAULT_DIRECTORY_LINES } from "./injection-directory.js";

/** Compat surface: ranking + directory + caps moved out 2026-10-03. */
export { rankEntries, recencyScore, recentUserText, sessionEventsOf, tokenize } from "./injection-rank.js";
export type { AgentLike, UserMessageEventLike } from "./injection-rank.js";
export { RECENCY_HALF_LIFE_MS, MAX_QUERY_MESSAGES, MAX_QUERY_CHARS } from "./injection-rank.js";
export {
	directoryLine,
	formatEntriesDirectory,
	formatEntriesDirectoryCapped,
	formatEntriesDirectoryRanked,
	rankedDirectoryEntries,
	DEFAULT_DIRECTORY_LINES,
} from "./injection-directory.js";
export { MAX_INJECTED_ENTRIES_PER_KIND, MAX_INJECTED_CONTENT_LENGTH } from "./injection-caps.js";

/** How many `parentSession` hops a child walks to inherit entries. */
export const MAX_PARENT_CHAIN_DEPTH = 8;

/** The section-provider context shape we consume (subset of AssembleContext). */
export interface InjectContext {
	agent?: AgentLike;
}

/** True when the state carries at least one entry of any kind. */
export function hasAnyEntries(state: HarnessState): boolean {
	return Object.values(state.entries).some((byKind) => Object.keys(byKind).length > 0);
}

/** The additive prompt-notes block (empty when there are no visible prompt entries). */
export function formatPromptEntriesSection(entries: readonly HarnessEntry[], query?: string): string {
	const visible = entries.filter((entry) => !isArchived(entry));
	if (visible.length === 0) {
		return "";
	}
	const lines = [
		"# Continual Harness — Prompt Notes",
		"Supplemental prompt notes (the base system prompt is immutable). Use evolve_list for the full text of any note.",
	];
	for (const entry of rankEntries(visible, query).slice(0, MAX_INJECTED_ENTRIES_PER_KIND)) {
		lines.push(entryLine(entry, MAX_INJECTED_CONTENT_LENGTH));
	}
	const overflow = visible.length - Math.min(visible.length, MAX_INJECTED_ENTRIES_PER_KIND);
	if (overflow > 0) {
		lines.push(`- +${overflow} more prompt notes (evolve_list)`);
	}
	return lines.join("\n");
}

/** The reusable delegation-specs block (empty when there are no visible subagent entries). */
export function formatSubagentSpecsSection(entries: readonly HarnessEntry[], query?: string): string {
	const visible = entries.filter((entry) => !isArchived(entry));
	if (visible.length === 0) {
		return "";
	}
	const lines = [
		"# Continual Harness — Delegation Specs",
		"Reusable subagent specs: when you delegate work that matches a spec, assemble the child prompt from its content. Children inherit these specs through their parent chain.",
	];
	for (const entry of rankEntries(visible, query).slice(0, MAX_INJECTED_ENTRIES_PER_KIND)) {
		lines.push(entryLine(entry, MAX_INJECTED_CONTENT_LENGTH));
	}
	const overflow = visible.length - Math.min(visible.length, MAX_INJECTED_ENTRIES_PER_KIND);
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
 * The single three-store merge every injection path reads from: the global
 * store merged with this project's store (when the session cwd resolves one)
 * and the nearest carrying local store (precedence global < project < local —
 * see {@link mergeHarnessStates}). One home, so the memory section and the
 * entry directory can never disagree about what the model can see.
 */
export function mergedInjectionState(
	engine: EvolutionEngine,
	agent: AgentLike,
	opts?: { projectKey?: string },
): HarnessState {
	const globalState = engine.load("global", undefined);
	const projectKey = opts?.projectKey ?? projectKeyOf(agent);
	const projectState = projectKey ? engine.load("project", projectKey) : undefined;
	const localState = nearestLocalStateWithEntries(engine, agent);
	return mergeHarnessStates(globalState, localState, projectState ? { projectState } : undefined);
}

/**
 * Compose the full injected block for one assembling agent: global entries
 * merged with this project's store (when the session cwd resolves one) and
 * the nearest carrying local store (precedence global < project < local).
 * The optional `query` — when absent, derived from the agent's most recent
 * direct user messages — ranks which entries fill the per-kind cap
 * (relevance first, then recency; see {@link rankEntries}). Returns "" when
 * nothing is injectable — the prompt renderer then drops the section, so an
 * empty store adds zero tokens to every assembly.
 *
 * `opts.directoryLines` caps the entry-directory index (2026-08-22 throttle);
 * `opts.projectKey` pins the project layer explicitly (tests, tools) —
 * otherwise it is derived from the agent's session cwd, best-effort.
 * `opts.includeMemoryDirectory` (default true) drops memory lines from the
 * directory when the memory section already carries them (evolve v2) — one
 * fact, one home, so the same memories are never paid for twice.
 * Usage recording covers ALL kinds — memories and skills appear as directory
 * lines, prompts/subagents as content — and is deduped per session so the
 * counts read "how many sessions saw this", not "how many prompt builds".
 */
export function entriesSectionText(
	engine: EvolutionEngine,
	agent: AgentLike | undefined,
	query?: string,
	opts?: { directoryLines?: number; projectKey?: string; includeMemoryDirectory?: boolean },
): string {
	if (!agent) {
		return "";
	}
	const merged = mergedInjectionState(engine, agent, opts);
	const promptEntries = Object.values(merged.entries.prompt);
	const subagentEntries = Object.values(merged.entries.subagent);
	const relevanceQuery = (query ?? recentUserText(agent)).trim();

	// Build injected text and collect which entries were included (gap B1).
	const promptText = formatPromptEntriesSection(promptEntries, relevanceQuery);
	const subagentText = formatSubagentSpecsSection(subagentEntries, relevanceQuery);
	const injectedKeys = new Set<string>();

	// Collect keys from the visible (ranked, capped) entries that actually appear.
	const visiblePrompt = promptEntries.filter((e) => !isArchived(e));
	const visibleSubagent = subagentEntries.filter((e) => !isArchived(e));
	for (const entry of rankEntries(visiblePrompt, relevanceQuery).slice(0, MAX_INJECTED_ENTRIES_PER_KIND)) {
		injectedKeys.add(`prompt:${entry.id}`);
	}
	for (const entry of rankEntries(visibleSubagent, relevanceQuery).slice(0, MAX_INJECTED_ENTRIES_PER_KIND)) {
		injectedKeys.add(`subagent:${entry.id}`);
	}

	// Gap B3: lightweight directory of ALL entries (id+title, one line each).
	// Zero-cost index so the model knows what exists and can ask for full text.
	const directoryLines = opts?.directoryLines ?? DEFAULT_DIRECTORY_LINES;
	const promptKind = Object.values(merged.entries.prompt);
	const subagentKind = Object.values(merged.entries.subagent);
	// v2: memories live in their own content-carrying section, so the directory
	// stops listing them (passing [] keeps the positional contract intact).
	const memoryKind = (opts?.includeMemoryDirectory ?? true) ? Object.values(merged.entries.memory) : [];
	const skillKind = Object.values(merged.entries.skill);
	const directoryText = formatEntriesDirectoryRanked(directoryLines, relevanceQuery, promptKind, subagentKind, memoryKind, skillKind);

	// Directory-visible keys count too: a memory's injection IS its directory
	// line. Set semantics keep content-injected entries single-counted. Keys
	// come from the single display-ordered source (type hooks included), not
	// substring matching on the rendered text.
	for (const entry of rankedDirectoryEntries(directoryLines, relevanceQuery, promptKind, subagentKind, memoryKind, skillKind)) {
		injectedKeys.add(`${entry.kind}:${entry.id}`);
	}

	// Record usage durably (best-effort: failure never blocks injection).
	// Deduped per session — see recordInjection.
	if (injectedKeys.size > 0) {
		try {
			recordInjection(engine.baseDir, [...injectedKeys], agent.id);
		} catch {
			// Usage recording is diagnostic; never interrupt the injection path.
		}
	}

	const parts = [promptText, subagentText, directoryText].filter((part) => part.length > 0);
	return parts.join("\n\n");
}
