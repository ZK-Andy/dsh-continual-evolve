/**
 * The schema shape guard: the drift probe and the rebuild migration for the
 * tables whose `CHECK` whitelists can drift.
 *
 * Why it exists (2026-10-16): `SCHEMA_DDL` creates tables with
 * `CREATE TABLE IF NOT EXISTS` and every later migration only ever ran
 * `ALTER TABLE ADD COLUMN`, so a value added to a whitelist reached fresh
 * stores alone. On an existing store the insert carrying the new value
 * crashed — and because that insert was the audit row, the model's edit had
 * already committed: the body changed, the audit row was lost, and the
 * ledger recorded a failure.
 *
 * Each table's DDL and copy list live with that table's module; this file
 * aggregates them into one guard list. The fresh-file path and the rebuild
 * share that one DDL text, the rebuild copies an explicit column list, and
 * the probe compares the live whitelists against the same declaration the
 * code writes rows with. A future value-set change is one entry here, not
 * another bespoke migration.
 */
import type { DatabaseSync } from "node:sqlite";
import { ITEM_EVENT_KINDS, ITEM_EVENTS_COLUMNS, itemEventsDdl } from "./item-events.js";
import { ARCHIVE_REASONS, EVAL_ARMS, MEMORIES_COLUMNS, memoriesDdl } from "./records.js";
import { EXTRACTION_LOG_COLUMNS, extractionLogDdl } from "./ledger.js";
import { REVIEW_LOG_COLUMNS, REVIEW_VERDICTS, reviewLogDdl } from "./review-accounts.js";
import { EVAL_CASES_COLUMNS, evalCasesDdl } from "./eval-cases.js";
import { LEDGER_TRIGGERS } from "../store-types.js";

// The guarded tables' shapes, re-exported from their homes so every importer
// (the fresh-file path, the rebuild, the G6 snapshot) keeps one entry point.
export {
	EXTRACTION_LOG_COLUMNS,
	ITEM_EVENTS_COLUMNS,
	MEMORIES_COLUMNS,
	REVIEW_LOG_COLUMNS,
	extractionLogDdl,
	itemEventsDdl,
	memoriesDdl,
	reviewLogDdl,
};

/** One `CHECK` whitelist as the code declares it. */
export interface CheckedColumn {
	readonly column: string;
	readonly values: readonly string[];
}

/** One table whose live DDL must match the code's, and is rebuilt when it drifted. */
export interface GuardedTable {
	readonly table: string;
	/** The table's DDL, parameterized by name so creation and rebuild share it. */
	readonly ddl: (name: string) => string;
	/** The columns the rebuild copies (explicit, so a reordered table still migrates by name). */
	readonly columns: readonly string[];
	/** The whitelists the probe compares against the live DDL. */
	readonly checks: readonly CheckedColumn[];
}

/** Every table under the shape guard, with the whitelists the probe compares. */
export const GUARDED_TABLES: readonly GuardedTable[] = [
	{
		table: "memories",
		ddl: memoriesDdl,
		columns: MEMORIES_COLUMNS,
		checks: [{ column: "archive_reason", values: ARCHIVE_REASONS }],
	},
	{
		table: "extraction_log",
		ddl: extractionLogDdl,
		columns: EXTRACTION_LOG_COLUMNS,
		checks: [{ column: "trigger", values: LEDGER_TRIGGERS }],
	},
	{
		table: "item_events",
		ddl: itemEventsDdl,
		columns: ITEM_EVENTS_COLUMNS,
		checks: [{ column: "event", values: ITEM_EVENT_KINDS }],
	},
	{
		table: "review_log",
		ddl: reviewLogDdl,
		columns: REVIEW_LOG_COLUMNS,
		checks: [{ column: "verdict", values: REVIEW_VERDICTS }],
	},
	{
		table: "eval_cases",
		ddl: evalCasesDdl,
		columns: EVAL_CASES_COLUMNS,
		checks: [{ column: "arm", values: EVAL_ARMS }],
	},
];

/**
 * The stored DDL of one table.
 * @param database - The open database handle.
 * @param table - The table name.
 * @returns The `sqlite_master` DDL text, `undefined` when the table does not exist.
 */
function tableSql(database: DatabaseSync, table: string): string | undefined {
	const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
		| { sql?: unknown }
		| undefined;
	return typeof row?.sql === "string" ? row.sql : undefined;
}

/**
 * The live column names of one table, in declaration order.
 * @param database - The open database handle.
 * @param table - The table name.
 * @returns The column names.
 */
function liveColumns(database: DatabaseSync, table: string): string[] {
	const rows = database.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[];
	return rows.map((row) => row.name);
}

/**
 * Read one column's `CHECK (column IN (…))` whitelist out of a table's DDL.
 * A store created before the whitelist existed answers `undefined`, which the
 * probe reads as drift — the rebuild is what installs the constraint.
 * @param sql - The `sqlite_master` DDL text.
 * @param column - The constrained column.
 * @returns The live values, or `undefined` when the DDL declares no such whitelist.
 */
export function checkValuesOf(sql: string, column: string): string[] | undefined {
	const flat = sql.replace(/\s+/g, " ");
	const expression = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, "i").exec(flat);
	if (expression === null) {
		return undefined;
	}
	const values: string[] = [];
	for (const match of (expression[1] ?? "").matchAll(/'([^']*)'/g)) {
		if (match[1] !== undefined) {
			values.push(match[1]);
		}
	}
	return values;
}

/**
 * The guarded tables whose live whitelists differ from the code's declaration.
 * Set equality, not containment: a store that still accepts a value the code
 * has retired is as far from the code as one that is missing a new value.
 * @param database - The open database handle.
 * @param tables - The guard entries to probe (defaults to the code's own list).
 * @returns The drifted guard entries (empty when every table matches).
 */
export function driftedTables(database: DatabaseSync, tables: readonly GuardedTable[] = GUARDED_TABLES): GuardedTable[] {
	const drifted: GuardedTable[] = [];
	for (const spec of tables) {
		const sql = tableSql(database, spec.table);
		if (sql === undefined) {
			continue;
		}
		if (spec.checks.some((check) => !sameValues(checkValuesOf(sql, check.column), check.values))) {
			drifted.push(spec);
		}
	}
	return drifted;
}

/**
 * Compare a live whitelist against the declared one, ignoring order.
 * @param live - The values read out of the live DDL.
 * @param expected - The values the code declares.
 * @returns True when both hold exactly the same values.
 */
function sameValues(live: readonly string[] | undefined, expected: readonly string[]): boolean {
	if (live === undefined || live.length !== expected.length) {
		return false;
	}
	const seen = new Set(live);
	return expected.every((value) => seen.has(value));
}

/**
 * The `CREATE INDEX` statements of one table: dropping it drops them too, so
 * the rebuild replays them after the swap.
 * @param database - The open database handle.
 * @param table - The table name.
 * @returns The index DDL statements (empty when the table carries none).
 */
function tableIndexes(database: DatabaseSync, table: string): string[] {
	const rows = database
		.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
		.all(table) as { sql: string }[];
	return rows.map((row) => row.sql);
}

/**
 * Rebuild one guarded table in place: create the guarded DDL under a
 * temporary name, copy the explicit column list, swap the names, and replay
 * the indexes. One transaction, so readers see either the old table or the
 * new one — never a half-migrated store.
 * @param database - The open database handle.
 * @param spec - The table's guard entry.
 * @throws When the live table carries a column the entry does not list (the copy would drop it), or when the rebuild itself fails.
 */
export function rebuildTable(database: DatabaseSync, spec: GuardedTable): void {
	const unlisted = liveColumns(database, spec.table).filter((column) => !spec.columns.includes(column));
	if (unlisted.length > 0) {
		throw new Error(`schema guard: ${spec.table} has column(s) the rebuild does not list: ${unlisted.join(", ")}`);
	}
	const indexes = tableIndexes(database, spec.table);
	const temp = `${spec.table}_rebuilt`;
	const list = spec.columns.join(", ");
	database.exec("BEGIN");
	try {
		database.exec(`DROP TABLE IF EXISTS ${temp}`);
		database.exec(spec.ddl(temp));
		database.exec(`INSERT INTO ${temp} (${list}) SELECT ${list} FROM ${spec.table}`);
		database.exec(`DROP TABLE ${spec.table}`);
		database.exec(`ALTER TABLE ${temp} RENAME TO ${spec.table}`);
		for (const index of indexes) {
			database.exec(index);
		}
		database.exec("COMMIT");
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			// The failing statement already ended the transaction; the original
			// error is the one worth reporting.
		}
		throw error;
	}
}

/**
 * Rebuild every drifted guarded table, then verify the drift is gone.
 * A rebuild that leaves the table drifting is a bug in the guard entry, not a
 * state to run on — so this reports it instead of looping.
 * @param database - The open database handle.
 * @param tables - The guard entries to enforce (defaults to the code's own list).
 * @returns The rebuilt table names (empty when nothing drifted).
 * @throws When a table still drifts after its rebuild.
 */
export function rebuildDriftedTables(database: DatabaseSync, tables: readonly GuardedTable[] = GUARDED_TABLES): string[] {
	const drifted = driftedTables(database, tables);
	for (const spec of drifted) {
		rebuildTable(database, spec);
	}
	const remaining = driftedTables(database, tables).map((spec) => spec.table);
	if (remaining.length > 0) {
		throw new Error(`schema guard: still drifted after rebuild: ${remaining.join(", ")}`);
	}
	return drifted.map((spec) => spec.table);
}
