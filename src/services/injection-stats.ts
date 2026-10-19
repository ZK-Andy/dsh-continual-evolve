/**
 * Injection accounting: for a window of recent sessions, how many memories the
 * index named and how many of those the model actually read
 * (ADR `2026-10-18-absorb-memory-plugin-strengths`).
 *
 * The question this answers is the one the plugin could not answer before:
 * *is the injected index being used at all?* `memory_usage` already records the
 * last time a body was served by id; an injection row records when the index was
 * built. A memory counts as read when its usage timestamp is at or after the
 * injection that named it.
 *
 * Known limit, accepted: `memory_usage` is an aggregate heartbeat, so this says
 * "the body was served", never "the answer used it". No per-answer tracing is
 * added on purpose.
 */
import type { InjectionRow, MemoryStore } from "../store-types.js";

/** Default window for the card's conversion figure. */
export const INJECTION_STATS_DAYS = 7;

/** What one workspace's recent injections add up to. */
export interface InjectionStats {
	/** Window length in days. */
	days: number;
	/** Sessions that injected an index inside the window. */
	sessions: number;
	/** Distinct memory ids named by those indexes. */
	injected: number;
	/** Of those ids, how many were read at or after the injection that named them. */
	read: number;
	/**
	 * `read / injected`, 0 when nothing was injected. The adoption read: how
	 * much of the injected index was later pulled as full text — not recall.
	 */
	readThrough: number;
	/**
	 * Deprecated alias of {@link readThrough}, kept one release for cached
	 * desktop bundles (P1 ADR `2026-10-19-p1-quick-wins`): an old `client.js`
	 * still reads `rate`, the new one reads `readThrough`, the backend sends
	 * both. Remove next minor (the test pins their equality until then).
	 */
	rate: number;
	/** Ids named by the latest injection in the window (the recall numerator N). */
	latestInjected: number;
	/** Summed estimated tokens of the rendered indexes. */
	tokens: number;
}

/** The empty reading (no sessions in the window). */
export function emptyInjectionStats(days: number = INJECTION_STATS_DAYS): InjectionStats {
	return { days, sessions: 0, injected: 0, read: 0, readThrough: 0, rate: 0, latestInjected: 0, tokens: 0 };
}

/**
 * Sum one workspace's injections over a window and check each named id against
 * its usage heartbeat.
 *
 * @param store - The store to read.
 * @param workspaceId - The partition (the session's workspace path).
 * @param days - Window length in days (default 7).
 * @param now - The instant to judge by (tests pass one).
 * @returns The aggregated reading; a failing read degrades to the empty one.
 */
export function injectionStats(
	store: MemoryStore,
	workspaceId: string,
	days: number = INJECTION_STATS_DAYS,
	now: Date = new Date(),
): InjectionStats {
	let rows: InjectionRow[];
	try {
		const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
		rows = store.listInjections(workspaceId, since);
	} catch {
		return emptyInjectionStats(days);
	}
	// An id named by several sessions counts once, judged by its earliest naming:
	// that is the strictest reading (a later read cannot retroactively justify an
	// earlier exposure).
	const firstSeen = new Map<string, string>();
	let tokens = 0;
	for (const row of rows) {
		tokens += row.estTokens;
		for (const id of row.ids) {
			const seen = firstSeen.get(id);
			if (seen === undefined || row.ts < seen) {
				firstSeen.set(id, row.ts);
			}
		}
	}
	let read = 0;
	for (const [id, ts] of firstSeen) {
		try {
			const use = store.getMemoryUse(workspaceId, id);
			if (use !== undefined && use.lastUsedAt !== null && use.lastUsedAt >= ts) {
				read += 1;
			}
		} catch {
			// A usage read that throws counts as "not read" — never fails the card.
		}
	}
	const injected = firstSeen.size;
	const readThrough = injected === 0 ? 0 : read / injected;
	// The recall numerator N: ids named by the latest injection in the window.
	// Resolved by max ts (not row order) so the reading survives any store sort.
	let latestInjected = 0;
	let latestTs = "";
	for (const row of rows) {
		if (row.ts > latestTs) {
			latestTs = row.ts;
			latestInjected = row.ids.length;
		}
	}
	return { days, sessions: rows.length, injected, read, readThrough, rate: readThrough, latestInjected, tokens };
}
