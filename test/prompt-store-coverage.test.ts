import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promptFieldGateReasons } from "../src/services/prompt-rules.js";
import { MEMORY_BODY_LIMIT } from "../src/services/memory-rules.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

/**
 * Dormant prompt channel coverage (2026-10-20 kill-dead-eval-loop: the
 * user-facing kind=prompt path is gone, but the store engine stays as
 * tested dormancy). Pins the gates the deleted dispatcher used to exercise:
 * field validation, create/update/delete, reads, usage counters, and the
 * patrol branches for orphan FTS rows and secret-bearing prompts.
 */

let dbPath = "";
let tmpRoot = "";
let store: MemoryStore;
const WS = "/tmp/work/prompt-coverage";

beforeEach(async () => {
	tmpRoot = mkdtempSync(join(tmpdir(), "evolve-prompt-coverage-"));
	dbPath = join(tmpRoot, "memory.db");
	store = await openMemoryStore(dbPath);
});

afterEach(() => {
	store.close();
	rmSync(tmpRoot, { recursive: true, force: true });
});

function rawDb(): DatabaseSync {
	return new DatabaseSync(dbPath);
}

function apply(proposals: Record<string, unknown>[]) {
	return store.applyPromptProposals({ workspaceId: WS, trigger: "explicit" }, proposals as never[]);
}

describe("prompt field gates", () => {
	it("rejects empty fields", () => {
		expect(promptFieldGateReasons({ title: "", description: "d", body: "b" })).toContain("title must not be empty");
		expect(promptFieldGateReasons({ title: "t", description: "", body: "b" })[0]).toMatch(/description/);
		expect(promptFieldGateReasons({ title: "t", description: "d", body: "" })[0]).toMatch(/body/);
	});

	it("rejects over-limit bodies and secrets, accepts clean input", () => {
		expect(promptFieldGateReasons({ title: "t", description: "d", body: "x".repeat(MEMORY_BODY_LIMIT + 1) })[0]).toMatch(/exceeds/);
		expect(promptFieldGateReasons({ title: "t", description: "d", body: "token ghp_0123456789abcdefghijklmnopqrstuv" }).length).toBeGreaterThan(0);
		expect(promptFieldGateReasons({ title: "t", description: "d", body: "plain body" })).toEqual([]);
	});
});

describe("prompt apply through the store", () => {
	it("creates, reads, searches, and lists by workspace", () => {
		const [created] = apply([{ action: "create", id: "how", title: "How", description: "hook", body: "do it like this" }]);
		expect(created?.ok).toBe(true);
		expect(store.getPrompt(WS, "how")?.body).toBe("do it like this");
		expect(store.listPrompts(WS).map((record) => record.id)).toEqual(["how"]);
		expect(store.listAllPrompts(WS).map((record) => record.id)).toEqual(["how"]);
		expect(store.searchPrompts(WS, "do it").map((record) => record.id)).toEqual(["how"]);
		expect(store.listPromptWorkspaces().map((row) => row.workspaceId)).toContain(WS);
	});

	it("fails closed on duplicate creates and unknown updates/deletes", () => {
		expect(apply([{ action: "create", id: "dup", title: "t", description: "d", body: "b" }])[0]?.ok).toBe(true);
		expect(apply([{ action: "create", id: "dup", title: "t", description: "d", body: "b" }])[0]?.ok).toBe(false);
		expect(apply([{ action: "update", id: "ghost", body: "b" }])[0]?.ok).toBe(false);
		expect(apply([{ action: "delete", id: "ghost" }])[0]?.ok).toBe(false);
	});

	it("updates and deletes existing rows", () => {
		expect(apply([{ action: "create", id: "tmp", title: "t", description: "d", body: "v1" }])[0]?.ok).toBe(true);
		expect(apply([{ action: "update", id: "tmp", body: "v2" }])[0]?.ok).toBe(true);
		expect(store.getPrompt(WS, "tmp")?.body).toBe("v2");
		expect(apply([{ action: "delete", id: "tmp" }])[0]?.ok).toBe(true);
		expect(store.getPrompt(WS, "tmp")).toBeUndefined();
	});

	it("counts prompt reads through the usage heartbeat", () => {
		expect(apply([{ action: "create", id: "u", title: "t", description: "d", body: "b" }])[0]?.ok).toBe(true);
		expect(store.getPromptUse(WS, "u")).toBeUndefined();
		store.recordPromptUse(WS, "u");
		expect(store.getPromptUse(WS, "u")?.useCount).toBeGreaterThan(0);
	});

	it("fails closed on unknown actions, malformed ids, and missing create fields", () => {
		expect(apply([{ action: "archive", id: "x" } as never])[0]).toMatchObject({ ok: false, reason: expect.stringContaining("unknown action") });
		expect(apply([{ action: "create", id: "BAD ID", title: "t", description: "d", body: "b" }])[0]).toMatchObject({ ok: false, reason: expect.stringContaining("malformed id") });
		expect(apply([{ action: "create", id: "x" }])[0]).toMatchObject({ ok: false, reason: expect.stringContaining("create requires") });
		expect(apply([{ action: "create" }])[0]).toMatchObject({ ok: false, reason: expect.stringContaining("id missing") });
	});

	it("derives the id from the title when absent, and trims explicit ids", () => {
		expect(apply([{ action: "create", title: "Hello World", description: "d", body: "b" }])[0]).toMatchObject({ ok: true, id: "hello-world" });
		expect(store.getPrompt(WS, "hello-world")?.title).toBe("Hello World");
		expect(apply([{ action: "create", id: "  spaced  ", title: "t", description: "d", body: "b2" }])[0]).toMatchObject({ ok: true, id: "spaced" });
	});

	it("rejects duplicates by id and by identical body", () => {
		expect(apply([{ action: "create", id: "orig", title: "t", description: "d", body: "same body" }])[0]?.ok).toBe(true);
		const dupe = apply([{ action: "create", id: "copy", title: "t", description: "d", body: "same body" }])[0];
		expect(dupe?.ok).toBe(false);
		expect(dupe?.reason).toContain("identical prompt");
	});

	it("rejects gate-failing bodies on create and update", () => {
		const big = "x".repeat(MEMORY_BODY_LIMIT + 1);
		expect(apply([{ action: "create", id: "big", title: "t", description: "d", body: big }])[0]?.ok).toBe(false);
		expect(apply([{ action: "create", id: "up", title: "t", description: "d", body: "ok" }])[0]?.ok).toBe(true);
		expect(apply([{ action: "update", id: "up", body: big }])[0]?.ok).toBe(false);
		expect(store.getPrompt(WS, "up")?.body).toBe("ok");
	});

	it("rolls the whole batch back on the first failure", () => {
		const outcomes = apply([
			{ action: "create", id: "kept-out", title: "t", description: "d", body: "b" },
			{ action: "create", id: "BAD ID", title: "t", description: "d", body: "b" },
		]);
		expect(outcomes.map((outcome) => outcome?.ok)).toEqual([true, false]);
		expect(store.getPrompt(WS, "kept-out")).toBeUndefined();
	});
});

describe("prompt patrol branches", () => {
	it("drops orphan prompt FTS rows and quarantines secret-bearing prompts", () => {
		expect(apply([{ action: "create", id: "clean", title: "t", description: "d", body: "b" }])[0]?.ok).toBe(true);
		const raw = rawDb();
		try {
			raw.prepare("INSERT INTO prompts_fts (workspace_id, id, title, description, body) VALUES (?, 'ghost', 't', 'd', 'b')").run(WS);
			raw
				.prepare("INSERT INTO prompts (workspace_id, id, title, description, body, status, created_at, updated_at) VALUES (?, 'leak', 't', 'd', ?, 'active', 't', 't')")
				.run(WS, "token ghp_0123456789abcdefghijklmnopqrstuv");
		} finally {
			raw.close();
		}
		const result = store.patrol();
		expect(result.promptOrphanFtsRows).toBe(1);
		expect(result.promptQuarantined.map((row) => row.id)).toEqual(["leak"]);
	});
});

describe("dormant global paths", () => {
	it("keeps global and workspace prompts isolated under the same id", () => {
		expect(store.applyPromptProposals({ workspaceId: "", trigger: "explicit" }, [{ action: "create", id: "sh", title: "g", description: "gd", body: "global-body" }])[0]?.ok).toBe(true);
		expect(apply([{ action: "create", id: "sh", title: "t", description: "d", body: "local-body" }])[0]?.ok).toBe(true);
		expect(store.getPrompt(WS, "sh")?.body).toBe("local-body");
		expect(store.getPrompt("", "sh")?.body).toBe("global-body");
		expect(store.listPrompts(WS).filter((record) => record.id === "sh").map((record) => record.body)).toEqual(["local-body"]);
		expect(store.listPrompts("").filter((record) => record.id === "sh").map((record) => record.body)).toEqual(["global-body"]);
	});

	it("writes eval cases through the store surface and reads them back", () => {
		const rows = [
			{ runId: "eval-test", taskId: "task-001", arm: "base", workspaceId: WS, query: "q", injectionPreview: "p", reply: "r", createdAt: "2026-10-20" },
		] as never[];
		expect(store.writeEvalCases(rows)).toBe(1);
		const raw = rawDb();
		try {
			const saved = raw.prepare("SELECT task_id, arm, reply FROM eval_cases WHERE run_id = 'eval-test'").all() as { task_id: string; arm: string; reply: string }[];
			expect(saved).toEqual([{ task_id: "task-001", arm: "base", reply: "r" }]);
		} finally {
			raw.close();
		}
	});
});
