import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

let dbPath = "";
let store: MemoryStore;
const WS = "/tmp/work/store-tests";

beforeEach(async () => {
	dbPath = join(mkdtempSync(join(tmpdir(), "evolve-store-")), "memory.db");
	store = await openMemoryStore(dbPath);
});

afterEach(() => {
	store.close();
});

/** Raw second connection for constraint/ledger assertions the API hides. */
function rawDb(): DatabaseSync {
	return new DatabaseSync(dbPath);
}

function create(overrides: Record<string, unknown> = {}): boolean {
	return store
		.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[
				{
					action: "create",
					type: "user",
					title: "user env",
					description: "用户的操作系统",
					body: "Fedora 44",
					...overrides,
				},
			],
		)[0]?.ok === true;
}

describe("openMemoryStore", () => {
	it("creates the database with WAL mode and STRICT schema", async () => {
		const raw = rawDb();
		expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
		// STRICT + CHECK: a bad type is physically rejected even below the gates.
		expect(() =>
			raw
				.prepare(
					"INSERT INTO memories (workspace_id, id, type, title, description, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', 't', 't')",
				)
				.run(WS, "bad-type", "project", "t", "d", "b"),
		).toThrow();
		expect(() =>
			raw
				.prepare(
					"INSERT INTO memories (workspace_id, id, type, title, description, body, status, created_at, updated_at) VALUES (?, ?, 'user', 't', 'd', ?, 'active', 't', 't')",
				)
				.run(WS, "big", "b".repeat(65_537)),
		).toThrow();
		raw.close();
	});

	it("keeps the store usable across reopen", async () => {
		expect(create()).toBe(true);
		store.close();
		store = await openMemoryStore(dbPath);
		expect(store.get(WS, "user-env")?.body).toBe("Fedora 44");
	});
});

describe("applyProposals — create/update/delete", () => {
	it("creates with provenance and derives the id from the title", () => {
		const [outcome] = store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-9" },
			[{ action: "create", type: "reference", title: "Exa 定价", description: "价格", body: "$7/1k" }],
		);
		expect(outcome?.ok).toBe(true);
		const record = store.get(WS, outcome?.id ?? "")!;
		expect(record.sourceSession).toBe("sess-9");
		expect(record.sourceRun).toBe("explicit");
		expect(record.status).toBe("active");
		expect(record.sourceSeqs).toBeNull();
	});

	it("update merges fields, keeps created_at, and stays FTS-searchable by new text", () => {
		expect(create({ title: "env facts" })).toBe(true);
		const before = store.get(WS, "env-facts")!;
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [
			{ action: "update", id: "env-facts", body: "now mentions openSUSE too" },
		]);
		expect(outcome?.ok).toBe(true);
		const after = store.get(WS, "env-facts")!;
		expect(after.body).toContain("openSUSE");
		expect(after.createdAt).toBe(before.createdAt);
		expect(after.updatedAt >= before.updatedAt).toBe(true);
		expect(store.search(WS, "openSUSE").map((r) => r.id)).toEqual(["env-facts"]);
	});

	it("delete removes the row and its FTS entry", () => {
		expect(create({ title: "to go", body: "quarantine me not" })).toBe(true);
		expect(store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [{ action: "delete", id: "to-go" }])[0]?.ok).toBe(true);
		expect(store.get(WS, "to-go")).toBeUndefined();
		expect(store.search(WS, "quarantine")).toEqual([]);
	});

	it("rejects unknown actions, malformed ids, and unknown targets", () => {
		const run = (proposal: unknown) =>
			store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [proposal as never])[0]?.ok === false;
		const runs = (proposal: unknown) =>
			store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [proposal as never])[0]?.ok === true;
		expect(run({ action: "upsert", id: "x" })).toBe(true);
		expect(run({ action: "create", id: "Bad Id", type: "user", title: "t", description: "d", body: "b" })).toBe(true);
		expect(runs({ action: "create", type: "user", title: "t", description: "d", body: "b" })).toBe(true); // id derived from the title
		expect(run({ action: "update", id: "ghost" })).toBe(true);
		expect(run({ action: "delete", id: "ghost" })).toBe(true);
		expect(run({ action: "create", id: "t", type: "user", title: "t again", description: "d", body: "b" })).toBe(true); // duplicate of the derived-id create above
		expect(run({ action: "create", type: "user" })).toBe(true); // no id derivable (no title)
		expect(run({ action: "create", title: "no type", description: "d", body: "b" })).toBe(true); // required field missing
	});
});

describe("applyProposals — gates and atomicity", () => {
	it("rejects a whole batch when one proposal fails, leaving no trace", () => {
		const outcomes = store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [
			{ action: "create", type: "user", title: "good one", description: "d", body: "b" },
			{ action: "create", type: "user", title: "bad one", description: "", body: "b" },
		]);
		expect(outcomes.some((o) => !o.ok)).toBe(true);
		expect(store.get(WS, "good-one")).toBeUndefined();
		const raw = rawDb();
		expect(raw.prepare("SELECT COUNT(*) AS n FROM memories WHERE workspace_id = ?").get(WS)).toEqual({ n: 0 });
		// The rejected run is still auditable.
		const ledger = raw.prepare("SELECT status, files FROM extraction_log WHERE workspace_id = ?").get(WS) as {
			status: string;
			files: string;
		};
		expect(ledger.status).toBe("rejected");
		expect(JSON.parse(ledger.files)).toEqual([]);
		raw.close();
	});

	it("ledgers applied batches with before/after snapshots", () => {
		expect(create({ title: "snap me" })).toBe(true);
		store.applyProposals({ workspaceId: WS, trigger: "explicit", runId: "run-1" }, [
			{ action: "update", id: "snap-me", body: "after text" },
			{ action: "delete", id: "snap-me" },
		]);
		const raw = rawDb();
		const row = raw.prepare("SELECT run_id, status, files FROM extraction_log ORDER BY ts DESC LIMIT 1").get() as {
			run_id: string;
			status: string;
			files: string;
		};
		expect(row.run_id).toBe("run-1");
		expect(row.status).toBe("applied");
		const files = JSON.parse(row.files) as { id: string; action: string; before?: { body: string }; after?: unknown }[];
		expect(files).toHaveLength(2);
		expect(files[0]?.before?.body).toBe("Fedora 44");
		expect(files[1]?.action).toBe("delete");
		expect(files[1]?.before).toBeDefined();
		expect(files[1]?.after).toBeUndefined();
		raw.close();
	});
});

describe("reads", () => {
	it("lists active records feedback > user > reference, newest first within type", () => {
		store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [
			{ action: "create", id: "ref", type: "reference", title: "r", description: "d", body: "b" },
			{ action: "create", id: "usr", type: "user", title: "u", description: "d", body: "b" },
			{ action: "create", id: "fdb", type: "feedback", title: "f", description: "d", body: "b\n**Why:** w\n**How to apply:** h" },
		]);
		expect(store.list(WS).map((r) => r.id)).toEqual(["fdb", "usr", "ref"]);
	});

	it("search handles trigram Chinese, quotes, short LIKE fallback, and limits", () => {
		store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [
			{ action: "create", id: "cjk", type: "user", title: "中文标题可以检索", description: "d", body: 'body with "quotes" inside' },
			{ action: "create", id: "other", type: "user", title: "unrelated", description: "d", body: "b" },
		]);
		expect(store.search(WS, "中文标题").map((r) => r.id)).toEqual(["cjk"]);
		expect(store.search(WS, 'with "quotes"').map((r) => r.id)).toEqual(["cjk"]);
		expect(store.search(WS, "中文").map((r) => r.id)).toEqual(["cjk"]); // <3 chars → LIKE
		// ≥3-char tokens that never appear adjacently: AND-combined, not a phrase.
		expect(store.search(WS, "中文标题 quotes").map((r) => r.id)).toEqual(["cjk"]);
		expect(store.search(WS, "unrelated", 0)).toEqual([]);
	});

	it("search AND-combines whitespace-separated keywords", () => {
		expect(create({ id: "both", title: "中文交接流程", description: "d", body: "记忆与交接都要用中文" })).toBe(true);
		expect(create({ id: "half", title: "只有中文", description: "d", body: "b" })).toBe(true);
		// 2-char tokens can never be trigrams: both must appear, as substrings.
		expect(store.search(WS, "中文 交接").map((r) => r.id)).toEqual(["both"]);
		// Mixed token shapes (title holds one, body the other) still AND via LIKE.
		expect(store.search(WS, "中文交接流程 记忆").map((r) => r.id)).toEqual(["both"]);
		expect(store.search(WS, "中文 不存在的词").map((r) => r.id)).toEqual([]);
		expect(store.search(WS, "   ")).toEqual([]);
	});

	it("search treats LIKE metacharacters literally", () => {
		expect(create({ id: "pct", title: "折扣", description: "d", body: "全场 50%off 起" })).toBe(true);
		expect(create({ id: "plain-o", title: "openSUSE", description: "d", body: "no percent here" })).toBe(true);
		expect(create({ id: "snake", title: "t", description: "d", body: "snakeXcase token" })).toBe(true);
		// `%` is escaped: only the row holding a literal "%o" matches.
		expect(store.search(WS, "%o").map((r) => r.id)).toEqual(["pct"]);
		// A lone `_` matches no row (unescaped it would match every non-empty body).
		expect(store.search(WS, "_")).toEqual([]);
		expect(store.search(WS, "snakeXcase").map((r) => r.id)).toEqual(["snake"]);
		// FTS misses "snake_case" (no such trigram) → LIKE fallback, `_` literal → no hit.
		expect(store.search(WS, "snake_case")).toEqual([]);
	});

	it("search excludes quarantined rows", () => {
		expect(create({ title: "quarantine target" })).toBe(true);
		const raw = rawDb();
		raw.prepare("UPDATE memories SET status = 'quarantined' WHERE id = 'quarantine-target'").run();
		raw.close();
		expect(store.search(WS, "Fedora")).toEqual([]);
		expect(store.list(WS)).toEqual([]);
	});
});

describe("state, cursors, workspaces", () => {
	it("roundtrips cursors and arbitrary state per workspace", () => {
		expect(store.cursor(WS, "s1")).toBeUndefined();
		store.setCursor(WS, "s1", 42);
		expect(store.cursor(WS, "s1")).toBe(42);
		store.setCursor(WS, "s1", 50);
		expect(store.cursor(WS, "s1")).toBe(50);
		expect(store.cursor(`${WS}-other`, "s1")).toBeUndefined();
		store.setState(WS, "k", "v");
		expect(store.state(WS, "k")).toBe("v");
		expect(store.state(WS, "missing")).toBeUndefined();
	});

	it("lists workspaces with active counts", () => {
		expect(store.listWorkspaces()).toEqual([]);
		expect(create()).toBe(true);
		store.applyProposals({ workspaceId: "/tmp/other", trigger: "explicit" }, [
			{ action: "create", type: "user", title: "t", description: "d", body: "b" },
		]);
		const workspaces = store.listWorkspaces();
		expect(workspaces.map((w) => w.workspaceId)).toEqual(["/tmp/other", WS]);
		expect(workspaces[1]?.activeCount).toBe(1);
	});
});

describe("mostRecentlyActiveWorkspace", () => {
	const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

	it("answers undefined for a store with no dated rows", () => {
		expect(store.mostRecentlyActiveWorkspace()).toBeUndefined();
	});

	it("follows the ledger: a newer session activity outranks an older memory write", async () => {
		expect(create()).toBe(true);
		await sleep(10);
		// A run that wrote nothing still ledgers — that is the activity signal.
		store.logSkipped({ workspaceId: "/tmp/other", trigger: "turn-debounce", skipReason: "no-user-prose", status: "skipped" });
		expect(store.mostRecentlyActiveWorkspace()).toBe("/tmp/other");
	});

	it("falls back to the newest memory write once the ledger is pruned", async () => {
		expect(create()).toBe(true);
		await sleep(10);
		store.applyProposals({ workspaceId: "/tmp/other", trigger: "explicit" }, [
			{ action: "create", type: "user", title: "t", description: "d", body: "b" },
		]);
		expect(store.mostRecentlyActiveWorkspace()).toBe("/tmp/other");
		// The ledger is the one prunable table; the memories are the durable
		// record and must carry the answer on their own.
		expect(store.pruneLedger(new Date(Date.now() + 60_000).toISOString())).toBe(2);
		expect(store.mostRecentlyActiveWorkspace()).toBe("/tmp/other");
	});

	it("ignores ledger rows that carry no workspace", () => {
		store.logSkipped({ trigger: "close-drain", skipReason: "internal-agent", status: "skipped" });
		expect(store.mostRecentlyActiveWorkspace()).toBeUndefined();
	});
});

describe("ledger maintenance", () => {
	it("logSkipped records no-mutation runs", () => {
		store.logSkipped({ workspaceId: WS, sessionId: "s", trigger: "turn-debounce", skipReason: "no-new-events", status: "skipped" });
		const raw = rawDb();
		const row = raw.prepare("SELECT trigger, skip_reason, files FROM extraction_log").get() as {
			trigger: string;
			skip_reason: string;
			files: string | null;
		};
		expect(row.trigger).toBe("turn-debounce");
		expect(row.skip_reason).toBe("no-new-events");
		expect(row.files).toBeNull();
		raw.close();
	});

	it("pruneLedger removes rows older than the cutoff", () => {
		store.logSkipped({ trigger: "compaction", skipReason: "x" });
		expect(store.pruneLedger(new Date(Date.now() + 60_000).toISOString())).toBe(1);
		expect(store.pruneLedger(new Date().toISOString())).toBe(0);
	});

	it("coalesces consecutive quiet-turn skips into one counted row", () => {
		const quiet = (): void => {
			store.logSkipped({ workspaceId: WS, sessionId: "s", trigger: "turn-debounce", skipReason: "no-user-prose", status: "skipped" });
		};
		quiet();
		quiet();
		quiet();
		const raw = rawDb();
		expect(raw.prepare("SELECT skip_reason, occurrences FROM extraction_log").all()).toEqual([
			{ skip_reason: "no-user-prose", occurrences: 3 },
		]);
		// Anything in between ends the chain: a model decision means the cursor
		// moved, so the next quiet turn is a new cursor position.
		store.logSkipped({ workspaceId: WS, sessionId: "s", trigger: "turn-debounce", skipReason: "model-skip: 无新事实", status: "skipped" });
		quiet();
		expect(raw.prepare("SELECT occurrences FROM extraction_log ORDER BY rowid").all()).toEqual([
			{ occurrences: 3 },
			{ occurrences: 1 },
			{ occurrences: 1 },
		]);
		raw.close();
	});

	it("keeps other sessions and fault-shaped skips one row apiece", () => {
		const skip = (sessionId: string, skipReason: string): void => {
			store.logSkipped({ workspaceId: WS, sessionId, trigger: "turn-debounce", skipReason, status: "skipped" });
		};
		skip("s1", "no-user-prose");
		skip("s2", "no-user-prose");
		skip("s1", "no-route");
		skip("s1", "no-route");
		const raw = rawDb();
		expect(raw.prepare("SELECT session_id, skip_reason, occurrences FROM extraction_log ORDER BY rowid").all()).toEqual([
			{ session_id: "s1", skip_reason: "no-user-prose", occurrences: 1 },
			{ session_id: "s2", skip_reason: "no-user-prose", occurrences: 1 },
			{ session_id: "s1", skip_reason: "no-route", occurrences: 1 },
			{ session_id: "s1", skip_reason: "no-route", occurrences: 1 },
		]);
		raw.close();
	});

	it("migrates a store created before the occurrences column existed", async () => {
		const legacyPath = join(mkdtempSync(join(tmpdir(), "evolve-legacy-")), "memory.db");
		const legacy = new DatabaseSync(legacyPath);
		legacy.exec(
			"CREATE TABLE extraction_log (run_id TEXT, ts TEXT NOT NULL, session_id TEXT, workspace_id TEXT, " +
				"trigger TEXT, decision TEXT, skip_reason TEXT, status TEXT, duration_ms INTEGER, model TEXT, usage TEXT, files TEXT)",
		);
		legacy
			.prepare("INSERT INTO extraction_log (ts, session_id, workspace_id, trigger, skip_reason, status) VALUES (?, ?, ?, ?, ?, ?)")
			.run("2026-10-01T00:00:00.000Z", "s", WS, "turn-debounce", "no-user-prose", "skipped");
		legacy.close();

		const migrated = await openMemoryStore(legacyPath);
		migrated.logSkipped({ workspaceId: WS, sessionId: "s", trigger: "turn-debounce", skipReason: "no-user-prose", status: "skipped" });
		migrated.close();

		// The pre-existing row is backfilled with 1 and then bumped by the repeat.
		const raw = new DatabaseSync(legacyPath);
		expect(raw.prepare("SELECT occurrences FROM extraction_log").all()).toEqual([{ occurrences: 2 }]);
		raw.close();
	});
});

describe("patrol", () => {
	it("drops orphan FTS rows and quarantines secret-bearing records", () => {
		expect(create({ title: "clean" })).toBe(true);
		const raw = rawDb();
		// Orphan: FTS row without a memory row.
		raw.prepare("INSERT INTO memories_fts (workspace_id, id, title, description, body) VALUES (?, ?, 't', 'd', 'b')").run(WS, "ghost");
		// Secret below the write gates (defence in depth): smuggled via raw SQL.
		raw
			.prepare(
				"INSERT INTO memories (workspace_id, id, type, title, description, body, status, created_at, updated_at) VALUES (?, 'leak', 'user', 't', 'd', ?, 'active', 't', 't')",
			)
			.run(WS, "token ghp_0123456789abcdefghijklmnopqrstuv");
		raw.close();

		const result = store.patrol();
		expect(result.orphanFtsRows).toBe(1);
		expect(result.quarantined.map((q) => q.id)).toEqual(["leak"]);
		expect(store.get(WS, "leak")?.status).toBe("quarantined");
		// The last patrol result is persisted for the card to display.
		const stored = JSON.parse(store.state("", "patrol:last")!) as { quarantined: { id: string }[] };
		expect(stored.quarantined[0]?.id).toBe("leak");
		// A clean pass finds nothing new.
		expect(store.patrol().orphanFtsRows).toBe(0);
		expect(store.patrol().quarantined).toEqual([]);
	});
});

describe("defaultStorePath", () => {
	it("prefers DSH_HOME and falls back to ~/.dsh", async () => {
		const { defaultStorePath } = await import("../src/store.js");
		const previous = process.env.DSH_HOME;
		process.env.DSH_HOME = "/tmp/dsh-home";
		expect(defaultStorePath()).toBe("/tmp/dsh-home/evolve/memory.db");
		delete process.env.DSH_HOME;
		expect(defaultStorePath()).toMatch(/\.dsh\/evolve\/memory\.db$/);
		if (previous === undefined) {
			delete process.env.DSH_HOME;
		} else {
			process.env.DSH_HOME = previous;
		}
	});
});
