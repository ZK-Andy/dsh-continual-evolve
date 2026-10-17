import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/data/migrate.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";
import { ITEM_EVENT_KINDS } from "../src/store-types.js";

/**
 * The review queue's event tier (ADR `2026-10-17-review-and-tiering-batch-rollout`,
 * stage A1): linkage events land with the write that caused them, an item is
 * pending while its latest event is newer than its latest complete verdict,
 * and the settled streak is derived from the verdict rows — never stored.
 */
const WS = "/tmp/work/event-tests";

let dbPath = "";
let store: MemoryStore;

beforeEach(async () => {
	dbPath = join(mkdtempSync(join(tmpdir(), "evolve-events-")), "memory.db");
	store = await openMemoryStore(dbPath);
});

afterEach(() => {
	store.close();
});

function create(id: string, title: string): void {
	const [outcome] = store.applyProposals(
		{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
		[{ action: "create", id, type: "user", title, description: "描述", body: "正文" }],
	);
	expect(outcome?.ok).toBe(true);
}

function keep(id: string, ts: string): void {
	store.logReview({ workspaceId: WS, itemKind: "memory", itemId: id, verdict: "keep", reason: "ok" });
	setReviewInstant(id, ts);
}

function verdict(id: string, kind: "keep" | "rewrite" | "quarantine" | "skip", reason?: string): void {
	store.logReview({ workspaceId: WS, itemKind: "memory", itemId: id, verdict: kind, reason });
}

/** Rewrite the newest verdict row's instant, so event ordering is testable. */
function setReviewInstant(id: string, ts: string): void {
	const db = new DatabaseSync(dbPath);
	db.prepare("UPDATE review_log SET ts = ? WHERE item_id = ? AND rowid = (SELECT MAX(rowid) FROM review_log WHERE item_id = ?)").run(ts, id, id);
	db.close();
}

function setEventInstant(id: string, ts: string): void {
	const db = new DatabaseSync(dbPath);
	db.prepare("UPDATE item_events SET ts = ? WHERE item_id = ?").run(ts, id);
	db.close();
}

describe("item_events storage", () => {
	it("adds the event table and the rollup source columns to an existing store", () => {
		const db = new DatabaseSync(dbPath);
		// Simulate a store created before this stage: drop what A1 adds.
		db.exec("DROP TABLE item_events");
		db.exec("CREATE TABLE review_daily_old AS SELECT day, budget, reviewed, new_items, requeued, approved, applied, cheap_token, evolve_token, backlog, dropped, skip_top, skip_counts FROM review_daily");
		db.exec("DROP TABLE review_daily");
		db.exec("ALTER TABLE review_daily_old RENAME TO review_daily");
		migrateDatabase(db);
		const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
		expect(tables).toContain("item_events");
		const daily = (db.prepare("SELECT name FROM pragma_table_info('review_daily')").all() as { name: string }[]).map((row) => row.name);
		for (const column of ["requeued_link", "requeued_sampled", "requeued_clock"]) {
			expect(daily).toContain(column);
		}
		db.close();
	});

	it("is idempotent: a second open changes no DDL", () => {
		const db = new DatabaseSync(dbPath);
		const before = (db.prepare("SELECT sql FROM sqlite_master WHERE name IN ('item_events','review_daily') ORDER BY name").all() as { sql: string }[])
			.map((row) => row.sql)
			.join("\n");
		migrateDatabase(db);
		migrateDatabase(db);
		const after = (db.prepare("SELECT sql FROM sqlite_master WHERE name IN ('item_events','review_daily') ORDER BY name").all() as { sql: string }[])
			.map((row) => row.sql)
			.join("\n");
		expect(after).toBe(before);
		db.close();
	});

	it("declares the event whitelist the code writes", () => {
		const db = new DatabaseSync(dbPath);
		const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'item_events'").get() as { sql: string }).sql;
		for (const kind of ITEM_EVENT_KINDS) {
			expect(sql).toContain(`'${kind}'`);
		}
		db.close();
	});
});

describe("reviewEventQueue", () => {	it("queues an item only when its event is newer than its latest complete verdict", () => {
		create("m-a", "甲");
		create("m-b", "乙");
		store.recordItemEvents([{ workspaceId: WS, kind: "memory", id: "m-a", event: "similar", sourceId: "m-b" }]);
		expect(store.reviewEventQueue().map((row) => row.id)).toEqual(["m-a"]);

		keep("m-a", "2099-01-01T00:00:00.000Z");
		expect(store.reviewEventQueue()).toEqual([]);
	});

	it("keeps a failure verdict from consuming the event", () => {
		create("m-a", "甲");
		store.recordItemEvents([{ workspaceId: WS, kind: "memory", id: "m-a", event: "corrects" }]);
		verdict("m-a", "skip", "gate-llm-failed: boom");
		// Newer than the event by a wide margin, yet incomplete: still pending.
		setReviewInstant("m-a", "2099-01-01T00:00:00.000Z");
		expect(store.reviewEventQueue().map((row) => row.id)).toEqual(["m-a"]);
	});

	it("keeps partitions apart", () => {
		create("m-a", "甲");
		store.recordItemEvents([{ workspaceId: "/other", kind: "memory", id: "m-a", event: "similar" }]);
		expect(store.reviewEventQueue()).toEqual([{ workspaceId: "/other", kind: "memory", id: "m-a" }]);
	});
});

describe("reviewSettled", () => {
	it("counts consecutive keeps from the last reset", () => {
		create("m-a", "甲");
		verdict("m-a", "keep");
		verdict("m-a", "keep");
		expect(store.reviewSettled(WS, "memory", "m-a").keeps).toBe(2);

		// A rewrite is a reset: only the keep after it counts.
		verdict("m-a", "rewrite", "tidy");
		setReviewInstant("m-a", "2099-01-01T00:00:00.000Z");
		verdict("m-a", "keep");
		setReviewInstant("m-a", "2099-01-02T00:00:00.000Z");
		expect(store.reviewSettled(WS, "memory", "m-a").keeps).toBe(1);
	});

	it("resets the streak at a linkage event", () => {
		create("m-a", "甲");
		verdict("m-a", "keep");
		verdict("m-a", "keep");
		store.recordItemEvents([{ workspaceId: WS, kind: "memory", id: "m-a", event: "correction" }]);
		// The two keeps predate the event: the streak restarts from zero.
		const db = new DatabaseSync(dbPath);
		db.prepare("UPDATE item_events SET ts = ? WHERE item_id = ?").run("2099-01-01T00:00:00.000Z", "m-a");
		db.close();
		expect(store.reviewSettled(WS, "memory", "m-a").keeps).toBe(0);
		expect(store.reviewSettled(WS, "memory", "m-a").lastEventTs).toBe("2099-01-01T00:00:00.000Z");
	});

	it("never throws for an item with no history", () => {
		expect(store.reviewSettled(WS, "memory", "never-written")).toEqual({ keeps: 0, lastEventTs: null });
	});
});

describe("event retention", () => {
	it("prunes events with the other ledgers", () => {
		create("m-a", "甲");
		store.recordItemEvents([{ workspaceId: WS, kind: "memory", id: "m-a", event: "similar" }]);
		setEventInstant("m-a", "2000-01-01T00:00:00.000Z");
		expect(store.pruneLedger("2026-01-01T00:00:00.000Z")).toBeGreaterThan(0);
		expect(store.reviewEventQueue()).toEqual([]);
	});
});

describe("linkage at the write gate", () => {
	function createTyped(id: string, title: string, type: "user" | "feedback" | "reference" = "user", corrects?: string): void {
		const [outcome] = store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{
				action: "create", id, type, title, description: "描述",
				body: type === "feedback" ? "规则先行。\n\n**Why:** 因为。\n\n**How to apply:** 照做。" : "正文",
				...(corrects === undefined ? {} : { corrects }),
			}],
		);
		expect(outcome?.ok).toBe(true);
	}

	it("links the neighbours a new title lands near", () => {
		createTyped("m-a", "proxy chengdu");
		createTyped("m-b", "proxy budget");
		expect(store.reviewEventQueue()).toEqual([{ workspaceId: WS, kind: "memory", id: "m-a" }]);
	});

	it("links on the leading CJK run", () => {
		createTyped("m-a", "网络环境成都电信");
		createTyped("m-b", "网络环境备用线路");
		expect(store.reviewEventQueue().map((row) => row.id)).toEqual(["m-a"]);
	});

	it("labels a feedback write as a correction of the topic", () => {
		createTyped("m-a", "proxy chengdu");
		createTyped("m-c", "proxy chengdu budget is low", "feedback");
		const db = new DatabaseSync(dbPath);
		const kinds = (db.prepare("SELECT event FROM item_events WHERE item_id = 'm-a'").all() as { event: string }[]).map((row) => row.event);
		db.close();
		expect(kinds).toEqual(["correction"]);
	});

	it("links the corrects target even when the titles share nothing", () => {
		createTyped("m-a", "alpha");
		createTyped("m-d", "zulu", "user", "m-a");
		const db = new DatabaseSync(dbPath);
		const kinds = (db.prepare("SELECT item_id AS id, event FROM item_events WHERE source_id = 'm-d'").all() as { id: string; event: string }[]);
		db.close();
		expect(kinds).toEqual([{ id: "m-a", event: "corrects" }]);
	});

	it("links nothing for a text-only update", () => {
		createTyped("m-a", "proxy chengdu");
		const before = store.reviewEventQueue().length;
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "item-review" }, [
			{ action: "update", id: "m-a", body: "改写后的正文" },
		]);
		expect(outcome?.ok).toBe(true);
		expect(store.reviewEventQueue().length).toBe(before);
	});
});
