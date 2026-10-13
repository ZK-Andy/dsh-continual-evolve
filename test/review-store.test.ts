import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

let dbPath = "";
let store: MemoryStore;
const WS = "/tmp/work/review-tests";

beforeEach(async () => {
	dbPath = join(mkdtempSync(join(tmpdir(), "evolve-review-")), "memory.db");
	store = await openMemoryStore(dbPath);
});

afterEach(() => {
	store.close();
});

function rawDb(): DatabaseSync {
	return new DatabaseSync(dbPath);
}

function create(title = "user env"): void {
	const [outcome] = store.applyProposals(
		{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
		[{ action: "create", type: "user", title, description: "用户的操作系统", body: "Fedora 44" }],
	);
	expect(outcome?.ok).toBe(true);
}

describe("memory usage accounting", () => {
	it("counts servings per partition, unknown memories read undefined", () => {
		expect(store.getMemoryUse(WS, "user-env")).toBeUndefined();
		create();
		store.recordMemoryUse(WS, "user-env");
		store.recordMemoryUse(WS, "user-env");
		const use = store.getMemoryUse(WS, "user-env");
		expect(use?.useCount).toBe(2);
		expect(typeof use?.lastUsedAt).toBe("string");
		expect(store.getMemoryUse(WS, "other")).toBeUndefined();
	});

	it("keeps partitions apart and never throws on faults", () => {
		store.recordMemoryUse(WS, "shared");
		store.recordMemoryUse("/other", "shared");
		expect(store.getMemoryUse(WS, "shared")?.useCount).toBe(1);
		expect(store.getMemoryUse("/other", "shared")?.useCount).toBe(1);
		expect(() => store.recordMemoryUse(undefined as never, "shared")).not.toThrow();
		expect(store.getMemoryUse(undefined as never, "shared")).toBeUndefined();
	});
});

describe("review verdict log", () => {
	it("lands one row per verdict with usage JSON and applied flag", () => {
		store.logReview({
			runId: "review:1", workspaceId: WS, itemKind: "memory", itemId: "user-env",
			verdict: "keep", reason: "准确可用", cheapUsage: { total: 300 }, applied: 0, evolveCount: 0,
		});
		store.logReview({
			runId: "review:1", workspaceId: WS, itemKind: "skill", itemId: "deploy",
			verdict: "rewrite", reason: "触发词太窄", evolveUsage: { total: 1200 }, applied: 1, evolveCount: 2,
		});
		const raw = rawDb();
		try {
			const rows = raw.prepare("SELECT item_kind, item_id, verdict, applied, evolve_count FROM review_log ORDER BY rowid").all() as {
				item_kind: string; item_id: string; verdict: string; applied: number; evolve_count: number;
			}[];
			expect(rows).toEqual([
				{ item_kind: "memory", item_id: "user-env", verdict: "keep", applied: 0, evolve_count: 0 },
				{ item_kind: "skill", item_id: "deploy", verdict: "rewrite", applied: 1, evolve_count: 2 },
			]);
		} finally {
			raw.close();
		}
	});

	it("keeps the proposed rewrite on rows that did not land it", () => {
		store.logReview({
			workspaceId: WS, itemKind: "memory", itemId: "user-env", verdict: "rewrite",
			reason: "试运行未落盘：补版本", proposed: { title: "新标题", body: "Fedora 44.1" }, applied: 0,
		});
		const raw = rawDb();
		try {
			const row = raw.prepare("SELECT proposed FROM review_log ORDER BY rowid DESC LIMIT 1").get() as { proposed: string | null };
			expect(JSON.parse(row.proposed ?? "null")).toEqual({ title: "新标题", body: "Fedora 44.1" });
		} finally {
			raw.close();
		}
	});

	it("migrates pre-trial review ledgers with the proposed column", async () => {
		const legacyPath = join(mkdtempSync(join(tmpdir(), "evolve-review-legacy-")), "memory.db");
		const legacy = new DatabaseSync(legacyPath);
		try {
			legacy.exec(
				"CREATE TABLE review_log (run_id TEXT, ts TEXT NOT NULL, workspace_id TEXT, item_kind TEXT NOT NULL, " +
					"item_id TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT, cheap_usage TEXT, evolve_usage TEXT, " +
					"applied INTEGER NOT NULL DEFAULT 0, evolve_count INTEGER NOT NULL DEFAULT 0)",
			);
		} finally {
			legacy.close();
		}
		const migrated = await openMemoryStore(legacyPath);
		try {
			const probe = new DatabaseSync(legacyPath);
			try {
				const columns = probe.prepare("SELECT name FROM pragma_table_info('review_log')").all() as { name: string }[];
				expect(columns.some((column) => column.name === "proposed")).toBe(true);
			} finally {
				probe.close();
			}
			migrated.logReview({ workspaceId: WS, itemKind: "memory", itemId: "x", verdict: "rewrite", reason: "r", proposed: { body: "b" } });
		} finally {
			migrated.close();
		}
	});

	it("keeps an item queued while every row is an incomplete review", () => {
		store.logReview({
			workspaceId: WS, itemKind: "memory", itemId: "user-env",
			verdict: "skip", reason: "gate-llm-failed: stream finished with max-tokens",
		});
		expect(store.reviewStateOf(WS, "memory", "user-env")).toBeUndefined();
		store.logReview({ workspaceId: WS, itemKind: "memory", itemId: "user-env", verdict: "skip", reason: "no-route" });
		expect(store.reviewStateOf(WS, "memory", "user-env")).toBeUndefined();
		// A gate refusal is a finished review: the item stops requeueing.
		store.logReview({
			workspaceId: WS, itemKind: "memory", itemId: "user-env",
			verdict: "skip", reason: "本机环境状态事实，不跟人走",
		});
		expect(store.reviewStateOf(WS, "memory", "user-env")?.lastTs).toBeDefined();
		expect(store.reviewStateOf(WS, "memory", "user-env")?.evolveCount).toBe(0);
	});

	it("prunes with the ledgers instead of growing without bound", () => {
		store.logReview({ workspaceId: WS, itemKind: "memory", itemId: "a", verdict: "skip", reason: "cheap-gate" });
		expect(store.pruneLedger(new Date(Date.now() + 60_000).toISOString())).toBeGreaterThanOrEqual(1);
		const raw = rawDb();
		try {
			expect((raw.prepare("SELECT COUNT(*) AS n FROM review_log").get() as { n: number }).n).toBe(0);
		} finally {
			raw.close();
		}
	});
});

describe("daily hard-cap account", () => {
	it("consumes atomically and reports -1 past the budget", () => {
		expect(store.getDaily("2026-10-12")).toBeUndefined();
		expect(store.consumeReviewBudget("2026-10-12", 2)).toBe(1);
		expect(store.consumeReviewBudget("2026-10-12", 2)).toBe(0);
		expect(store.consumeReviewBudget("2026-10-12", 2)).toBe(-1);
		expect(store.getDaily("2026-10-12")).toMatchObject({ day: "2026-10-12", budget: 2, reviewed: 2 });
	});

	it("merges run counters additively and keeps the top skip reasons", () => {
		store.consumeReviewBudget("2026-10-12", 100);
		store.mergeDaily("2026-10-12", 100, {
			newItems: 3, approved: 1, applied: 1, cheapToken: 900, evolveToken: 1200,
			backlog: 4, dropped: 2, skipReasons: ["cheap-gate", "cheap-gate", "stale-fresh"],
		});
		store.mergeDaily("2026-10-12", 100, {
			newItems: 1, cheapToken: 100, backlog: 1, skipReasons: ["cheap-gate"],
		});
		expect(store.getDaily("2026-10-12")).toMatchObject({
			reviewed: 1, newItems: 4, approved: 1, applied: 1,
			cheapToken: 1000, evolveToken: 1200, backlog: 1, dropped: 2,
			skipTop: JSON.stringify(["cheap-gate", "stale-fresh"]),
		});
	});

	it("keeps the backlog depth on merges that do not report it", () => {
		store.consumeReviewBudget("2026-10-12", 100);
		store.mergeDaily("2026-10-12", 100, { backlog: 7 });
		store.mergeDaily("2026-10-12", 100, { newItems: 1 });
		expect(store.getDaily("2026-10-12")).toMatchObject({ backlog: 7, newItems: 1 });
	});

	it("degrades corrupt skip-count payloads to empty instead of throwing", () => {
		store.consumeReviewBudget("2026-10-12", 100);
		const raw = new DatabaseSync(dbPath);
		try {
			raw.prepare("UPDATE review_daily SET skip_counts = ? WHERE day = ?").run("not-json", "2026-10-12");
		} finally {
			raw.close();
		}
		expect(() => store.mergeDaily("2026-10-12", 100, { skipReasons: ["x"] })).not.toThrow();
		expect(store.getDaily("2026-10-12")?.skipTop).toBe(JSON.stringify(["x"]));
		const raw2 = new DatabaseSync(dbPath);
		try {
			raw2.prepare("UPDATE review_daily SET skip_counts = ? WHERE day = ?").run("{\"a\":\"nope\",\"b\":2.7}", "2026-10-12");
		} finally {
			raw2.close();
		}
		store.mergeDaily("2026-10-12", 100, { skipReasons: ["c"] });
		expect(store.getDaily("2026-10-12")?.skipTop).toBe(JSON.stringify(["b", "c"]));
	});

	it("quarantine and review-state degrade to false/undefined on faults", () => {
		expect(store.quarantine(undefined as never, "memory", "x")).toBe(false);
		expect(store.reviewStateOf(undefined as never, "memory", "x")).toBeUndefined();
	});
});
