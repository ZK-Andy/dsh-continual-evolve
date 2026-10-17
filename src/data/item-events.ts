/**
 * The review queue's event tier: the linkage table, its writer, and the two
 * reads the queue needs from it (`2026-10-17-review-and-tiering-batch-rollout`).
 *
 * Events are the queue's primary trigger. They are a log, not a consumed
 * queue: the row is the audit, and "an event newer than the item's latest
 * complete verdict" is the whole pending test — nothing to delete, nothing to
 * leak. The keep streak is derived from the same verdict rows for the same
 * reason: two writers would drift, and pruning already resets it.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { INCOMPLETE_REVIEW_SQL } from "./review-accounts.js";

/**
 * The review queue's event whitelist: why an item re-enters review without
 * waiting out its exemption window. One home — the `item_events` DDL is
 * generated from it (`data/schema.ts`), so a new kind cannot land in the
 * table's `CHECK` alone.
 *
 * - `similar`: a drop-in write landed text the item is lexically near.
 * - `corrects`: a landed row names the item as the thing it corrects.
 * - `correction`: a feedback write (the user correcting something) landed
 *   near the item — the same-topic linkage, without an explicit target.
 */
export const ITEM_EVENT_KINDS = ["similar", "corrects", "correction"] as const;

/** One review-queue event kind. */
export type ItemEventKind = (typeof ITEM_EVENT_KINDS)[number];

/**
 * One linkage event: the item it puts back in the queue, and the write that
 * caused it.
 */
export interface ItemEventEntry {
	workspaceId: string;
	kind: "memory" | "skill";
	/** The item that must be re-reviewed (the link's target, not its cause). */
	id: string;
	event: ItemEventKind;
	/** The item whose write caused the linkage, when one row is responsible. */
	sourceId?: string | undefined;
	reason?: string | undefined;
}

/** One item's settled state: how many keeps in a row, and the last event. */
export interface ReviewSettled {
	keeps: number;
	lastEventTs: string | null;
}

/**
 * The prepared statements the event tier runs on. The streak statements live
 * here too: the settled read needs both the verdict rows and the events, and
 * keeping them in one module is what keeps this a one-way dependency.
 */
export interface ItemEventStmts {
	itemEvent: StatementSync;
	itemEventQueue: StatementSync;
	itemEventLast: StatementSync;
	itemEventPrune: StatementSync;
	reviewReset: StatementSync;
	reviewKeeps: StatementSync;
}

/**
 * Prepare the event statements once per open store.
 * @param database - The open database handle.
 * @returns The prepared event statement bundle.
 */
export function prepareItemEventStmts(database: DatabaseSync): ItemEventStmts {
	return {
		itemEvent: database.prepare(
			"INSERT INTO item_events (ts, workspace_id, item_kind, item_id, event, source_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
		),
		// The event tier of the queue. Correlated rather than consumed: the
		// verdict row stays the audit. Strict `>` on purpose: a verdict and an
		// event in the same millisecond re-queues the item once more, which costs
		// one review — the other direction would silently drop a linkage nobody
		// ever saw.
		itemEventQueue: database.prepare(
			"SELECT DISTINCT e.workspace_id AS workspace_id, e.item_kind AS item_kind, e.item_id AS item_id " +
				"FROM item_events e WHERE NOT EXISTS (SELECT 1 FROM review_log r " +
				"WHERE r.workspace_id IS e.workspace_id AND r.item_kind = e.item_kind AND r.item_id = e.item_id " +
				`AND r.ts > e.ts AND NOT ${INCOMPLETE_REVIEW_SQL})`,
		),
		itemEventLast: database.prepare(
			"SELECT MAX(ts) AS ts FROM item_events WHERE workspace_id IS ? AND item_kind = ? AND item_id = ?",
		),
		itemEventPrune: database.prepare("DELETE FROM item_events WHERE ts < ?"),
		// The settled-streak reset point: the later of the last non-keep verdict
		// and the last linkage event. Keeps counted past it are the streak.
		reviewReset: database.prepare(
			`SELECT MAX(ts) AS ts FROM review_log WHERE workspace_id IS ? AND item_kind = ? AND item_id = ? AND NOT ${INCOMPLETE_REVIEW_SQL} AND verdict <> 'keep'`,
		),
		reviewKeeps: database.prepare(
			`SELECT COUNT(*) AS n FROM review_log WHERE workspace_id IS ? AND item_kind = ? AND item_id = ? AND NOT ${INCOMPLETE_REVIEW_SQL} AND verdict = 'keep' AND ts > ?`,
		),
	};
}

/**
 * The linkage-event writer over the prepared insert. Exported separately so
 * the memory write gate can append events inside its own transaction — a
 * landed row and the linkages it causes commit together or not at all.
 * @param stmts - Any statement bundle carrying the `itemEvent` insert.
 * @returns A writer taking a batch of events.
 */
export function itemEventWriter(stmts: Pick<ItemEventStmts, "itemEvent">): (entries: readonly ItemEventEntry[]) => void {
	return (entries) => {
		if (entries.length === 0) {
			return;
		}
		const ts = new Date().toISOString();
		for (const entry of entries) {
			stmts.itemEvent.run(
				ts,
				entry.workspaceId,
				entry.kind,
				entry.id,
				entry.event,
				entry.sourceId ?? null,
				entry.reason ?? null,
			);
		}
	};
}

/** The event-tier half of the store surface. */
export interface ItemEventMethods {
	recordItemEvents(entries: readonly ItemEventEntry[]): void;
	reviewEventQueue(): { workspaceId: string; kind: "memory" | "skill"; id: string }[];
	reviewSettled(workspaceId: string, kind: "memory" | "skill", id: string): ReviewSettled;
}

/**
 * Build the event-tier store methods.
 * @param stmts - The prepared event statements.
 * @returns The three store methods, spread into the assembled store.
 */
export function createItemEventMethods(stmts: ItemEventStmts): ItemEventMethods {
	return {
		recordItemEvents: itemEventWriter(stmts),
		reviewEventQueue() {
			const rows = stmts.itemEventQueue.all() as { workspace_id: string; item_kind: "memory" | "skill"; item_id: string }[];
			return rows.map((row) => ({ workspaceId: row.workspace_id, kind: row.item_kind, id: row.item_id }));
		},
		reviewSettled(workspaceId, kind, id) {
			try {
				const lastEventTs = lastEventInstant(stmts, workspaceId, kind, id);
				const reset = stmts.reviewReset.get(workspaceId, kind, id) as { ts: string | null } | undefined;
				const keeps = Number((stmts.reviewKeeps.get(workspaceId, kind, id, resetPoint(reset?.ts, lastEventTs)) as { n: number }).n);
				return { keeps, lastEventTs };
			} catch {
				// A derived read that fails says "nothing settled yet": reviewing
				// sooner is the conservative side of the calendar, never a skip.
				return { keeps: 0, lastEventTs: null };
			}
		},
	};
}

/**
 * The instant a keep streak is counted from: the later of the last non-keep
 * verdict and the last linkage event. ISO instants compare lexicographically.
 * @param resetTs - The last non-keep verdict instant, null when none.
 * @param eventTs - The last linkage event instant, null when none.
 * @returns The cutoff instant, `""` when neither reset exists.
 */
function resetPoint(resetTs: string | null | undefined, eventTs: string | null | undefined): string {
	return resetTs !== undefined && resetTs !== null && resetTs > (eventTs ?? "") ? resetTs : (eventTs ?? "");
}

/**
 * The last linkage event instant of one item, `null` when it has none.
 * @param stmts - The prepared event statements.
 * @param workspaceId - The item's partition.
 * @param kind - Memory or skill.
 * @param id - The item id.
 * @returns The instant, or `null`.
 */
function lastEventInstant(
	stmts: Pick<ItemEventStmts, "itemEventLast">,
	workspaceId: string,
	kind: "memory" | "skill",
	id: string,
): string | null {
	const row = stmts.itemEventLast.get(workspaceId, kind, id) as { ts: string | null } | undefined;
	return row?.ts ?? null;
}
