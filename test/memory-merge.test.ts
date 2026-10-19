import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

/**
 * Unified version rows (P4b): any substantive same-id proposal versions,
 * whatever the session — ids are identity. Title matches stay session-bound.
 * Review rewrites keep the in-place path (second author); deletes stay
 * physical. Follows ride along: corrects pointers, usage heartbeats, trial
 * clocks. Review verdicts do not: new text starts its own review lifecycle.
 */
const WS = "/tmp/work/memory-merge";

let dbPath = "";
let store: MemoryStore;

beforeEach(async () => {
	dbPath = join(mkdtempSync(join(tmpdir(), "evolve-merge-")), "memory.db");
	store = await openMemoryStore(dbPath);
});

afterEach(() => {
	store.close();
});

function create(id: string, title: string, body: string, sessionId: string): void {
	const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId }, [
		{ action: "create", id, type: "user", title, description: "钩子", body },
	]);
	expect(outcome?.ok).toBe(true);
}

function rowOf(id: string): { status: string; archive_reason: string; merged_into: string | null; body: string } {
	const db = new DatabaseSync(dbPath);
	const row = db
		.prepare("SELECT status, archive_reason, merged_into, body FROM memories WHERE workspace_id = ? AND id = ?")
		.get(WS, id) as { status: string; archive_reason: string; merged_into: string | null; body: string };
	db.close();
	return row;
}

function lastLedgerFiles(): { id: string; action: string; before?: { corrects?: string | null }; after?: { corrects?: string | null } }[] {
	const db = new DatabaseSync(dbPath);
	const row = db.prepare("SELECT files FROM extraction_log ORDER BY rowid DESC LIMIT 1").get() as { files: string };
	db.close();
	return JSON.parse(row.files) as { id: string; action: string }[];
}

describe("M1 same-id merges", () => {
	it("folds a same-session substantive update into a versioned row", () => {
		create("m-a", "标题", "旧正文", "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s1" }, [
			{ action: "update", id: "m-a", body: "新正文" },
		]);
		expect(outcome?.ok).toBe(true);
		expect(outcome?.id).toBe("m-a-v2");
		// One active copy: the old row is history with a forward pointer.
		expect(store.list(WS).map((record) => record.id)).toEqual(["m-a-v2"]);
		expect(rowOf("m-a")).toMatchObject({ status: "archived", archive_reason: "merged-duplicate", merged_into: "m-a-v2" });
		expect(rowOf("m-a-v2").body).toBe("新正文");
	});

	it("versions cross-session updates too: ids are identity", () => {
		create("m-a", "标题", "旧正文", "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s2" }, [
			{ action: "update", id: "m-a", body: "新正文" },
		]);
		expect(outcome?.ok).toBe(true);
		expect(outcome?.id).toBe("m-a-v2");
		expect(rowOf("m-a").status).toBe("archived");
	});

	it("versions a same-id create instead of failing it", () => {
		create("m-a", "标题", "旧正文", "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s2" }, [
			{ action: "create", id: "m-a", type: "user", title: "标题", description: "钩子", body: "新正文" },
		]);
		expect(outcome?.ok).toBe(true);
		expect(outcome?.id).toBe("m-a-v2");
		expect(store.list(WS).map((record) => record.id)).toEqual(["m-a-v2"]);
	});

	it("skips taken suffixes when allocating the version id", () => {
		create("m-a", "标题", "旧正文", "s1");
		create("m-a-v2", "占位", "占位正文", "s9");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s1" }, [
			{ action: "update", id: "m-a", body: "新正文" },
		]);
		expect(outcome?.id).toBe("m-a-v3");
		expect(rowOf("m-a")).toMatchObject({ status: "archived", merged_into: "m-a-v3" });
	});

	it("keeps the legacy path when nothing substantive changed", () => {
		create("m-a", "标题", "旧正文", "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s2" }, [
			{ action: "update", id: "m-a", body: "旧正文 " },
		]);
		expect(outcome?.ok).toBe(true);
		expect(outcome?.id).toBe("m-a");
		expect(rowOf("m-a").status).toBe("active");
	});

	it("merges large pairs: the schema cap is the only bound", () => {
		create("m-a", "标题", "x".repeat(4000), "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s2" }, [
			{ action: "update", id: "m-a", body: "y".repeat(4001) },
		]);
		expect(outcome?.ok).toBe(true);
		expect(outcome?.id).toBe("m-a-v2");
		expect(rowOf("m-a").status).toBe("archived");
	});

	it("keeps review rewrites in place: review is a second author", () => {
		create("m-a", "标题", "旧正文", "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "item-review", sessionId: "s1" }, [
			{ action: "update", id: "m-a", body: "评审改写" },
		]);
		expect(outcome?.ok).toBe(true);
		expect(outcome?.id).toBe("m-a");
		expect(rowOf("m-a").status).toBe("active");
		expect(rowOf("m-a").body).toBe("评审改写");
	});
});

describe("M2 same-title merges", () => {
	it("folds a same-session retitled create into the existing row's version", () => {
		create("m-a", "同题", "旧正文", "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s1" }, [
			{ action: "create", id: "m-b", type: "user", title: "同题", description: "钩子", body: "新正文" },
		]);
		expect(outcome?.ok).toBe(true);
		expect(outcome?.id).toBe("m-a-v2");
		expect(store.list(WS).map((record) => record.id)).toEqual(["m-a-v2"]);
		expect(rowOf("m-a")).toMatchObject({ status: "archived", archive_reason: "merged-duplicate" });
	});

	it("ignores other-session rows with the same title", () => {
		create("m-a", "同题", "旧正文", "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s2" }, [
			{ action: "create", id: "m-b", type: "user", title: "同题", description: "钩子", body: "新正文" },
		]);
		expect(outcome?.ok).toBe(true);
		expect(outcome?.id).toBe("m-b");
		expect(rowOf("m-a").status).toBe("active");
	});

	it("ignores same-title rows of another type", () => {
		create("m-a", "同题", "旧正文", "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s1" }, [
			{ action: "create", id: "m-b", type: "feedback", title: "同题", description: "钩子", body: "Why: 同题\nHow to apply: 用新法" },
		]);
		expect(outcome?.ok).toBe(true);
		expect(outcome?.id).toBe("m-b");
		expect(rowOf("m-a").status).toBe("active");
	});
});

describe("merge follows", () => {
	it("rewrites live corrects pointers and ledgers the surgery", () => {
		create("m-a", "标题", "旧正文", "s1");
		const [linked] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s1" }, [
			{ action: "create", id: "m-b", type: "user", title: "修正", description: "钩子", body: "修正正文", corrects: "m-a" },
		]);
		expect(linked?.ok).toBe(true);
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s2" }, [
			{ action: "update", id: "m-a", body: "新正文" },
		]);
		expect(outcome?.id).toBe("m-a-v2");
		expect(store.get(WS, "m-b")?.corrects).toBe("m-a-v2");
		const pointer = lastLedgerFiles().find((file) => file.id === "m-b");
		expect(pointer).toMatchObject({ action: "update", before: { corrects: "m-a" }, after: { corrects: "m-a-v2" } });
	});

	it("carries the usage heartbeat to the successor", () => {
		create("m-a", "标题", "旧正文", "s1");
		store.recordMemoryUse(WS, "m-a");
		store.recordMemoryUse(WS, "m-a");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s2" }, [
			{ action: "update", id: "m-a", body: "新正文" },
		]);
		expect(outcome?.id).toBe("m-a-v2");
		expect(store.getMemoryUse(WS, "m-a-v2")).toMatchObject({ useCount: 2 });
		expect(store.getMemoryUse(WS, "m-a")).toBeUndefined();
	});

	it("carries the trial clock to the successor", () => {
		create("m-a", "标题", "旧正文", "s1");
		store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s1" }, [
			{ action: "update", id: "m-a", scope: "person" },
		]);
		expect(store.promoteMemory(WS, "m-a").ok).toBe(true);
		const before = store.get("", "m-a");
		expect(before?.probationUntil).not.toBeNull();
		const [outcome] = store.applyProposals({ workspaceId: "", trigger: "explicit", sessionId: "s2" }, [
			{ action: "update", id: "m-a", body: "新正文" },
		]);
		expect(outcome?.id).toBe("m-a-v2");
		const after = store.get("", "m-a-v2");
		expect(after?.probationUntil).toBe(before?.probationUntil);
		expect(after?.originWorkspace).toBe(WS);
	});

	it("keeps update merges quiet and lets create merges announce", () => {
		create("m-a", "proxy chengdu", "旧正文", "s1");
		create("m-n", "proxy chengdu budget", "邻居正文", "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s2" }, [
			{ action: "update", id: "m-a", body: "新正文" },
		]);
		expect(outcome?.id).toBe("m-a-v2");
		const db = new DatabaseSync(dbPath);
		const silent = db.prepare("SELECT COUNT(*) AS n FROM item_events WHERE source_id = ?").get("m-a-v2") as { n: number };
		db.close();
		expect(silent.n).toBe(0);
	});

	it("lets a retitled create announce to the neighbours it lands near", () => {
		create("m-a", "proxy chengdu", "旧正文", "s1");
		create("m-n", "proxy chengdu budget", "邻居正文", "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s1" }, [
			{ action: "create", id: "m-b", type: "user", title: "proxy chengdu", description: "钩子", body: "新正文" },
		]);
		expect(outcome?.id).toBe("m-a-v2");
		const db = new DatabaseSync(dbPath);
		const announced = db.prepare("SELECT item_id AS id, event FROM item_events WHERE source_id = ?").all("m-a-v2") as {
			id: string;
			event: string;
		}[];
		db.close();
		expect(announced).toEqual([{ id: "m-n", event: "similar" }]);
	});
});

describe("merge edge carry (retro review)", () => {
	it("inherits the folded row's corrects when the proposal omits it", () => {
		create("m-t", "目标", "目标正文", "s1");
		const [linked] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s1" }, [
			{ action: "create", id: "m-a", type: "user", title: "标题", description: "钩子", body: "旧正文", corrects: "m-t" },
		]);
		expect(linked?.ok).toBe(true);
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s2" }, [
			{ action: "update", id: "m-a", body: "新正文" },
		]);
		expect(outcome?.ok).toBe(true);
		expect(outcome?.id).toBe("m-a-v2");
		// The successor keeps correcting what its predecessor corrected: an
		// omitted link is inheritance, never an unlink (no unlink path exists).
		expect(store.get(WS, "m-a-v2")?.corrects).toBe("m-t");
		expect(rowOf("m-a").status).toBe("archived");
	});

	it("freezes archived pointers on repoint: live rows only", () => {
		create("m-a", "标题", "旧正文", "s1");
		const [linked] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s1" }, [
			{ action: "create", id: "m-x", type: "user", title: "指正", description: "钩子", body: "指正正文", corrects: "m-a" },
		]);
		expect(linked?.ok).toBe(true);
		const db = new DatabaseSync(dbPath);
		db.prepare(
			"INSERT INTO memories (workspace_id, id, type, title, description, body, status, source_session, source_seqs, source_run, corrects, scope, probation_until, origin_workspace, not_when, archive_reason, merged_into, created_at, updated_at) VALUES (?, 'm-z', 'user', '旧指正', 'd', 'b', 'archived', NULL, NULL, NULL, 'm-a', 'project', NULL, NULL, '', 'review-archive', NULL, '2026-01-01', '2026-01-02')",
		).run(WS);
		db.close();
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s2" }, [
			{ action: "update", id: "m-a", body: "新正文" },
		]);
		expect(outcome?.id).toBe("m-a-v2");
		expect(store.get(WS, "m-x")?.corrects).toBe("m-a-v2");
		const frozen = new DatabaseSync(dbPath);
		const kept = frozen.prepare("SELECT corrects FROM memories WHERE workspace_id = ? AND id = 'm-z'").get(WS) as {
			corrects: string | null;
		};
		frozen.close();
		expect(kept.corrects).toBe("m-a");
	});

	it("fails closed when the versioned id would break the id bound", () => {
		const base = "y".repeat(78);
		create(base, "标题", "旧正文", "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s2" }, [
			{ action: "update", id: base, body: "新正文" },
		]);
		// 78 + "-v2" (3) = 81 > 80: no readable versioned id exists, so the
		// merge refuses instead of landing an un-updatable row.
		expect(outcome?.ok).toBe(false);
		expect(store.get(WS, base)?.body).toBe("旧正文");
	});

	it("versions a base that still fits the bound exactly", () => {
		const base = "y".repeat(77);
		create(base, "标题", "旧正文", "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s2" }, [
			{ action: "update", id: base, body: "新正文" },
		]);
		// 77 + "-v2" (3) = 80: the bound edge still names a legal row.
		expect(outcome?.ok).toBe(true);
		expect(outcome?.id).toBe(`${base}-v2`);
	});
});
