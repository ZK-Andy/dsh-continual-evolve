import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/data/migrate.js";
import {
	EXTRACTION_LOG_COLUMNS,
	checkValuesOf,
	driftedTables,
	rebuildDriftedTables,
	rebuildTable,
	type GuardedTable,
} from "../src/data/schema.js";
import { LEDGER_TRIGGERS, type LedgerTrigger } from "../src/store-types.js";

/**
 * The ledger as an existing store holds it: created 2026-10-05, so the
 * whitelist predates `item-review` and the later columns arrived by ALTER.
 */
const STORE_EXTRACTION_LOG_DDL = `CREATE TABLE extraction_log (
  run_id TEXT, ts TEXT NOT NULL, session_id TEXT, workspace_id TEXT,
  trigger TEXT CHECK (trigger IN ('turn-debounce','compaction','close-drain','explicit','import')),
  decision TEXT, skip_reason TEXT,
  status TEXT, duration_ms INTEGER, model TEXT, usage TEXT,
  files TEXT
, occurrences INTEGER NOT NULL DEFAULT 1, cheap_usage TEXT, cheap_error TEXT)`;

let roots: string[] = [];

function tmpDb(): DatabaseSync {
	const root = mkdtempSync(join(tmpdir(), "evolve-schema-"));
	roots.push(root);
	return new DatabaseSync(join(root, "t.db"));
}

/** A store whose ledger is the pre-`item-review` shape, with one ledger row. */
function oldStore(): DatabaseSync {
	const database = tmpDb();
	database.exec(STORE_EXTRACTION_LOG_DDL);
	database.prepare("INSERT INTO extraction_log (run_id, ts, trigger, status) VALUES (?, ?, ?, ?)").run(
		"extract:s1:tail",
		"2026-10-16T00:00:00.000Z",
		"turn-debounce",
		"applied",
	);
	return database;
}

function columnNames(database: DatabaseSync, table: string): string[] {
	return (database.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((row) => row.name);
}

function ledgerSql(database: DatabaseSync): string {
	const row = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'extraction_log'").get() as { sql: string };
	return row.sql;
}

function insertTrigger(database: DatabaseSync, trigger: LedgerTrigger): void {
	database.prepare("INSERT INTO extraction_log (ts, trigger) VALUES (?, ?)").run("2026-10-16T14:06:26.117Z", trigger);
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
});

describe("checkValuesOf", () => {
	it("reads a whitelist out of DDL text and reports a constraint-free column as absent", () => {
		expect(checkValuesOf(STORE_EXTRACTION_LOG_DDL, "trigger")).toEqual([
			"turn-debounce",
			"compaction",
			"close-drain",
			"explicit",
			"import",
		]);
		expect(checkValuesOf("CREATE TABLE t (body TEXT CHECK (length(body) <= 65536))", "body")).toBeUndefined();
		expect(checkValuesOf("CREATE TABLE t (id TEXT)", "id")).toBeUndefined();
	});
});

describe("the extraction ledger shape guard", () => {
	it("rebuilds a store whose whitelist predates a trigger, keeping its rows", () => {
		const database = oldStore();
		try {
			// What the review rewrite hit on 2026-10-16: the row the code writes
			// with the new trigger is exactly the audit row, so it must land.
			expect(() => insertTrigger(database, "item-review")).toThrow(/CHECK constraint failed/);
			expect(driftedTables(database).map((spec) => spec.table)).toEqual(["extraction_log"]);

			migrateDatabase(database);

			expect(driftedTables(database)).toEqual([]);
			expect(checkValuesOf(ledgerSql(database), "trigger")).toEqual([...LEDGER_TRIGGERS]);
			insertTrigger(database, "item-review");
			const rows = database.prepare("SELECT run_id, trigger FROM extraction_log ORDER BY rowid").all() as {
				run_id: string | null;
				trigger: string;
			}[];
			expect(rows).toEqual([
				{ run_id: "extract:s1:tail", trigger: "turn-debounce" },
				{ run_id: null, trigger: "item-review" },
			]);
		} finally {
			database.close();
		}
	});

	it("gives a migrated store the column shape a fresh store is created with", () => {
		const old = oldStore();
		const fresh = tmpDb();
		try {
			migrateDatabase(old);
			migrateDatabase(fresh);
			expect(columnNames(old, "extraction_log")).toEqual(columnNames(fresh, "extraction_log"));
			expect(columnNames(fresh, "extraction_log")).toEqual([...EXTRACTION_LOG_COLUMNS]);
		} finally {
			old.close();
			fresh.close();
		}
	});

	it("is idempotent: a second migration touches neither rows nor schema", () => {
		const database = oldStore();
		try {
			migrateDatabase(database);
			const before = ledgerSql(database);
			const rowsBefore = database.prepare("SELECT count(*) AS n FROM extraction_log").get() as { n: number };

			migrateDatabase(database);

			expect(rebuildDriftedTables(database)).toEqual([]);
			expect(ledgerSql(database)).toBe(before);
			expect(database.prepare("SELECT count(*) AS n FROM extraction_log").get()).toEqual(rowsBefore);
		} finally {
			database.close();
		}
	});

	it("leaves a fresh store alone", () => {
		const database = tmpDb();
		try {
			migrateDatabase(database);
			const before = ledgerSql(database);
			migrateDatabase(database);
			expect(ledgerSql(database)).toBe(before);
			expect(driftedTables(database)).toEqual([]);
		} finally {
			database.close();
		}
	});
});

describe("rebuildTable", () => {
	function toysSpec(kindValues: readonly string[]): GuardedTable {
		return {
			table: "toys",
			ddl: (name) =>
				`CREATE TABLE IF NOT EXISTS ${name} (id TEXT NOT NULL PRIMARY KEY, kind TEXT CHECK (kind IN (${kindValues
					.map((value) => `'${value}'`)
					.join(",")})))`,
			columns: ["id", "kind"],
			checks: [{ column: "kind", values: kindValues }],
		};
	}

	it("copies rows and replays the table's indexes", () => {
		const database = tmpDb();
		try {
			database.exec("CREATE TABLE toys (id TEXT NOT NULL PRIMARY KEY, kind TEXT CHECK (kind IN ('a','b')))");
			database.exec("CREATE INDEX idx_toys_kind ON toys(kind)");
			database.prepare("INSERT INTO toys (id, kind) VALUES ('t1', 'a')").run();

			rebuildTable(database, toysSpec(["a", "b", "c"]));

			expect(database.prepare("SELECT id, kind FROM toys").all()).toEqual([{ id: "t1", kind: "a" }]);
			const index = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_toys_kind'").get() as
				| { sql: string }
				| undefined;
			expect(index?.sql).toContain("CREATE INDEX idx_toys_kind ON toys(kind)");
			database.prepare("INSERT INTO toys (id, kind) VALUES ('t2', 'c')").run();
		} finally {
			database.close();
		}
	});

	it("refuses to drop a column the guard entry does not list", () => {
		const database = tmpDb();
		try {
			database.exec("CREATE TABLE toys (id TEXT, kind TEXT, note TEXT)");

			expect(() => rebuildTable(database, toysSpec(["a"]))).toThrow(/does not list: note/);

			expect(columnNames(database, "toys")).toEqual(["id", "kind", "note"]);
		} finally {
			database.close();
		}
	});

	it("leaves the table untouched when the copy fails", () => {
		const database = tmpDb();
		try {
			database.exec("CREATE TABLE toys (id TEXT, kind TEXT)");
			database.prepare("INSERT INTO toys (id, kind) VALUES ('t1', 'a')").run();
			const spec: GuardedTable = { ...toysSpec(["a"]), columns: ["id", "kind", "missing"] };

			expect(() => rebuildTable(database, spec)).toThrow();

			const tables = database
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all() as { name: string }[];
			expect(tables.map((row) => row.name)).toEqual(["toys"]);
			expect(database.prepare("SELECT id, kind FROM toys").all()).toEqual([{ id: "t1", kind: "a" }]);
		} finally {
			database.close();
		}
	});

	it("reports a rebuild that did not close the drift instead of looping", () => {
		const database = tmpDb();
		try {
			// A guard entry whose DDL forgot the constraint: the rebuild runs, the
			// whitelist is still absent, and that is a bug worth stopping on.
			const forgetful: GuardedTable = { ...toysSpec(["a"]), ddl: (name) => `CREATE TABLE IF NOT EXISTS ${name} (id TEXT, kind TEXT)` };
			database.exec("CREATE TABLE toys (id TEXT, kind TEXT)");

			expect(() => rebuildDriftedTables(database, [forgetful])).toThrow(/still drifted after rebuild: toys/);
		} finally {
			database.close();
		}
	});
});
