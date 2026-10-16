/**
 * How long the plugin keeps its own ledgers, and when it prunes them.
 *
 * `MemoryStore.pruneLedger` shipped with no production caller, so "the ledgers
 * are pruned" was true of the API and false of the machine (2026-10-14 real
 * store: 547 extraction rows in 9 days, 115 review rows in 3). Retention is a
 * policy with a trigger, and the trigger is the part that was missing.
 *
 * The check is day-throttled and idempotent, so every writer can call it
 * cheaply and a long-running process prunes without a scheduler of its own.
 */
import { GLOBAL_WORKSPACE, type MemoryStore } from "../store.js";
import { FAILURE_STATE_PREFIX, parseRouteFailure } from "./extraction-failure.js";

/** Rows older than this many days are pruned. */
export const LEDGER_RETENTION_DAYS = 30;

/** How long a spent route-failure record is kept before the sweep drops it. */
export const FAILURE_STATE_RETENTION_DAYS = 7;

/** The state key holding the UTC day of the last prune. */
const PRUNE_STATE_KEY = "prune:last";

/**
 * Prune the ledgers, the plugin log, and the spent route-failure records when
 * this UTC day has not been pruned.
 *
 * @param store - The store to prune.
 * @param now - The instant to judge by (defaults to the wall clock; tests pass one).
 * @returns Rows removed, or 0 when today's prune already ran.
 */
export function pruneIfDue(store: MemoryStore, now: Date = new Date()): number {
	const day = now.toISOString().slice(0, 10);
	if (store.state(GLOBAL_WORKSPACE, PRUNE_STATE_KEY) === day) {
		return 0;
	}
	const cutoff = new Date(now.getTime() - LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
	const removed = store.pruneLedger(cutoff) + pruneFailureState(store, now.getTime());
	store.setState(GLOBAL_WORKSPACE, PRUNE_STATE_KEY, day);
	return removed;
}

/**
 * Drop the route-failure records whose backoff ended long ago: those sessions
 * never came back, and one `state` row per dead session is the kind of growth
 * that outlives its usefulness.
 *
 * @param store - The store to sweep.
 * @param nowMs - Epoch ms to judge by.
 * @returns Records dropped.
 */
export function pruneFailureState(store: MemoryStore, nowMs: number): number {
	const expiry = nowMs - FAILURE_STATE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
	let removed = 0;
	for (const row of store.listState(FAILURE_STATE_PREFIX)) {
		const record = parseRouteFailure(row.value);
		// An unreadable value is not a record this plugin wrote: leave it alone
		// rather than delete state a later hand might still want.
		if (record === undefined || record.until > expiry) {
			continue;
		}
		store.deleteState(row.workspaceId, row.key);
		removed += 1;
	}
	return removed;
}
