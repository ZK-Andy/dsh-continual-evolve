import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/data/migrate.js";
import { REVIEW_VERDICTS } from "../src/data/review-accounts.js";
import { driftedTables } from "../src/data/schema.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

/**
 * Stage B1 storage (`2026-10-17-review-and-tiering-batch-rollout`): the
 * promotion columns on `memories`, and the widened verdict whitelist that the
 * tiering exits need — installed on stores that predate them.
 */
const WS = "/tmp/work/tiering-tests";

/** The pre-tiering review ledger: four verdicts, no `archive/promote/demote`. */
const OLD_REVIEW_LOG = `CREATE TABLE review_log (
  run_id TEXT, ts TEXT NOT NULL, workspace_id TEXT,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('memory','skill')),
  item_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('keep','rewrite','quarantine','skip')),
  reason TEXT, proposed TEXT, model TEXT,
  cheap_usage TEXT, evolve_usage TEXT,
  applied INTEGER NOT NULL DEFAULT 0, evolve_count INTEGER NOT NULL DEFAULT 0)`;

/** The pre-tiering memories table: no `scope`, no `probation_until`. */
const OLD_MEMORIES = `CREATE TABLE memories (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('user','feedback','reference')),
  title TEXT NOT NULL, description TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) <= 65536),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','quarantined','archived')),
  source_session TEXT, source_seqs TEXT, source_run TEXT, corrects TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)) STRICT`;

let root = "";
let dbPath = "";
let store: MemoryStore | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "evolve-tiering-"));
	dbPath = join(root, "memory.db");
});

afterEach(() => {
	store?.close();
	store = undefined;
});

/** A store as v0.17.0 left it: old memories, old verdict whitelist, one row each. */
function oldStore(): void {
	const db = new DatabaseSync(dbPath);
	db.exec(OLD_MEMORIES);
	db.exec(OLD_REVIEW_LOG);
	db.prepare(
		"INSERT INTO memories (workspace_id, id, type, title, description, body, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
	).run(WS, "m-old", "user", "老条目", "钩子", "正文", "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
	db.prepare(
		"INSERT INTO review_log (ts, workspace_id, item_kind, item_id, verdict, applied) VALUES (?,?,?,?,?,?)",
	).run("2026-10-02T00:00:00.000Z", WS, "memory", "m-old", "keep", 0);
	db.close();
}

function columnsOf(table: string): string[] {
	const db = new DatabaseSync(dbPath);
	const names = (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((row) => row.name);
	db.close();
	return names;
}

describe("memory tiering columns", () => {
	it("adds scope and probation_until to a store that predates them", () => {
		oldStore();
		const db = new DatabaseSync(dbPath);
		migrateDatabase(db);
		db.close();
		const columns = columnsOf("memories");
		expect(columns).toContain("scope");
		expect(columns).toContain("probation_until");
	});

	it("keeps existing rows and defaults their scope to project", async () => {
		oldStore();
		store = await openMemoryStore(dbPath);
		const record = store.get(WS, "m-old");
		expect(record?.scope).toBe("project");
		expect(record?.probationUntil).toBeNull();
		expect(record?.title).toBe("老条目");
	});
});

describe("review verdict whitelist", () => {
	it("rebuilds the ledger so the tiering exits are accepted", () => {
		oldStore();
		const db = new DatabaseSync(dbPath);
		migrateDatabase(db);
		const live = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'review_log'").get() as { sql: string };
		for (const verdict of REVIEW_VERDICTS) {
			expect(live.sql).toContain(`'${verdict}'`);
		}
		// The old row survived the rebuild.
		const kept = db.prepare("SELECT COUNT(*) AS n FROM review_log").get() as { n: number };
		expect(kept.n).toBe(1);
		db.prepare("INSERT INTO review_log (ts, workspace_id, item_kind, item_id, verdict) VALUES (?,?,?,?,?)").run(
			"2026-10-03T00:00:00.000Z",
			WS,
			"memory",
			"m-old",
			"archive",
		);
		db.close();
		expect(driftedTables(new DatabaseSync(dbPath))).toEqual([]);
	});

	it("is idempotent: a second open changes nothing", () => {
		oldStore();
		const first = new DatabaseSync(dbPath);
		migrateDatabase(first);
		const before = (first.prepare("SELECT sql FROM sqlite_master WHERE name = 'review_log'").get() as { sql: string }).sql;
		migrateDatabase(first);
		const after = (first.prepare("SELECT sql FROM sqlite_master WHERE name = 'review_log'").get() as { sql: string }).sql;
		first.close();
		expect(after).toBe(before);
	});
});

describe("scope on the write path", () => {
	it("defaults to project and stores an explicit person marker", async () => {
		store = await openMemoryStore(dbPath);
		store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [
			{ action: "create", id: "m-plain", type: "user", title: "plain", description: "d", body: "b" },
			{ action: "create", id: "m-person", type: "user", title: "person", description: "d", body: "b", scope: "person" },
		]);
		expect(store.get(WS, "m-plain")?.scope).toBe("project");
		expect(store.get(WS, "m-person")?.scope).toBe("person");
	});

	it("keeps the stored scope when an update omits it", async () => {
		store = await openMemoryStore(dbPath);
		store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [
			{ action: "create", id: "m-person", type: "user", title: "person", description: "d", body: "b", scope: "person" },
		]);
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "item-review" }, [
			{ action: "update", id: "m-person", body: "改写后的正文" },
		]);
		expect(outcome?.ok).toBe(true);
		expect(store.get(WS, "m-person")?.scope).toBe("person");
	});

	it("rejects an unknown scope", async () => {
		store = await openMemoryStore(dbPath);
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [
			{ action: "create", id: "m-bad", type: "user", title: "bad", description: "d", body: "b", scope: "global" },
		]);
		expect(outcome?.ok).toBe(false);
		expect(outcome?.reason).toContain("scope");
	});
});
