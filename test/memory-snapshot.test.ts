import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importWorkspaceMd } from "../src/services/import-md.js";
import { listCardWorkspaces, memoryEntryContent, memorySnapshot } from "../src/surfaces/memory-snapshot.js";
import { openMemoryStore, MEMORY_FILE_PREVIEW_LIMIT, type MemoryStore } from "../src/store.js";

let store: MemoryStore;
let workspace = "";

beforeEach(async () => {
	store = await openMemoryStore(join(mkdtempSync(join(tmpdir(), "evolve-snapshot-db-")), "memory.db"));
	workspace = mkdtempSync(join(tmpdir(), "evolve-snapshot-"));
});

afterEach(() => {
	store.close();
	rmSync(workspace, { recursive: true, force: true });
});

function seed(id: string = "fedora-env", type: "user" | "feedback" | "reference" = "user", body: string = "Fedora 44"): boolean {
	const outcomes = store
		.applyProposals({ workspaceId: workspace, trigger: "explicit" }, [
			{
				action: "create",
				id,
				type,
				title: `${id} 标题`,
				description: `${id} 的钩子`,
				body: type === "feedback" ? `${body}\n**Why:** 因\n**How to apply:** 用` : body,
			},
		]);
	return outcomes[0]?.ok === true;
}

describe("memorySnapshot", () => {
	it("reports the empty state for a workspace without rows", () => {
		const snapshot = memorySnapshot(store, workspace);
		expect(snapshot.exists).toBe(false);
		expect(snapshot.readError).toBeNull();
		expect(snapshot.files).toEqual([]);
		expect(snapshot.fileCount).toBe(0);
	});

	it("projects rows as card entries with millisecond timestamps", () => {
		expect(seed("fedora-env", "user", "Fedora 44")).toBe(true);
		const snapshot = memorySnapshot(store, workspace);
		expect(snapshot.exists).toBe(true);
		expect(snapshot.fileCount).toBe(1);
		const file = snapshot.files[0]!;
		expect(file).toMatchObject({ id: "fedora-env", title: "fedora-env 标题", type: "user", status: "active" });
		expect(file.updatedAt).toBeGreaterThan(0);
	});

	it("renders nothing when the store query throws (the card must observe, never break)", () => {
		const hostile = new Proxy({}, {
			get(_target, prop) {
				if (prop === "listAll") {
					throw new Error("boom");
				}
				return undefined;
			},
		}) as unknown as MemoryStore;
		const snapshot = memorySnapshot(hostile, workspace);
		expect(snapshot.exists).toBe(true);
		expect(snapshot.readError).toContain("boom");
	});

	it("tolerates a corrupt or mismatched patrol state with a generic reason", () => {
		expect(seed("leak", "reference", "普通正文")).toBe(true);
		const raw = new DatabaseSync(store.path);
		raw
			.prepare(
				"INSERT INTO memories (workspace_id, id, type, title, description, body, status, created_at, updated_at) VALUES (?, 'smug', 'user', 't', 'd', 'b', 'quarantined', 't', 't')",
			)
			.run(workspace);
		raw.close();
		// Corrupt JSON in the state row.
		store.setState("", "patrol:last", "{not json");
		let snapshot = memorySnapshot(store, workspace);
		expect(snapshot.lastPatrol).toBeNull();
		expect(snapshot.quarantined[0]?.reason).toContain("巡检异常");
		// Valid JSON whose quarantined list names a different id.
		store.setState("", "patrol:last", JSON.stringify({ ts: "t", orphanFtsRows: 0, quarantined: [{ id: "other", reason: "x" }] }));
		snapshot = memorySnapshot(store, workspace);
		expect(snapshot.lastPatrol).toEqual({ ts: "t", orphanFtsRows: 0, quarantined: 1 });
		expect(snapshot.quarantined[0]?.reason).toContain("巡检异常");
	});

	it("excludes quarantined rows from the list but surfaces them as patrol anomalies", () => {
		expect(seed("clean", "user", "干净正文")).toBe(true);
		expect(seed("leak", "reference", "普通正文")).toBe(true);
		// A second connection smuggles a row below the write gates (defence in
		// depth); patrol must catch it.
		const raw = new DatabaseSync(store.path);
		raw
			.prepare(
				"INSERT INTO memories (workspace_id, id, type, title, description, body, status, created_at, updated_at) VALUES (?, 'smug', 'user', 't', 'd', ?, 'active', 't', 't')",
			)
			.run(workspace, "apiKey = '0123456789abcdefghij'");
		raw.close();
		store.patrol();
		const snapshot = memorySnapshot(store, workspace);
		expect(snapshot.files.map((f) => f.id).sort()).toEqual(["clean", "leak"]);
		expect(snapshot.quarantined.map((q) => q.id)).toEqual(["smug"]);
		expect(snapshot.quarantined[0]?.reason).toContain("credential");
		expect(snapshot.lastPatrol).not.toBeNull();
	});
});

describe("memorySnapshot 全局分区可见性", () => {
	it("keeps a promoted memory visible in its origin workspace, tagged global", () => {
		expect(seed("fedora-env")).toBe(true);
		expect(store.promoteMemory(workspace, "fedora-env").ok).toBe(true);
		const snapshot = memorySnapshot(store, workspace);
		expect(snapshot.exists).toBe(true);
		// The origin row is archived by the promotion; only the global copy is
		// left, and the card must still show it (the injection index does).
		expect(snapshot.fileCount).toBe(1);
		expect(snapshot.files.map((file) => [file.id, file.scope])).toEqual([["fedora-env", "global"]]);
	});

	it("a surviving local row shadows the global row of the same id", () => {
		expect(seed("fedora-env")).toBe(true);
		expect(store.promoteMemory(workspace, "fedora-env").ok).toBe(true);
		// Below the write gates: resurrect the archived origin row so both
		// partitions hold the id. Read semantics say the local row wins.
		const raw = new DatabaseSync(store.path);
		raw.prepare("UPDATE memories SET status = 'active' WHERE workspace_id = ? AND id = 'fedora-env'").run(workspace);
		raw.close();
		const snapshot = memorySnapshot(store, workspace);
		expect(snapshot.files.map((file) => [file.id, file.scope])).toEqual([["fedora-env", "project"]]);
	});

	it("the global partition reads as a project view of its own", () => {
		expect(seed("fedora-env")).toBe(true);
		expect(store.promoteMemory(workspace, "fedora-env").ok).toBe(true);
		const global = memorySnapshot(store, "");
		expect(global.files.map((file) => [file.id, file.scope])).toEqual([["fedora-env", "project"]]);
	});

	it("a workspace with no rows of its own still sees the global partition", () => {
		expect(seed("fedora-env")).toBe(true);
		expect(store.promoteMemory(workspace, "fedora-env").ok).toBe(true);
		const other = mkdtempSync(join(tmpdir(), "evolve-snapshot-other-"));
		try {
			const snapshot = memorySnapshot(store, other);
			expect(snapshot.exists).toBe(true);
			expect(snapshot.files.map((file) => [file.id, file.scope])).toEqual([["fedora-env", "global"]]);
			// The preview route resolves the same merged visibility.
			expect(memoryEntryContent(store, other, "fedora-env")).toMatchObject({ ok: true, content: "Fedora 44" });
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("marks a quarantined global row with the partition it came from", () => {
		expect(seed("fedora-env")).toBe(true);
		expect(store.promoteMemory(workspace, "fedora-env").ok).toBe(true);
		const raw = new DatabaseSync(store.path);
		raw.prepare("UPDATE memories SET status = 'quarantined' WHERE workspace_id = '' AND id = 'fedora-env'").run();
		raw.close();
		const snapshot = memorySnapshot(store, workspace);
		expect(snapshot.files).toEqual([]);
		expect(snapshot.quarantined).toEqual([{ id: "fedora-env", scope: "global", reason: expect.stringContaining("巡检异常") }]);
	});
});

describe("memoryEntryContent", () => {
	it("serves the body by id with its update time", () => {
		expect(seed("note", "reference", "正文内容")).toBe(true);
		const content = memoryEntryContent(store, workspace, "note");
		expect(content).toMatchObject({ ok: true, id: "note", content: "正文内容" });
		expect(content.ok && content.updatedAtMs).toBeGreaterThan(0);
	});

	it("answers absent for unknown ids and empty requests", () => {
		expect(memoryEntryContent(store, workspace, "ghost")).toEqual({ ok: false, reason: "absent" });
		expect(memoryEntryContent(store, workspace, "")).toEqual({ ok: false, reason: "absent" });
	});

	it("degrades a failing store read to absent and tolerates a garbage timestamp", () => {
		const hostile = new Proxy({}, {
			get(_target, prop) {
				if (prop === "get") {
					throw new Error("boom");
				}
				return undefined;
			},
		}) as unknown as MemoryStore;
		expect(memoryEntryContent(hostile, workspace, "x")).toEqual({ ok: false, reason: "absent" });
		const raw = new DatabaseSync(store.path);
		raw
			.prepare(
				"INSERT INTO memories (workspace_id, id, type, title, description, body, status, created_at, updated_at) VALUES (?, 'odd', 'user', 't', 'd', 'b', 'active', 'garbage', 'garbage')",
			)
			.run(workspace);
		raw.close();
		const snapshot = memorySnapshot(store, workspace);
		expect(snapshot.files[0]?.updatedAt).toBe(0);
	});
});

describe("listCardWorkspaces", () => {
	it("lists partitions with surviving directories and hides vanished ones", () => {
		expect(listCardWorkspaces(store)).toEqual([]);
		expect(seed()).toBe(true);
		expect(listCardWorkspaces(store)).toEqual([{ root: workspace, label: workspace.split("/").pop() }]);
		const vanished = mkdtempSync(join(tmpdir(), "evolve-snapshot-vanished-"));
		store.applyProposals({ workspaceId: vanished, trigger: "explicit" }, [
			{ action: "create", type: "user", title: "t", description: "d", body: "b" },
		]);
		rmSync(vanished, { recursive: true, force: true });
		expect(listCardWorkspaces(store).map((w) => w.root)).toEqual([workspace]);
	});

	it("keeps serving after a legacy MD import (the import feeds the same store)", () => {
		mkdirSync(join(workspace, ".evolve", "memory"), { recursive: true });
		writeFileSync(
			join(workspace, ".evolve", "memory", "legacy.md"),
			["---", "name: legacy", "description: 迁移来的记忆", "metadata:", "  type: reference", "---", "", "正文"].join("\n"),
			"utf8",
		);
		const result = importWorkspaceMd(store, workspace);
		expect(result.imported).toBe(1);
		expect(memorySnapshot(store, workspace).fileCount).toBe(1);
		expect(memoryEntryContent(store, workspace, "legacy")).toMatchObject({ ok: true, content: "正文" });
	});

	it("keeps the 5 MiB preview limit constant (client contract)", () => {
		expect(MEMORY_FILE_PREVIEW_LIMIT).toBe(5 * 1024 * 1024);
	});

	it("degrades a failing workspace listing to an empty list", () => {
		const hostile = new Proxy({}, {
			get(_target, prop) {
				if (prop === "listWorkspaces") {
					throw new Error("boom");
				}
				return undefined;
			},
		}) as unknown as MemoryStore;
		expect(listCardWorkspaces(hostile)).toEqual([]);
	});

	it("reads null eval freshness before any manual run (P5a state-key contract)", () => {
		const snapshot = memorySnapshot(store, workspace);
		expect(snapshot.evals).toEqual({ fourArm: null, external: null });
	});

	it("projects eval state keys to days-ago with the 60-day stale flag", () => {
		const daysAgo = (days: number): string => new Date(Date.now() - days * 86400000).toISOString();
		store.setState("", "eval:last-four-arm", JSON.stringify({ date: daysAgo(12), commit: "abc123" }));
		store.setState("", "eval:last-external", JSON.stringify({ date: daysAgo(61), commit: "def456" }));
		const snapshot = memorySnapshot(store, workspace);
		expect(snapshot.evals.fourArm).toMatchObject({ daysAgo: 12, commit: "abc123", stale: false });
		expect(snapshot.evals.external).toMatchObject({ daysAgo: 61, commit: "def456", stale: true });
	});

	it("degrades garbage eval state to never-ran instead of throwing", () => {
		store.setState("", "eval:last-four-arm", "{not json");
		store.setState("", "eval:last-external", JSON.stringify({ date: "yesterday", commit: 7 }));
		const snapshot = memorySnapshot(store, workspace);
		expect(snapshot.evals).toEqual({ fourArm: null, external: null });
	});
});
