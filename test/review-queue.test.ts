import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectCandidates, exemptionFactor } from "../src/services/review-candidates.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

/**
 * The queue's single decision table (ADR
 * `2026-10-17-review-and-tiering-batch-rollout`): the calendar only samples,
 * events are the engine, and a settled item buys itself a longer exemption.
 */
const WS = "/tmp/work/queue-tests";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-17T12:00:00.000Z");

let dbPath = "";
let store: MemoryStore;

beforeEach(async () => {
	dbPath = join(mkdtempSync(join(tmpdir(), "evolve-queue-")), "memory.db");
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

/** Age one row by rewriting its write instant, the calendar's only input. */
function age(id: string, days: number): void {
	const db = new DatabaseSync(dbPath);
	db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?").run(new Date(NOW - days * DAY).toISOString(), id);
	db.close();
}

/** Land `keeps` keep verdicts at explicit instants, so the streak is readable. */
function keeps(id: string, count: number, startDaysAgo: number): void {
	const db = new DatabaseSync(dbPath);
	for (let index = 0; index < count; index += 1) {
		const ts = new Date(NOW - (startDaysAgo - index * 0.1) * DAY).toISOString();
		db.prepare("INSERT INTO review_log (ts, workspace_id, item_kind, item_id, verdict, applied) VALUES (?, ?, 'memory', ?, 'keep', 0)")
			.run(ts, WS, id);
	}
	db.close();
}

function queue(batchSize = 10): { id: string; source: string }[] {
	return collectCandidates(store, { now: NOW, staleDays: 30, batchSize, limit: 100 }).map((row) => ({ id: row.id, source: row.source }));
}

describe("queue tiers", () => {
	it("orders new items ahead of event requeues ahead of samples", () => {
		create("m-old", "old one");
		age("m-old", 60);
		keeps("m-old", 1, 50);
		create("m-linked", "linked one");
		keeps("m-linked", 1, 20);
		store.recordItemEvents([{ workspaceId: WS, kind: "memory", id: "m-linked", event: "similar" }]);
		create("m-new", "brand new");

		expect(queue()).toEqual([
			{ id: "m-new", source: "new" },
			{ id: "m-linked", source: "event" },
			{ id: "m-old", source: "sample" },
		]);
	});

	it("keeps the sampling quota to a fifth of the batch", () => {
		for (let index = 0; index < 12; index += 1) {
			create(`m-${index}`, `stale ${index}`);
			age(`m-${index}`, 60 + index);
			keeps(`m-${index}`, 1, 50);
		}
		const sampled = queue(10).filter((row) => row.source === "sample");
		expect(sampled.length).toBe(2);
		// Oldest first: the ones aged longest win the draw.
		expect(sampled.map((row) => row.id)).toEqual(["m-11", "m-10"]);
	});

	it("leaves the queue empty when nothing is new, linked, or stale", () => {
		create("m-a", "fresh one");
		keeps("m-a", 1, 1);
		expect(queue()).toEqual([]);
	});
});

describe("exemption by keep streak", () => {
	it("doubles the window at two keeps and quadruples at four", () => {
		expect(exemptionFactor(0)).toBe(1);
		expect(exemptionFactor(1)).toBe(1);
		expect(exemptionFactor(2)).toBe(2);
		expect(exemptionFactor(3)).toBe(2);
		expect(exemptionFactor(4)).toBe(4);
		expect(exemptionFactor(9)).toBe(4);
	});

	it("does not sample a settled item inside its stretched window", () => {
		create("m-settled", "settled one");
		age("m-settled", 45);
		keeps("m-settled", 2, 40);
		expect(queue()).toEqual([]);
	});

	it("samples the same item once its quadrupled window passes", () => {
		create("m-settled", "settled one");
		age("m-settled", 125);
		keeps("m-settled", 4, 124);
		expect(queue()).toEqual([{ id: "m-settled", source: "sample" }]);
	});

	it("clears the streak at a linkage event, so the base window returns", () => {
		create("m-a", "settled then linked");
		age("m-a", 45);
		keeps("m-a", 4, 100);
		store.recordItemEvents([{ workspaceId: WS, kind: "memory", id: "m-a", event: "correction" }]);
		// The event is newer than every keep: the streak restarts at zero and the
		// item is in the queue — as an event, not as a sample.
		expect(queue()).toEqual([{ id: "m-a", source: "event" }]);
	});
});

describe("rollup per-source account", () => {
	it("derives the total from the three sources", () => {
		store.mergeDaily("2026-10-17", 100, { newItems: 1, requeuedLink: 2, requeuedClock: 3, requeuedSampled: 4 });
		const daily = store.getDaily("2026-10-17");
		expect(daily?.requeued).toBe(9);
		expect(daily?.requeuedLink).toBe(2);
		expect(daily?.requeuedClock).toBe(3);
		expect(daily?.requeuedSampled).toBe(4);
		expect(daily?.newItems).toBe(1);
	});

	it("keeps the identity across merges", () => {
		store.mergeDaily("2026-10-17", 100, { newItems: 2, requeuedLink: 1, requeuedSampled: 1 });
		store.mergeDaily("2026-10-17", 100, { requeuedLink: 3, requeuedClock: 1 });
		const daily = store.getDaily("2026-10-17");
		expect(daily?.requeued).toBe((daily?.requeuedLink ?? 0) + (daily?.requeuedClock ?? 0) + (daily?.requeuedSampled ?? 0));
	});
});
