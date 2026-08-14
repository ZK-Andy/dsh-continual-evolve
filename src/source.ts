/**
 * Trajectory citations: where distilled entries came from in the session
 * log. DSH sessions are event-sourced with contiguous seq numbers, so a
 * citation of (sessionId, seqs) expands back to the exact original
 * conversation rows (the durable log under `<dshHome>/sessions/...`).
 *
 * The extraction reads the live `agent.session.events` log (duck-typed, no
 * dsh-session dependency) and only ever selects direct human messages —
 * injected plugin context and tool results never become citations.
 */
import type { EntrySource } from "./types.js";
import type { AgentLike } from "./inject.js";

/** At most this many source user messages are cited per entry. */
export const MAX_SOURCE_MESSAGES = 3;

/** A session-log row's shape relevant to citations (duck-typed). */
interface EventRowLike {
	type?: string;
	seq?: number;
	data?: {
		source?: {
			kind?: string;
		};
	};
}

/**
 * The seqs of the agent's most recent direct user messages, in log order.
 * Returns [] when the agent has no readable log or no qualifying messages —
 * callers then simply omit the citation.
 */
export function recentUserSeqs(agent: AgentLike | undefined, opts?: { maxMessages?: number }): number[] {
	const events = agent?.session?.events;
	if (!events || events.length === 0) {
		return [];
	}
	const maxMessages = opts?.maxMessages ?? MAX_SOURCE_MESSAGES;
	const seqs: number[] = [];
	for (let i = events.length - 1; i >= 0 && seqs.length < maxMessages; i -= 1) {
		const row = events[i] as EventRowLike | undefined;
		if (row?.type !== "user/message") {
			continue;
		}
		const source = row.data?.source;
		if (source && source.kind !== "user") {
			continue;
		}
		if (typeof row.seq === "number" && Number.isInteger(row.seq)) {
			seqs.unshift(row.seq);
		}
	}
	return seqs;
}

/**
 * Build the citation for an apply call: the session id plus the seqs of the
 * most recent direct user messages. Returns undefined when neither can be
 * determined, so callers can pass it straight through without special cases.
 */
export function entrySourceOf(agent: AgentLike | undefined, sessionId: string | undefined): EntrySource | undefined {
	if (!sessionId) {
		return undefined;
	}
	const seqs = recentUserSeqs(agent);
	return seqs.length > 0 ? { sessionId, seqs } : { sessionId };
}
