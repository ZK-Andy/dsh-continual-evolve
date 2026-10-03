/**
 * Injection ranking core: deterministic entry ordering (relevance →
 * negative valence → recency → stable order) and the relevance query
 * composed from the assembling agent's most recent direct user messages.
 * Pure logic — no store access, no host API.
 */
import type { HarnessEntry } from "./types.js";
import { VALENCE_NEGATIVE_KEY } from "./types.js";
import { buildRelevanceIndex, relevanceScore, tokenize } from "./search.js";

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
		 * Live append-only session log as the public `session.events` getter.
		 * Typed loosely (`unknown[]`) so the real `SessionEvent[]` union from
		 * dsh-session is assignable; rows are narrowed to
		 * {@link UserMessageEventLike} at read time.
		 */
		events?: readonly unknown[];
		/**
		 * Full-log snapshot reader that answers the same rows in the same order
		 * where the `events` getter is absent. Called with no arguments for the
		 * whole log, which is the read {@link sessionEventsOf} needs.
		 */
		snapshotEvents?: () => readonly unknown[];
	};
}

/**
 * The session's event log through whichever reader the running harness
 * generation exposes. Returns [] when neither is present, so every caller
 * degrades to its empty-log path rather than throwing.
 */
export function sessionEventsOf(agent: AgentLike | undefined): readonly unknown[] {
	const session = agent?.session;
	if (session === undefined) {
		return [];
	}
	if (Array.isArray(session.events)) {
		return session.events;
	}
	const snapshot = session.snapshotEvents?.();
	return Array.isArray(snapshot) ? snapshot : [];
}

/** Stable dictionary-order tiebreak used when two entries score equally. */
function stableCompare(a: HarnessEntry, b: HarnessEntry): number {
	return [a.path, a.title, a.id].join("\0").localeCompare([b.path, b.title, b.id].join("\0"));
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
 * Negative-valence counter (P1 效价反馈): entries contradicted by later
 * assessments sink below clean ones at equal relevance/recency — the
 * behavioral analog of a confidence penalty (pi-continuous-learning's
 * contradicted −0.15), without inventing a new score axis.
 */
function negativeValence(entry: HarnessEntry): number {
	const value = entry.metadata[VALENCE_NEGATIVE_KEY];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Rank entries for injection, best first. With no query the ranking is
 * negative-valence first (contradicted entries last), then pure recency
 * (newest first). With a query, entries are scored once against a per-call
 * BM25 index (CJK bigrams; field-weighted title ×2 — see search.ts): any
 * entry with a positive score (≥1 matched token) outranks every hit-less
 * entry (score exactly 0), scores decide the order among relevant entries,
 * the negative-valence counter breaks remaining ties (contradicted entries
 * sink), recency breaks remaining ties, and the stable dictionary order is
 * the final tiebreak, so the result is deterministic. The input is never
 * mutated.
 */
export function rankEntries(entries: readonly HarnessEntry[], query?: string, now: number = Date.now()): HarnessEntry[] {
	const q = (query ?? "").trim();
	if (q.length === 0) {
		return [...entries].sort((a, b) => {
			const valenceDelta = negativeValence(a) - negativeValence(b);
			if (valenceDelta !== 0) {
				return valenceDelta;
			}
			const recencyDelta = recencyScore(b, now) - recencyScore(a, now);
			if (recencyDelta !== 0) {
				return recencyDelta;
			}
			return stableCompare(a, b);
		});
	}
	// Precompute scores once: the old comparator re-tokenized both sides on
	// every comparison (O(n log n) tokenizations); one index + one score per
	// entry turns the pass into table lookups.
	const index = buildRelevanceIndex(entries);
	const scores = new Map<HarnessEntry, number>(entries.map((entry) => [entry, relevanceScore(index, entry, q)]));
	return [...entries].sort((a, b) => {
		const relevanceDelta = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
		if (relevanceDelta !== 0) {
			return relevanceDelta;
		}
		const valenceDelta = negativeValence(a) - negativeValence(b);
		if (valenceDelta !== 0) {
			return valenceDelta;
		}
		const recencyDelta = recencyScore(b, now) - recencyScore(a, now);
		if (recencyDelta !== 0) {
			return recencyDelta;
		}
		return stableCompare(a, b);
	});
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
	const events = sessionEventsOf(agent);
	if (events.length === 0) {
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

/** CJK-bigram tokenizer re-exported for ranking consumers (see search.ts). */
export { tokenize };
