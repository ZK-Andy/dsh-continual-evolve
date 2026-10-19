/**
 * Eval case rows (P5): the query / injection-preview / reply triple per task
 * arm. An eval ledger, not memory sediment — rows never enter the injection
 * index or the card lists; the card only renders their staleness. Writes go
 * through {@link writeEvalCases} (truncate + redact at the door); reads are
 * the runner's replay input (P5b). Pruned with the ledgers at 30 days.
 */
import type { DatabaseSync } from "node:sqlite";
import { EVAL_ARMS, type EvalCaseWrite } from "./records.js";
import { redactText } from "./secret.js";
/** The case-write shape lives in `records.js`; re-exported so P5a import sites keep working. */
export type { EvalCaseWrite } from "./records.js";

/**
 * Last manual eval runs, written by the runner (P5b) and read by the card
 * (P5a): store `state` keys holding `{"date": ISO, "commit": sha}`. Key names
 * and value shape are the P5a contract — never invent new ones at
 * implementation time. Follows the `patrol:last` flat-key convention.
 */
export const EVAL_LAST_FOUR_ARM_KEY = "eval:last-four-arm";
export const EVAL_LAST_EXTERNAL_KEY = "eval:last-external";
/** Days after which the card marks an eval run stale (P5a: 60-day outer loop). */
export const EVAL_STALE_DAYS = 60;

/** The eval arms in DDL order: the rebuild's explicit copy list. */
export const EVAL_CASES_COLUMNS = [
	"run_id",
	"task_id",
	"arm",
	"workspace_id",
	"query",
	"injection_preview",
	"reply",
	"created_at",
] as const;

/** Truncation caps (P5a拍板数，P5a 实测后回填调参依据). */
export const EVAL_QUERY_CHAR_CAP = 2000;
export const EVAL_PREVIEW_CHAR_CAP = 8000;
export const EVAL_REPLY_CHAR_CAP = 4000;

/**
 * The eval-cases table DDL, parameterized by table name so the fresh-file
 * path and the rebuild share one text. The `arm` whitelist is generated from
 * {@link EVAL_ARMS}, its single home.
 * @param name - The table to create (the rebuild passes its temporary name).
 * @returns The `CREATE TABLE` statement.
 */
export function evalCasesDdl(name: string): string {
	const arms = EVAL_ARMS.map((arm) => `'${arm}'`).join(",");
	return `CREATE TABLE IF NOT EXISTS ${name} (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  arm TEXT NOT NULL CHECK (arm IN (${arms})),
  workspace_id TEXT NOT NULL,
  query TEXT NOT NULL,
  injection_preview TEXT NOT NULL,
  reply TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, task_id, arm)
)`;
}

/** Truncate to the cap ( over-long previews/replies stay observable, never reject). */
function truncate(text: string, cap: number): string {
	return text.length > cap ? text.slice(0, cap) : text;
}

/**
 * Write eval cases: truncate each field at the door, mask secrets in replies,
 * insert one row per case. No source-session columns exist by design (P5a:
 * replayable shape, not session narrative).
 * @param database - The open, migrated database handle.
 * @param cases - The cases to store.
 * @returns Rows inserted.
 */
export function writeEvalCases(database: DatabaseSync, cases: readonly EvalCaseWrite[]): number {
	if (cases.length === 0) {
		return 0;
	}
	const insert = database.prepare(
		"INSERT OR REPLACE INTO eval_cases (run_id, task_id, arm, workspace_id, query, injection_preview, reply, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	);
	let inserted = 0;
	database.exec("BEGIN");
	try {
		for (const entry of cases) {
			insert.run(
				entry.runId,
				entry.taskId,
				entry.arm,
				entry.workspaceId,
				truncate(entry.query, EVAL_QUERY_CHAR_CAP),
				truncate(entry.injectionPreview, EVAL_PREVIEW_CHAR_CAP),
				redactText(truncate(entry.reply, EVAL_REPLY_CHAR_CAP)),
				entry.createdAt,
			);
			inserted += 1;
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
	return inserted;
}

/**
 * Drop eval cases older than the cutoff (P5a: same 30-day mouth as the ledgers).
 * @param database - The open database handle.
 * @param beforeIso - Rows with `created_at` below this ISO instant go.
 * @returns Rows removed.
 */
export function pruneEvalCases(database: DatabaseSync, beforeIso: string): number {
	const result = database.prepare("DELETE FROM eval_cases WHERE created_at < ?").run(beforeIso) as { changes?: unknown };
	return Number(result.changes ?? 0);
}
