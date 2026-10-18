/**
 * The injection ledger: one row per (workspace, session), written when the
 * memory index is first rendered for that session
 * (ADR `2026-10-18-absorb-memory-plugin-strengths`).
 *
 * Why a table rather than a `state` key: the reader asks "recent injections in
 * this workspace", which is a windowed scan, and folding rows into the key-value
 * table would make it a JSON scan over unrelated state. The row is written once
 * per session — the section is frozen per agent id, so later assemblies hit the
 * frozen text and never reach this writer.
 *
 * The table is bounded by session count and pruned with the other ledgers
 * (`services/retention.ts`, 30 days).
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { InjectionRow, InjectionWrite } from "./records.js";

/** The injection table. STRICT, like every other table in this store. */
export const INJECTION_LOG_DDL = `
CREATE TABLE IF NOT EXISTS injection_log (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  memory_ids TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  est_tokens INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, session_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_injection_ts ON injection_log(ts);`;

/** The prepared statements the injection ledger needs. */
export interface InjectionStmts {
	injectionUpsert: StatementSync;
	injectionList: StatementSync;
	injectionPrune: StatementSync;
	injectionRecent: StatementSync;
}

/**
 * Prepare the injection statements.
 * @param database - The open database.
 * @returns The statement bundle.
 */
export function prepareInjectionStmts(database: DatabaseSync): InjectionStmts {
	return {
		injectionUpsert: database.prepare(
			"INSERT INTO injection_log (workspace_id, session_id, ts, memory_ids, item_count, est_tokens) " +
				"VALUES (?, ?, ?, ?, ?, ?) " +
				"ON CONFLICT (workspace_id, session_id) DO NOTHING",
		),
		injectionList: database.prepare(
			"SELECT workspace_id, session_id, ts, memory_ids, item_count, est_tokens FROM injection_log " +
				"WHERE workspace_id = ? AND ts >= ? ORDER BY ts DESC",
		),
		injectionPrune: database.prepare("DELETE FROM injection_log WHERE ts < ?"),
		injectionRecent: database.prepare(
			"SELECT COUNT(*) AS n, COALESCE(SUM(item_count), 0) AS items FROM injection_log WHERE workspace_id = ? AND ts >= ?",
		),
	};
}

/** The methods the store exposes over the injection ledger. */
export interface InjectionMethods {
	/** Record one session's injection; a repeat for the same session is ignored. */
	recordInjection(entry: InjectionWrite): void;
	/** Injections of one workspace since a timestamp, newest first. */
	listInjections(workspaceId: string, sinceIso: string): InjectionRow[];
	/** Drop injection rows older than a cutoff; returns rows removed. */
	pruneInjections(beforeIso: string): number;
}

/**
 * Build the injection-ledger methods.
 * @param stmts - The prepared statements.
 * @returns The store methods.
 */
export function createInjectionMethods(stmts: InjectionStmts): InjectionMethods {
	return {
		recordInjection(entry) {
			stmts.injectionUpsert.run(
				entry.workspaceId,
				entry.sessionId,
				entry.ts,
				JSON.stringify(entry.ids),
				entry.ids.length,
				entry.estTokens,
			);
		},
		listInjections(workspaceId, sinceIso) {
			const rows = stmts.injectionList.all(workspaceId, sinceIso) as {
				workspace_id: string;
				session_id: string;
				ts: string;
				memory_ids: string;
				item_count: number;
				est_tokens: number;
			}[];
			return rows.map((row) => ({
				workspaceId: row.workspace_id,
				sessionId: row.session_id,
				ts: row.ts,
				ids: parseIds(row.memory_ids),
				estTokens: row.est_tokens,
			}));
		},
		pruneInjections(beforeIso) {
			const result = stmts.injectionPrune.run(beforeIso);
			return Number(result.changes ?? 0);
		},
	};
}

/** Parse the stored id array, tolerating a row written by an older build. */
function parseIds(raw: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
	} catch {
		return [];
	}
}
