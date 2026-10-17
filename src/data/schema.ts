/**
 * The schema shape guard: one home for the DDL of the tables whose `CHECK`
 * whitelists can drift, for the drift probe, and for the rebuild migration.
 *
 * Why it exists (2026-10-16): `SCHEMA_DDL` creates tables with
 * `CREATE TABLE IF NOT EXISTS` and every later migration only ever ran
 * `ALTER TABLE ADD COLUMN`, so a value added to a whitelist reached fresh
 * stores alone. On an existing store the insert carrying the new value
 * crashed — and because that insert was the audit row, the model's edit had
 * already committed: the body changed, the audit row was lost, and the
 * ledger recorded a failure.
 *
 * One entry per guarded table keeps the cure generic: the fresh-file path and
 * the rebuild share one DDL text, the rebuild copies an explicit column list,
 * and the probe compares the live whitelists against the same declaration the
 * code writes rows with. A future value-set change is one entry here, not
 * another bespoke migration.
 */
import type { DatabaseSync } from "node:sqlite";
import { ITEM_EVENT_KINDS } from "./item-events.js";
import { LEDGER_OCCURRENCES, LEDGER_TRIGGERS } from "../store-types.js";

/** The extraction ledger's columns in DDL order: the rebuild's explicit copy list. */
export const EXTRACTION_LOG_COLUMNS = [
	"run_id",
	"ts",
	"session_id",
	"workspace_id",
	"trigger",
	"decision",
	"skip_reason",
	"status",
	"duration_ms",
	"model",
	"usage",
	"cheap_usage",
	"cheap_error",
	"files",
	LEDGER_OCCURRENCES,
] as const;

/**
 * The extraction ledger's DDL, parameterized by table name so the fresh-file
 * path and the rebuild migration share one text.
 * @param name - The table to create (the rebuild passes its temporary name).
 * @returns The `CREATE TABLE` statement.
 */
export function extractionLogDdl(name: string): string {
	const whitelist = LEDGER_TRIGGERS.map((trigger) => `'${trigger}'`).join(",");
	return `CREATE TABLE IF NOT EXISTS ${name} (
  run_id TEXT, ts TEXT NOT NULL, session_id TEXT, workspace_id TEXT,
  trigger TEXT CHECK (trigger IN (${whitelist})),
  decision TEXT, skip_reason TEXT,
  status TEXT, duration_ms INTEGER, model TEXT, usage TEXT,
  cheap_usage TEXT, cheap_error TEXT,
  files TEXT, ${LEDGER_OCCURRENCES} INTEGER NOT NULL DEFAULT 1
)`;
}

/** The review-queue event's columns in DDL order: the rebuild's explicit copy list. */
export const ITEM_EVENTS_COLUMNS = [
	"ts",
	"workspace_id",
	"item_kind",
	"item_id",
	"event",
	"source_id",
	"reason",
] as const;

/**
 * The review-queue event table's DDL, parameterized by table name so the
 * fresh-file path and the rebuild share one text. The `event` whitelist is
 * generated from {@link ITEM_EVENT_KINDS}, its single home.
 * @param name - The table to create (the rebuild passes its temporary name).
 * @returns The `CREATE TABLE` statement.
 */
export function itemEventsDdl(name: string): string {
	const whitelist = ITEM_EVENT_KINDS.map((kind) => `'${kind}'`).join(",");
	return `CREATE TABLE IF NOT EXISTS ${name} (
  ts TEXT NOT NULL, workspace_id TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('memory','skill')),
  item_id TEXT NOT NULL,
  event TEXT CHECK (event IN (${whitelist})),
  source_id TEXT, reason TEXT
) STRICT`;
}

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
