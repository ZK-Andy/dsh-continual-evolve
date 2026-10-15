import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listCardWorkspaces, skillEntryContent, skillSnapshot } from "../src/surfaces/memory-snapshot.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

let dbPath = "";
let store: MemoryStore;
let ws = "";

const FIELDS = { title: "Deploy checklist", description: "pre-release steps", body: "1. build\n2. verify" };

beforeEach(async () => {
	dbPath = join(mkdtempSync(join(tmpdir(), "evolve-skill-snap-db-")), "memory.db");
	store = await openMemoryStore(dbPath);
	ws = mkdtempSync(join(tmpdir(), "evolve-skill-snap-ws-"));
});

afterEach(() => {
	store.close();
});

function create(partition: string, id: string, overrides: Record<string, unknown> = {}): void {
	const body = typeof overrides.body === "string" ? overrides.body : `body of ${id}`;
	const outcome = store.applySkillProposals({ workspaceId: ws, trigger: "explicit" }, [
		{ action: "create", id, ...FIELDS, body, ...overrides } as never,
	]);
	if (partition === "") {
		// Global rows only arise from the manual move: create in the project, then move.
		const created = outcome.outcomes[0]?.ok;
		expect(created).toBe(true);
		const moved = store.applySkillProposals({ workspaceId: ws, trigger: "explicit" }, [{ action: "move-to-global", id } as never]);
		expect(moved.outcomes[0]?.ok).toBe(true);
		return;
	}
	expect(outcome.outcomes[0]?.ok).toBe(true);
}

/** Hand-insert a legacy row the gates would never produce (same id, both scopes). */
function insertLegacy(partition: string, id: string, title: string): void {
	const db = new DatabaseSync(dbPath);
	try {
		db.prepare(
			"INSERT INTO skills (workspace_id, id, title, description, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
		).run(partition, id, title, "legacy", "legacy body", "2026-10-11T00:00:00.000Z", "2026-10-11T00:00:00.000Z");
	} finally {
		db.close();
	}
}

describe("skillSnapshot", () => {
	it("reads empty for unknown partitions and merges project with global", () => {
		expect(skillSnapshot(store, ws)).toMatchObject({ exists: false, fileCount: 0, files: [] });
		create(ws, "deploy");
		create("", "shared");
		const snapshot = skillSnapshot(store, ws);
		expect(snapshot.exists).toBe(true);
		expect(snapshot.fileCount).toBe(2);
		expect(snapshot.files.map((f) => `${f.scope}:${f.id}`).sort()).toEqual(["global:shared", "project:deploy"]);
	});

	it("lets the project shadow a legacy global row of the same id", () => {
		insertLegacy("", "deploy", "Global title");
		insertLegacy(ws, "deploy", "Project title");
		const snapshot = skillSnapshot(store, ws);
		expect(snapshot.fileCount).toBe(1);
		expect(snapshot.files[0]).toMatchObject({ id: "deploy", title: "Project title", scope: "project" });
	});

	it("surfaces quarantined rows as patrol anomalies, never in the list", () => {
		create(ws, "deploy");
		const db = new DatabaseSync(dbPath);
		try {
			db.prepare("UPDATE skills SET status = 'quarantined' WHERE workspace_id = ? AND id = ?").run(ws, "deploy");
		} finally {
			db.close();
		}
		const snapshot = skillSnapshot(store, ws);
		expect(snapshot.files).toEqual([]);
		expect(snapshot.quarantined.map((q) => q.id)).toEqual(["deploy"]);
	});

	it("reports store failures instead of throwing", () => {
		const broken = { listAllSkills: () => { throw new Error("boom"); } } as unknown as MemoryStore;
		expect(skillSnapshot(broken, ws).readError).toBe("boom");
	});
});

describe("skillEntryContent", () => {
	it("prefers the project row and falls back to global", () => {
		create(ws, "deploy");
		create("", "shared");
		expect(skillEntryContent(store, ws, "deploy")).toMatchObject({ ok: true, scope: "project" });
		expect(skillEntryContent(store, ws, "shared")).toMatchObject({ ok: true, scope: "global", content: "body of shared" });
		expect(skillEntryContent(store, ws, "ghost")).toEqual({ ok: false, reason: "absent" });
		expect(skillEntryContent(store, ws, "")).toEqual({ ok: false, reason: "absent" });
	});

	it("lets the project shadow a legacy global row of the same id", () => {
		insertLegacy("", "deploy", "Global title");
		insertLegacy(ws, "deploy", "Project title");
		const content = skillEntryContent(store, ws, "deploy");
		expect(content).toMatchObject({ ok: true, scope: "project" });
	});
});

describe("listCardWorkspaces with skills", () => {
	it("lists skills-only partitions and never the global scope", () => {
		create(ws, "deploy");
		const roots = listCardWorkspaces(store).map((w) => w.root);
		expect(roots).toContain(ws);
		expect(roots).not.toContain("");
	});

	it("dedupes partitions holding both memories and skills", () => {
		create(ws, "deploy");
		store.applyProposals(
			{ workspaceId: ws, trigger: "explicit" },
			[{ action: "create", type: "user", title: "t", description: "d", body: "b" }],
		);
		const roots = listCardWorkspaces(store).map((w) => w.root);
		expect(roots.filter((r) => r === ws)).toHaveLength(1);
	});
});

describe("skill usage columns", () => {
	it("exposes zeros for unconsumed skills and counters after use", () => {
		create(ws, "deploy");
		expect(skillSnapshot(store, ws).files[0]).toMatchObject({ id: "deploy", useCount: 0, lastUsedAt: null });
		store.recordSkillUse(ws, "deploy", "project");
		store.recordSkillUse(ws, "deploy", "project");
		const after = skillSnapshot(store, ws);
		expect(after.files[0]).toMatchObject({ id: "deploy", useCount: 2 });
		expect(typeof after.files[0]?.lastUsedAt).toBe("number");
	});
});
