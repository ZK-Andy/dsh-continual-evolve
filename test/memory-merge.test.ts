import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

/**
 * Same-session duplicate merges (P4a): a session re-proposing its own fact
 * folds the old row into a versioned new row instead of overwriting it.
 * Anything outside the session scope keeps the legacy path.
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

	it("folds a same-session create that repeats an id into a versioned row", () => {
		create("m-a", "标题", "旧正文", "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s1" }, [
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

	it("keeps the legacy in-place path for other-session updates", () => {
		create("m-a", "标题", "旧正文", "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s2" }, [
			{ action: "update", id: "m-a", body: "新正文" },
		]);
		expect(outcome?.ok).toBe(true);
		expect(outcome?.id).toBe("m-a");
		expect(rowOf("m-a").status).toBe("active");
		expect(rowOf("m-a").body).toBe("新正文");
	});

	it("keeps the legacy failure for other-session creates on a taken id", () => {
		create("m-a", "标题", "旧正文", "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s2" }, [
			{ action: "create", id: "m-a", type: "user", title: "标题", description: "钩子", body: "新正文" },
		]);
		expect(outcome?.ok).toBe(false);
	});

	it("keeps the legacy path when nothing substantive changed", () => {
		create("m-a", "标题", "旧正文", "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s1" }, [
			{ action: "update", id: "m-a", body: "旧正文 " },
		]);
		expect(outcome?.ok).toBe(true);
		expect(outcome?.id).toBe("m-a");
		expect(rowOf("m-a").status).toBe("active");
	});

	it("refuses the merge when the old row is a correction target", () => {
		create("m-a", "标题", "旧正文", "s1");
		const [linked] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s1" }, [
			{ action: "create", id: "m-b", type: "user", title: "修正", description: "钩子", body: "修正正文", corrects: "m-a" },
		]);
		expect(linked?.ok).toBe(true);
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s1" }, [
			{ action: "update", id: "m-a", body: "新正文" },
		]);
		expect(outcome?.ok).toBe(true);
		expect(outcome?.id).toBe("m-a");
		expect(rowOf("m-a").status).toBe("active");
	});

	it("falls back to in-place when the pair exceeds the input cap", () => {
		create("m-a", "标题", "x".repeat(4000), "s1");
		const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "s1" }, [
			{ action: "update", id: "m-a", body: "y".repeat(4001) },
		]);
		expect(outcome?.ok).toBe(true);
		expect(outcome?.id).toBe("m-a");
		expect(rowOf("m-a").status).toBe("active");
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
