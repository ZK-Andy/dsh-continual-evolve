/**
 * One-shot backfill for `archive_reason` (P4): project reasons for rows
 * archived before the column existed. SQL stays in `data/` (R2); the thin CLI
 * lives in `scripts/backfill-archive-reason.ts`.
 */
import type { DatabaseSync } from "node:sqlite";

/**
 * Project one archived row's reason from the ledgers, partition-aware: verdict
 * rows live in the move's target partition (rollout ADR §R2) — `promote` in
 * the global partition, `demote` back in the origin, `archive` in the row's
 * own. A global row prefers its demote evidence (demotion postdates the
 * promotion that left the older verdict behind); a workspace row prefers its
 * own applied `archive` verdict over an older promotion. No evidence, or
 * evidence for neither home, leaves the row unclassified (`undefined`).
 */
function projectArchiveReason(
	database: DatabaseSync,
	workspaceId: string,
	id: string,
): "promoted-source" | "review-archive" | "demoted-source" | undefined {
	const hasVerdict = (workspace: string, verdict: string, appliedOnly: boolean): boolean => {
		const rows = database
			.prepare(
				`SELECT 1 FROM review_log WHERE workspace_id IS ? AND item_kind = 'memory' AND item_id = ? AND verdict = ?${appliedOnly ? " AND applied = 1" : ""} LIMIT 1`,
			)
			.get(workspace, id, verdict) as unknown;
		return rows !== undefined;
	};
	if (workspaceId === "") {
		const origin = (
			database.prepare("SELECT origin_workspace FROM memories WHERE workspace_id = '' AND id = ?").get(id) as {
				origin_workspace?: unknown;
			} | undefined
		)?.origin_workspace;
		if (typeof origin === "string" && origin.length > 0 && hasVerdict(origin, "demote", false)) {
			return "demoted-source";
		}
		return hasVerdict("", "promote", false) ? "promoted-source" : undefined;
	}
	if (hasVerdict(workspaceId, "archive", true)) {
		return "review-archive";
	}
	return hasVerdict("", "promote", false) ? "promoted-source" : undefined;
}

/** What one backfill pass did. */
export interface BackfillResult {
	/** Rows stamped with a projected reason. */
	updated: number;
	/** Archived rows left unclassified (no or ambiguous evidence). */
	skipped: { workspaceId: string; id: string }[];
}

/**
 * Backfill `archive_reason` for rows archived before the column existed: stamp
 * rows with exactly one ledger evidence, leave the rest `''`. Idempotent (the
 * `UPDATE` re-checks the placeholder) and atomic (one transaction).
 * @param database - The open, migrated database handle.
 * @returns The stamped count and the rows left for a human.
 */
export function backfillArchiveReasons(database: DatabaseSync): BackfillResult {
	const result: BackfillResult = { updated: 0, skipped: [] };
	const pending = database
		.prepare("SELECT workspace_id, id FROM memories WHERE status = 'archived' AND (archive_reason IS NULL OR archive_reason = '')")
		.all() as { workspace_id: string; id: string }[];
	if (pending.length === 0) {
		return result;
	}
	const stamp = database.prepare(
		"UPDATE memories SET archive_reason = ? WHERE workspace_id = ? AND id = ? AND (archive_reason IS NULL OR archive_reason = '')",
	);
	database.exec("BEGIN");
	try {
		for (const row of pending) {
			const reason = projectArchiveReason(database, row.workspace_id, row.id);
			if (reason === undefined) {
				result.skipped.push({ workspaceId: row.workspace_id, id: row.id });
				continue;
			}
			const outcome = stamp.run(reason, row.workspace_id, row.id) as { changes?: unknown };
			if (Number(outcome.changes) > 0) {
				result.updated += 1;
			}
		}
		database.exec("COMMIT");
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			// The failing statement already ended the transaction.
		}
		throw error;
	}
	return result;
}
