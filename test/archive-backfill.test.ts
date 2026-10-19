import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillArchiveReasons } from "../src/data/archive-backfill.js";
import { openDatabase } from "../src/data/database.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

/**
 * Archive-reason backfill: rows archived before P4 gain their reason from the
 * ledgers, partition-aware; rows without evidence stay unclassified.
 */
const WS = "/tmp/work/archive-backfill";

let dbPath = "";
let store: MemoryStore;

beforeEach(async () => {
	dbPath = join(mkdtempSync(join(tmpdir(), "evolve-backfill-")), "memory.db");
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

function reasonOf(id: string, workspaceId = WS): { reason: string } {
	const db = new DatabaseSync(dbPath);
	const row = db
		.prepare("SELECT archive_reason FROM memories WHERE workspace_id = ? AND id = ?")
		.get(workspaceId, id) as { archive_reason: string };
	db.close();
	return { reason: row.archive_reason };
}

function resetReason(id: string, workspaceId = WS): void {
	const db = new DatabaseSync(dbPath);
	db.prepare("UPDATE memories SET archive_reason = '', merged_into = NULL WHERE workspace_id = ? AND id = ?").run(workspaceId, id);
	db.close();
}

describe("backfill projects reasons", () => {
	it("recovers promoted-source from the global promote verdict", async () => {
		create("m-p", "person");
		expect(store.promoteMemory(WS, "m-p").ok).toBe(true);
		resetReason("m-p");
		const db = await openDatabase(dbPath);
		const result = backfillArchiveReasons(db);
		db.close();
		expect(result.updated).toBe(1);
		expect(reasonOf("m-p").reason).toBe("promoted-source");
	});

	it("prefers demote evidence over the older promote verdict", async () => {
		create("m-p", "person");
		expect(store.promoteMemory(WS, "m-p").ok).toBe(true);
		expect(store.demoteMemory("", "m-p").ok).toBe(true);
		resetReason("m-p", "");
		const db = await openDatabase(dbPath);
		const result = backfillArchiveReasons(db);
		db.close();
		expect(result.updated).toBe(1);
		expect(reasonOf("m-p", "").reason).toBe("demoted-source");
	});

	it("recovers review-archive from an applied archive verdict", async () => {
		create("m-a");
		expect(store.archiveMemory(WS, "m-a")).toBe(true);
		resetReason("m-a");
		store.logReview({ workspaceId: WS, itemKind: "memory", itemId: "m-a", verdict: "archive" as never, applied: 1 });
		const db = await openDatabase(dbPath);
		const result = backfillArchiveReasons(db);
		db.close();
		expect(result.updated).toBe(1);
		expect(reasonOf("m-a").reason).toBe("review-archive");
	});

	it("leaves rows without evidence unclassified and reports them", async () => {
		create("m-a");
		expect(store.archiveMemory(WS, "m-a")).toBe(true);
		resetReason("m-a");
		const db = await openDatabase(dbPath);
		const before = backfillArchiveReasons(db);
		expect(before.updated).toBe(0);
		expect(before.skipped).toEqual([{ workspaceId: WS, id: "m-a" }]);
		// Idempotent: a second pass changes nothing.
		expect(backfillArchiveReasons(db).updated).toBe(0);
		db.close();
		expect(reasonOf("m-a").reason).toBe("");
	});

	it("does nothing on a store with no unclassified rows", async () => {
		create("m-a");
		const db = await openDatabase(dbPath);
		expect(backfillArchiveReasons(db)).toEqual({ updated: 0, skipped: [] });
		db.close();
	});

	it("rolls back and rethrows when the ledgers are unreadable", async () => {
		create("m-a");
		expect(store.archiveMemory(WS, "m-a")).toBe(true);
		resetReason("m-a");
		const db = await openDatabase(dbPath);
		db.exec("DROP TABLE review_log");
		expect(() => backfillArchiveReasons(db)).toThrow();
		db.close();
		expect(reasonOf("m-a").reason).toBe("");
	});

	/** A pre-P4 global archived row: verdicts, not the row, say where it stalled. */
	function insertGlobalArchived(id: string, origin: string | null): void {
		const db = new DatabaseSync(dbPath);
		db.prepare(
			"INSERT INTO memories (workspace_id, id, type, title, description, body, status, source_session, source_seqs, source_run, corrects, scope, probation_until, origin_workspace, not_when, archive_reason, merged_into, created_at, updated_at) VALUES ('', ?, 'user', ?, 'd', 'b', 'archived', NULL, NULL, NULL, NULL, 'project', NULL, ?, '', '', NULL, '2026-01-01', '2026-01-02')",
		).run(id, `标题 ${id}`, origin);
		db.close();
	}

	function logGlobalVerdict(id: string, verdict: "promote" | "demote", workspaceId = ""): void {
		store.logReview({ workspaceId, itemKind: "memory", itemId: id, verdict: verdict as never, applied: 1 });
	}

	it("reads a global row with an origin but no demote verdict as promoted", async () => {
		insertGlobalArchived("m-g", WS);
		logGlobalVerdict("m-g", "promote");
		const db = await openDatabase(dbPath);
		expect(backfillArchiveReasons(db).updated).toBe(1);
		db.close();
		expect(reasonOf("m-g", "").reason).toBe("promoted-source");
	});

	it("reads a global row with no recorded origin as promoted", async () => {
		insertGlobalArchived("m-g", null);
		logGlobalVerdict("m-g", "promote");
		const db = await openDatabase(dbPath);
		expect(backfillArchiveReasons(db).updated).toBe(1);
		db.close();
		expect(reasonOf("m-g", "").reason).toBe("promoted-source");
	});

	it("leaves a global row without verdicts unclassified", async () => {
		insertGlobalArchived("m-g", WS);
		const db = await openDatabase(dbPath);
		const result = backfillArchiveReasons(db);
		expect(result.updated).toBe(0);
		expect(result.skipped).toEqual([{ workspaceId: "", id: "m-g" }]);
		db.close();
	});

	it("backfills automatically when the store reopens (no manual script)", async () => {
		create("m-auto");
		expect(store.archiveMemory(WS, "m-auto")).toBe(true);
		store.logReview({ workspaceId: WS, itemKind: "memory", itemId: "m-auto", verdict: "archive" as never, applied: 1 });
		resetReason("m-auto");
		expect(reasonOf("m-auto").reason).toBe("");
		// Reopen the same file: migrateDatabase runs the backfill on mount.
		store.close();
		store = await openMemoryStore(dbPath);
		expect(reasonOf("m-auto").reason).toBe("review-archive");
	});
});
