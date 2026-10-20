/**
 * Eval case rows (P5, retired 2026-10-20): the historical query /
 * injection-preview / reply triples of the single 2026-10-19 four-arm run.
 * Both the write door and the reader went with the runner; what stays is the
 * table's own shape — this module is the DDL's single home, aggregated by
 * `schema.ts` and swept by the ledger's own prune (same 30-day mouth as the
 * other ledgers). Historical rows remain replayable evidence.
 */
import { EVAL_ARMS } from "./records.js";

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
