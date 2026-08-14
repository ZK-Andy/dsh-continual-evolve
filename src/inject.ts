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
import { isArchived } from "./types.js";
import type { EvolutionEngine } from "./service.js";
import { mergeHarnessStates } from "./state.js";
import { entryLine } from "./render.js";

/** Prompt sections render at most this many entries per kind. */
export const MAX_INJECTED_ENTRIES_PER_KIND = 6;
/** Per-entry content budget inside the injected block (matches render.ts). */
export const MAX_INJECTED_CONTENT_LENGTH = 180;
/** How many `parentSession` hops a child walks to inherit entries. */
export const MAX_PARENT_CHAIN_DEPTH = 8;
/** Recency half-life for the injection ranking: an entry this old scores 0. */
export const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
/** At most this many recent user messages feed the relevance query. */
export const MAX_QUERY_MESSAGES = 3;
/** Query text handed to the relevance scorer is capped at this many chars. */
export const MAX_QUERY_CHARS = 400;

/** A user-message event's durable shape, loosened for duck typing. */
export interface UserMessageEventLike {
	type?: string;
	data?: {
		content?: unknown;
		source?: {
			kind?: string;
		};
	};
}

/** The minimal agent shape the section provider needs (duck-typed). */
export interface AgentLike {
	id: string;
	session?: {
		header?: {
			parentSession?: string;
		};
		/**
		 * Live append-only session log. Typed loosely (`unknown[]`) so the real
		 * `SessionEvent[]` union from dsh-session is assignable; rows are
		 * narrowed to {@link UserMessageEventLike} at read time.
		 */
		events?: readonly unknown[];
	};
}

/** The section-provider context shape we consume (subset of AssembleContext). */
export interface InjectContext {
	agent?: AgentLike;
}

/** Stable dictionary-order tiebreak used when two entries score equally. */
function stableCompare(a: HarnessEntry, b: HarnessEntry): number {
	return [a.path, a.title, a.id].join("\0").localeCompare([b.path, b.title, b.id].join("\0"));
}

/**
 * Lowercase tokenization for the keyword relevance scorer: runs of ASCII
 * alphanumerics and CJK characters become tokens (CJK is not split so whole
 * Chinese words/characters stay comparable), everything else is a separator.
 */
export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9\u4e00-\u9fff]+/)
		.filter((token) => token.length > 0);
}

/**
 * Keyword hit count of `query` tokens inside an entry: title hits weigh 2×,
 * content/path hits 1×. BM25-level relevance without any external service.
 */
export function relevanceHits(entry: HarnessEntry, query: string): number {
	const titleTokens = tokenize(entry.title);
	const bodyTokens = tokenize(`${entry.content} ${entry.path}`);
	let hits = 0;
	for (const token of tokenize(query)) {
		hits += titleTokens.filter((t) => t === token).length * 2;
		hits += bodyTokens.filter((t) => t === token).length;
	}
	return hits;
}

/**
 * Normalized recency in [0, 1]: 1 when the entry was just updated, decaying
 * linearly to 0 after {@link RECENCY_HALF_LIFE_MS}. Unparseable timestamps
 * score 0 (never preferred over a timestamped entry).
 */
export function recencyScore(entry: HarnessEntry, now: number): number {
	const updatedAt = Date.parse(entry.updated_at);
	if (Number.isNaN(updatedAt)) {
		return 0;
	}
	const age = now - updatedAt;
	if (age <= 0) {
		return 1;
	}
	return Math.max(0, 1 - age / RECENCY_HALF_LIFE_MS);
}

/**
 * Rank entries for injection, best first. With no query the ranking is pure
 * recency (newest first). With a query, any entry with at least one keyword
 * hit outranks every hit-less entry (`hits * 2 + recency <= 1` for the
 * latter), and hits decide the order among relevant entries; recency then
 * breaks remaining ties, and the stable dictionary order is the final
 * tiebreak, so the result is deterministic.
 */
export function rankEntries(entries: readonly HarnessEntry[], query?: string, now: number = Date.now()): HarnessEntry[] {
	const q = (query ?? "").trim();
	return [...entries].sort((a, b) => {
		if (q.length > 0) {
			const relevanceDelta = relevanceHits(b, q) * 2 - relevanceHits(a, q) * 2;
			if (relevanceDelta !== 0) {
				return relevanceDelta;
			}
		}
		const recencyDelta = recencyScore(b, now) - recencyScore(a, now);
		if (recencyDelta !== 0) {
			return recencyDelta;
		}
		return stableCompare(a, b);
	});
}

function sortedEntries(entries: readonly HarnessEntry[], query?: string): HarnessEntry[] {
	return rankEntries(entries, query);
}

/**
 * Extract the text of a message's content blocks without depending on the
 * dsh-llm ContentBlock type: string blocks pass through, object blocks
 * contribute their `text` field when present.
 */
function extractBlockText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((block) => {
			if (typeof block === "string") {
				return block;
			}
			if (block !== null && typeof block === "object" && "text" in block && typeof (block as { text?: unknown }).text === "string") {
				return (block as { text: string }).text;
			}
			return "";
		})
		.filter((text) => text.length > 0)
		.join(" ");
}

/**
 * Compose the relevance query from the assembling agent's most recent direct
 * user messages (event rows whose `type` is `user/message` and whose source
 * is a human `user`, so injected plugin context and tool results never leak
 * into the query). Returns "" when nothing qualifies — the ranking then
 * falls back to pure recency.
 */
export function recentUserText(agent: AgentLike | undefined, opts?: { maxMessages?: number; maxChars?: number }): string {
	const events = agent?.session?.events;
	if (!events || events.length === 0) {
		return "";
	}
	const maxMessages = opts?.maxMessages ?? MAX_QUERY_MESSAGES;
	const maxChars = opts?.maxChars ?? MAX_QUERY_CHARS;
	const parts: string[] = [];
	for (let i = events.length - 1; i >= 0 && parts.length < maxMessages; i -= 1) {
		const event = events[i] as UserMessageEventLike | undefined;
		if (event?.type !== "user/message") {
			continue;
		}
		const source = event.data?.source;
		if (source && source.kind !== "user") {
			continue;
		}
		const text = extractBlockText(event.data?.content).trim();
		if (text.length > 0) {
			parts.unshift(text);
		}
	}
	return parts.join(" ").slice(0, maxChars);
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
	for (const entry of sortedEntries(visible, query).slice(0, MAX_INJECTED_ENTRIES_PER_KIND)) {
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
	for (const entry of sortedEntries(visible, query).slice(0, MAX_INJECTED_ENTRIES_PER_KIND)) {
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
 * Compose the full injected block for one assembling agent: global entries
 * merged with the nearest carrying local store (local wins on id collision).
 * The optional `query` — when absent, derived from the agent's most recent
 * direct user messages — ranks which entries fill the per-kind cap
 * (relevance first, then recency; see {@link rankEntries}). Returns "" when
 * nothing is injectable — the prompt renderer then drops the section, so an
 * empty store adds zero tokens to every assembly.
 */
export function entriesSectionText(engine: EvolutionEngine, agent: AgentLike | undefined, query?: string): string {
	if (!agent) {
		return "";
	}
	const globalState = engine.load("global", undefined);
	const localState = nearestLocalStateWithEntries(engine, agent);
	const merged = localState ? mergeHarnessStates(globalState, localState) : globalState;
	const promptEntries = Object.values(merged.entries.prompt);
	const subagentEntries = Object.values(merged.entries.subagent);
	const relevanceQuery = (query ?? recentUserText(agent)).trim();
	const parts = [
		formatPromptEntriesSection(promptEntries, relevanceQuery),
		formatSubagentSpecsSection(subagentEntries, relevanceQuery),
	].filter((part) => part.length > 0);
	return parts.join("\n\n");
}
