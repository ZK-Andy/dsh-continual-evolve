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
});
