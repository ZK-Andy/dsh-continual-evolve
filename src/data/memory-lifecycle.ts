/**
 * Memories-only lifecycle writes: reason-stamping archives, correction-pointer
 * follows, and trial-clock carries. The SQL lives in the kind descriptor
 * (`resource-kinds.ts`); this module prepares it per call — every caller here
 * is a rare path (a promotion, a review archive, a merge), so no statement
 * cache pays for itself. The generic `Repository` keeps only kind-agnostic
 * reads and writes.
 */
import type { DatabaseSync } from "node:sqlite";
import type { ArchiveReason } from "./records.js";
import { MEMORIES } from "./resource-kinds.js";

/** The memories archive SQL, loud when a refactor drops it from the descriptor. */
function archiveSql(): string {
	const sql = MEMORIES.archiveReasonedSql;
	/* v8 ignore next 3: descriptor const, null only if a refactor drops the SQL */
	if (sql === null) {
		throw new Error("archiveWithReason unsupported for memories");
	}
	return sql;
}

/**
 * Archive one memory stamping why (and, for merges, what it folded into).
 * @param database - The open database handle.
 * @param workspaceId - The partition.
 * @param id - The row id.
 * @param ts - The archiving instant.
 * @param reason - The closed `archive_reason` value.
 * @param mergedInto - The surviving row id for merges, `null` otherwise.
 */
export function archiveWithReason(
	database: DatabaseSync,
	workspaceId: string,
	id: string,
	ts: string,
	reason: ArchiveReason,
	mergedInto: string | null,
): void {
	database.prepare(archiveSql()).run(reason, mergedInto, ts, workspaceId, id);
}

/**
 * Repoint live correction links from a folded row to its successor.
 * @param database - The open database handle.
 * @param workspaceId - The partition.
 * @param fromId - The folded row id.
 * @param toId - The surviving row id.
 * @returns How many rows moved.
 */
export function repointCorrects(database: DatabaseSync, workspaceId: string, fromId: string, toId: string): number {
	const sql = MEMORIES.repointSql;
	/* v8 ignore next 3: descriptor const, null only if a refactor drops the SQL */
	if (sql === null) {
		throw new Error("repointCorrects unsupported for memories");
	}
	const outcome = database.prepare(sql).run(toId, workspaceId, fromId) as { changes?: unknown };
	return Number(outcome.changes ?? 0);
}

/**
 * Carry the trial clock to a versioned row, so a probation review keeps its
 * schedule and demotion keeps its way home.
 * @param database - The open database handle.
 * @param workspaceId - The partition.
 * @param id - The versioned row id.
 * @param until - The probation deadline, `null` when none was set.
 * @param origin - The origin partition, `null` when none was recorded.
 */
export function restoreTrial(
	database: DatabaseSync,
	workspaceId: string,
	id: string,
	until: string | null,
	origin: string | null,
): void {
	const sql = MEMORIES.restoreTrialSql;
	/* v8 ignore next 3: descriptor const, null only if a refactor drops the SQL */
	if (sql === null) {
		throw new Error("restoreTrial unsupported for memories");
	}
	database.prepare(sql).run(until, origin, workspaceId, id);
}
