import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migrate.js";
import { openRepositories } from "../src/data/repository.js";
import { driftedTables, GUARDED_TABLES } from "../src/data/schema.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";
import { memorySnapshot } from "../src/surfaces/memory-snapshot.js";

/**
 * Archive reasons (P4a): every archiving writer stamps why, old stores gain
 * the columns through the migration chain, and the backfill projects reasons
 * for rows archived before the column existed.
 */
const WS = "/tmp/work/archive-reason";

let dbPath = "";
let store: MemoryStore;

beforeEach(async () => {
	dbPath = join(mkdtempSync(join(tmpdir(), "evolve-archreason-")), "memory.db");
	store = await openMemoryStore(dbPath);
});

afterEach(() => {
	store.close();
});

function create(id: string, scope: "project" | "person" = "project"): void {
	const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [
		{ action: "create", id, type: "user", title: `标题 ${id}`, description: "钩子", body: "正文", scope },
	]);
	expect(outcome?.ok).toBe(true);
}

function reasonOf(id: string, workspaceId = WS): { reason: string; mergedInto: string | null } {
	const db = new DatabaseSync(dbPath);
	const row = db
		.prepare("SELECT archive_reason, merged_into FROM memories WHERE workspace_id = ? AND id = ?")
		.get(workspaceId, id) as { archive_reason: string; merged_into: string | null };
	db.close();
	return { reason: row.archive_reason, mergedInto: row.merged_into };
}

describe("writers stamp reasons", () => {
	it("starts unclassified on fresh rows", () => {
		create("m-a");
		expect(reasonOf("m-a")).toEqual({ reason: "", mergedInto: null });
		const record = store.get(WS, "m-a");
		expect(record?.archiveReason).toBe("");
		expect(record?.mergedInto).toBeNull();
	});

	it("stamps promoted-source on the提级 source row", () => {
		create("m-p", "person");
		expect(store.promoteMemory(WS, "m-p").ok).toBe(true);
		expect(reasonOf("m-p")).toEqual({ reason: "promoted-source", mergedInto: null });
	});

	it("stamps demoted-source on the降级 global row", () => {
		create("m-p", "person");
		expect(store.promoteMemory(WS, "m-p").ok).toBe(true);
		expect(store.demoteMemory("", "m-p").ok).toBe(true);
		expect(reasonOf("m-p", "")).toEqual({ reason: "demoted-source", mergedInto: null });
	});

	it("stamps review-archive on review archiving", () => {
		create("m-a");
		expect(store.archiveMemory(WS, "m-a")).toBe(true);
		expect(reasonOf("m-a")).toEqual({ reason: "review-archive", mergedInto: null });
	});

	it("rejects reasons outside the closed set", () => {
		create("m-a");
		const db = new DatabaseSync(dbPath);
		const { memories } = openRepositories(db);
		expect(() => memories.archiveWithReason(WS, "m-a", new Date().toISOString(), "bogus" as never, null)).toThrow();
		db.close();
	});
});

describe("old stores migrate", () => {
	/** A pre-P4 memories table: 17 columns, no reason columns, no whitelist. */
	const OLD_DDL = `CREATE TABLE memories (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('user','feedback','reference')),
  title TEXT NOT NULL, description TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) <= 65536),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','quarantined','archived')),
  source_session TEXT, source_seqs TEXT, source_run TEXT, corrects TEXT,
  scope TEXT NOT NULL DEFAULT 'project', probation_until TEXT, origin_workspace TEXT,
  not_when TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)) STRICT`;

	it("gains the columns with data preserved and the whitelist installed", async () => {
		const legacyPath = join(mkdtempSync(join(tmpdir(), "evolve-legacy-")), "memory.db");
		const setup = new DatabaseSync(legacyPath);
		setup.exec(OLD_DDL);
		setup
			.prepare("INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
			.run(WS, "m-old", "user", "旧标题", "钩子", "旧正文", "active", "s0", null, null, null, "project", null, null, "", "2026-01-01", "2026-01-02");
		setup
			.prepare("INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
			.run(WS, "m-gone", "user", "逝标题", "钩子", "逝正文", "archived", "s0", null, null, null, "project", null, null, "", "2026-01-01", "2026-01-02");
		setup.close();

		const db = await openDatabase(legacyPath);
		migrateDatabase(db);
		const columns = (
			db.prepare("SELECT name FROM pragma_table_info('memories')").all() as { name: string }[]
		).map((column) => column.name);
		expect(columns).toContain("archive_reason");
		expect(columns).toContain("merged_into");
		const live = db.prepare("SELECT body, archive_reason FROM memories WHERE workspace_id = ? AND id = ?").get(WS, "m-old") as {
			body: string;
			archive_reason: string;
		};
		expect(live).toMatchObject({ body: "旧正文", archive_reason: "" });
		expect(driftedTables(db, GUARDED_TABLES).map((spec) => spec.table)).not.toContain("memories");
		db.close();
	});
});

describe("card archive zone", () => {
	it("lists archived rows newest-first with reasons and merge pointers", () => {
		create("m-a");
		expect(store.archiveMemory(WS, "m-a")).toBe(true);
		const snapshot = memorySnapshot(store, WS);
		expect(snapshot.archived.length).toBe(1);
		expect(snapshot.archived[0]).toMatchObject({ id: "m-a", reason: "review-archive", mergedInto: null });
	});

	it("caps the listing at the viewer limit", () => {
		for (let index = 0; index < 3; index += 1) {
			create(`m-${String(index)}`);
			expect(store.archiveMemory(WS, `m-${String(index)}`)).toBe(true);
		}
		expect(store.listArchived(WS, 2).length).toBe(2);
		expect(store.listArchived(WS).length).toBe(3);
	});
});
