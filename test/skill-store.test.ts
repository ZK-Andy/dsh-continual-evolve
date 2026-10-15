import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, type MemoryStore, type SkillProposalOutcome } from "../src/store.js";
import { renderSkillMarkdown, SKILL_GENERATED_MARKER } from "../src/services/skill-rules.js";

let dbPath = "";
let store: MemoryStore;
let wsA = "";
let wsB = "";
let dshHome = "";
let savedDshHome: string | undefined;

const FIELDS = { title: "Deploy checklist", description: "pre-release steps", body: "1. build\n2. verify" };

beforeEach(async () => {
	dbPath = join(mkdtempSync(join(tmpdir(), "evolve-skill-db-")), "memory.db");
	store = await openMemoryStore(dbPath);
	wsA = mkdtempSync(join(tmpdir(), "evolve-skill-ws-a-"));
	wsB = mkdtempSync(join(tmpdir(), "evolve-skill-ws-b-"));
	dshHome = mkdtempSync(join(tmpdir(), "evolve-skill-home-"));
	savedDshHome = process.env.DSH_HOME;
	process.env.DSH_HOME = dshHome;
});

afterEach(() => {
	if (savedDshHome === undefined) {
		delete process.env.DSH_HOME;
	} else {
		process.env.DSH_HOME = savedDshHome;
	}
	store.close();
});

function apply(ws: string, proposals: Record<string, unknown>[]): { outcomes: SkillProposalOutcome[]; warnings: { id: string; warning: string }[] } {
	return store.applySkillProposals({ workspaceId: ws, trigger: "explicit", sessionId: "sess-1" }, proposals as never);
}

function skillFile(ws: string, id: string): string {
	return join(ws, ".agents", "skills", id, "SKILL.md");
}

function globalFile(id: string): string {
	return join(dshHome, "skills", id, "SKILL.md");
}

function rawSkillLog(): { status: string; files: string; warnings: string }[] {
	const db = new DatabaseSync(dbPath);
	try {
		return db.prepare("SELECT status, files, warnings FROM skill_log ORDER BY rowid").all() as { status: string; files: string; warnings: string }[];
	} finally {
		db.close();
	}
}

describe("skill create", () => {
	it("lands the row, the FTS index, the ledger, and the materialized file", () => {
		const { outcomes, warnings } = apply(wsA, [{ action: "create", id: "deploy", ...FIELDS }]);
		expect(outcomes).toEqual([{ id: "deploy", action: "create", ok: true }]);
		expect(warnings).toEqual([]);
		const row = store.getSkill(wsA, "deploy");
		expect(row?.title).toBe(FIELDS.title);
		expect(row?.sourceRun).toBe("explicit");
		expect(store.listSkills(wsA).map((r) => r.id)).toEqual(["deploy"]);
		expect(store.searchSkills(wsA, "pre-release", 10).map((r) => r.id)).toEqual(["deploy"]);
		const file = readFileSync(skillFile(wsA, "deploy"), "utf8");
		expect(file).toBe(renderSkillMarkdown({ id: "deploy", ...FIELDS }));
		expect(file).toContain(SKILL_GENERATED_MARKER);
		const log = rawSkillLog();
		expect(log.length).toBe(1);
		expect(log[0]?.status).toBe("applied");
		expect(JSON.parse(log[0]?.files ?? "[]")[0].after.id).toBe("deploy");
	});

	it("derives the id from the title when omitted", () => {
		const { outcomes } = apply(wsA, [{ action: "create", ...FIELDS }]);
		expect(outcomes[0]).toMatchObject({ id: "deploy-checklist", ok: true });
	});

	it("rejects duplicates in the project and identical content under another id", () => {
		expect(apply(wsA, [{ action: "create", id: "deploy", ...FIELDS }]).outcomes[0]?.ok).toBe(true);
		const dup = apply(wsA, [{ action: "create", id: "deploy", ...FIELDS }]);
		expect(dup.outcomes[0]?.ok).toBe(false);
		expect(dup.outcomes[0]?.reason).toMatch("already exists");
		expect(store.listSkills(wsA)).toHaveLength(1);
		const sameBody = apply(wsA, [{ action: "create", id: "other", ...FIELDS }]);
		expect(sameBody.outcomes[0]?.ok).toBe(false);
		expect(sameBody.outcomes[0]?.reason).toMatch("identical skill");
		const log = rawSkillLog();
		expect(log[log.length - 1]?.status).toBe("rejected");
	});

	it("rejects creates that collide with the global scope", () => {
		apply(wsA, [{ action: "create", id: "deploy", ...FIELDS }]);
		apply(wsA, [{ action: "move-to-global", id: "deploy" }]);
		const clash = apply(wsB, [{ action: "create", id: "deploy", title: "Other", description: "other steps", body: "different body" }]);
		expect(clash.outcomes[0]?.ok).toBe(false);
		expect(clash.outcomes[0]?.reason).toMatch("global skill");
		const identical = apply(wsB, [{ action: "create", id: "deploy", ...FIELDS }]);
		expect(identical.outcomes[0]?.ok).toBe(false);
		expect(identical.outcomes[0]?.reason).toMatch("call it directly");
	});

	it("refuses direct creation in the global partition and unknown actions", () => {
		const direct = store.applySkillProposals({ workspaceId: "", trigger: "explicit" }, [{ action: "create", id: "x", ...FIELDS } as never]);
		expect(direct.outcomes[0]?.ok).toBe(false);
		expect(direct.outcomes[0]?.reason).toMatch("in a project");
		const unknown = apply(wsA, [{ action: "explode", id: "x" }]);
		expect(unknown.outcomes[0]?.ok).toBe(false);
		expect(unknown.outcomes[0]?.reason).toMatch("unknown action");
		expect(apply(wsA, [{ action: "update", id: "x", scope: "everywhere", body: "b" }]).outcomes[0]?.reason).toMatch("scope must be");
	});

	it("rolls the whole batch back on the first failure", () => {
		const { outcomes } = apply(wsA, [
			{ action: "create", id: "first", ...FIELDS },
			{ action: "create", id: "first", ...FIELDS },
		]);
		expect(outcomes[1]?.ok).toBe(false);
		expect(store.getSkill(wsA, "first")).toBeUndefined();
		expect(existsSync(skillFile(wsA, "first"))).toBe(false);
	});
});

describe("skill update and delete", () => {
	it("updates fields and rewrites the file", () => {
		apply(wsA, [{ action: "create", id: "deploy", ...FIELDS }]);
		const { outcomes } = apply(wsA, [{ action: "update", id: "deploy", body: "1. build\n2. verify\n3. publish" }]);
		expect(outcomes[0]?.ok).toBe(true);
		expect(store.getSkill(wsA, "deploy")?.body).toContain("publish");
		expect(readFileSync(skillFile(wsA, "deploy"), "utf8")).toContain("publish");
	});

	it("targets the global scope only when asked for", () => {
		apply(wsA, [{ action: "create", id: "deploy", ...FIELDS }]);
		apply(wsA, [{ action: "move-to-global", id: "deploy" }]);
		const miss = apply(wsB, [{ action: "update", id: "deploy", body: "changed" }]);
		expect(miss.outcomes[0]?.ok).toBe(false);
		expect(miss.outcomes[0]?.reason).toMatch("no project skill");
		const hit = apply(wsB, [{ action: "update", id: "deploy", scope: "global", body: "changed global" }]);
		expect(hit.outcomes[0]?.ok).toBe(true);
		expect(readFileSync(globalFile("deploy"), "utf8")).toContain("changed global");
	});

	it("deletes the row and removes the managed file", () => {
		apply(wsA, [{ action: "create", id: "deploy", ...FIELDS }]);
		const { outcomes } = apply(wsA, [{ action: "delete", id: "deploy" }]);
		expect(outcomes[0]?.ok).toBe(true);
		expect(store.getSkill(wsA, "deploy")).toBeUndefined();
		expect(store.searchSkills(wsA, "pre-release", 10)).toEqual([]);
		expect(existsSync(skillFile(wsA, "deploy"))).toBe(false);
		expect(apply(wsA, [{ action: "delete", id: "deploy" }]).outcomes[0]?.reason).toMatch("no project skill");
	});

	it("leaves hand-written files in place with a warning", () => {
		apply(wsA, [{ action: "create", id: "deploy", ...FIELDS }]);
		writeFileSync(skillFile(wsA, "deploy"), "hand-written content\n", "utf8");
		const { outcomes, warnings } = apply(wsA, [{ action: "delete", id: "deploy" }]);
		expect(outcomes[0]?.ok).toBe(true);
		expect(existsSync(skillFile(wsA, "deploy"))).toBe(true);
		expect(warnings[0]?.warning).toMatch("hand-written");
	});
});

describe("move-to-global", () => {
	it("moves one active project skill: global lands, project archives", () => {
		apply(wsA, [{ action: "create", id: "deploy", ...FIELDS }]);
		const { outcomes } = apply(wsA, [{ action: "move-to-global", id: "deploy" }]);
		expect(outcomes).toEqual([{ id: "deploy", action: "move-to-global", ok: true }]);
		expect(store.getSkill("", "deploy")?.title).toBe(FIELDS.title);
		expect(store.getSkill(wsA, "deploy")?.status).toBe("archived");
		expect(store.listSkills(wsA)).toEqual([]);
		expect(readFileSync(globalFile("deploy"), "utf8")).toContain(SKILL_GENERATED_MARKER);
		expect(existsSync(skillFile(wsA, "deploy"))).toBe(false);
	});

	it("rejects moves without a project row or with a global collision", () => {
		expect(apply(wsA, [{ action: "move-to-global", id: "ghost" }]).outcomes[0]?.reason).toMatch("no project skill");
		// The project row predates the global row: create first on both sides,
		// then land the global one — the later move meets the collision.
		apply(wsB, [{ action: "create", id: "deploy", title: "Other", description: "other", body: "other body here" }]);
		apply(wsA, [{ action: "create", id: "deploy", ...FIELDS }]);
		apply(wsA, [{ action: "move-to-global", id: "deploy" }]);
		expect(apply(wsB, [{ action: "move-to-global", id: "deploy" }]).outcomes[0]?.reason).toMatch("already exists");
	});
});

describe("skill search and workspaces", () => {
	it("finds short tokens through the LIKE fallback", () => {
		apply(wsA, [{ action: "create", id: "deploy", ...FIELDS }]);
		expect(store.searchSkills(wsA, "预", 10)).toEqual([]);
		expect(store.searchSkills(wsA, "ver", 10).map((r) => r.id)).toEqual(["deploy"]);
		expect(store.searchSkills(wsA, "", 10)).toEqual([]);
	});

	it("lists skill partitions including the global one", () => {
		apply(wsA, [{ action: "create", id: "deploy", ...FIELDS }]);
		const partitions = store.listSkillWorkspaces().map((w) => w.workspaceId);
		expect(partitions).toContain(wsA);
		apply(wsA, [{ action: "move-to-global", id: "deploy" }]);
		expect(store.listSkillWorkspaces().map((w) => w.workspaceId)).toContain("");
		// The project row survives as archived history (hidden from listings).
		expect(store.listAllSkills(wsA)).toEqual([]);
		expect(store.getSkill(wsA, "deploy")?.status).toBe("archived");
	});
});

describe("skill patrol", () => {
	it("cleans orphan FTS rows and quarantines secret rows with their files", () => {
		apply(wsA, [{ action: "create", id: "deploy", ...FIELDS }]);
		const raw = new DatabaseSync(dbPath);
		try {
			raw.prepare("INSERT INTO skills_fts (workspace_id, id, title, description, body) VALUES (?, ?, ?, ?, ?)").run(wsA, "ghost", "g", "g", "g");
			raw.prepare("INSERT INTO skills (workspace_id, id, title, description, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)").run(
				wsA, "leaky", "t", "d", "token xoxb-abcdefghij1234", "2026-10-11T00:00:00.000Z", "2026-10-11T00:00:00.000Z",
			);
			raw.prepare("INSERT INTO skills_fts (workspace_id, id, title, description, body) VALUES (?, ?, ?, ?, ?)").run(wsA, "leaky", "t", "d", "token xoxb-abcdefghij1234");
		} finally {
			raw.close();
		}
		mkdirSync(join(wsA, ".agents", "skills", "leaky"), { recursive: true });
		writeFileSync(skillFile(wsA, "leaky"), `stale managed copy\n${SKILL_GENERATED_MARKER}\n`, "utf8");
		const result = store.patrol();
		expect(result.skillOrphanFtsRows).toBe(1);
		expect(result.skillQuarantined.map((q) => q.id)).toEqual(["leaky"]);
		expect(store.getSkill(wsA, "leaky")?.status).toBe("quarantined");
		// The loadable copy is gone with the row's active status.
		expect(existsSync(skillFile(wsA, "leaky"))).toBe(false);
	});

	it("counts file errors when a quarantined skill's file is hand-written", () => {
		const raw = new DatabaseSync(dbPath);
		try {
			raw.prepare("INSERT INTO skills (workspace_id, id, title, description, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)").run(
				wsA, "leaky-hand", "t", "d", "token xoxb-abcdefghij1234", "2026-10-11T00:00:00.000Z", "2026-10-11T00:00:00.000Z",
			);
		} finally {
			raw.close();
		}
		mkdirSync(join(wsA, ".agents", "skills", "leaky-hand"), { recursive: true });
		writeFileSync(skillFile(wsA, "leaky-hand"), "# hand-written\n", "utf8");
		const result = store.patrol();
		expect(result.skillQuarantined.map((q) => q.id)).toEqual(["leaky-hand"]);
		expect(result.skillFileErrors).toBe(1);
		// Hand-written files stay in place, with the error counted.
		expect(existsSync(skillFile(wsA, "leaky-hand"))).toBe(true);
	});

	it("recreates missing files, rewrites drifted ones, and drops orphan managed files", () => {
		apply(wsA, [{ action: "create", id: "deploy", ...FIELDS }]);
		// Missing file.
		rmSync(skillFile(wsA, "deploy"));
		let result = store.patrol();
		expect(result.skillFilesReconciled).toBe(1);
		expect(readFileSync(skillFile(wsA, "deploy"), "utf8")).toBe(renderSkillMarkdown({ id: "deploy", ...FIELDS }));
		// Drifted file.
		writeFileSync(skillFile(wsA, "deploy"), "drifted\n", "utf8");
		result = store.patrol();
		expect(result.skillFilesReconciled).toBe(1);
		// Orphan managed file with no store row.
		mkdirSync(join(wsA, ".agents", "skills", "orphan"), { recursive: true });
		writeFileSync(join(wsA, ".agents", "skills", "orphan", "SKILL.md"), `---\nname: orphan\ndescription: o\n---\n\n${SKILL_GENERATED_MARKER}\n\nbody\n`, "utf8");
		// Hand-written file without the marker stays.
		mkdirSync(join(wsA, ".agents", "skills", "handmade"), { recursive: true });
		writeFileSync(join(wsA, ".agents", "skills", "handmade", "SKILL.md"), "hand-written\n", "utf8");
		result = store.patrol();
		expect(result.skillOrphanFilesRemoved).toBe(1);
		expect(existsSync(join(wsA, ".agents", "skills", "orphan"))).toBe(false);
		expect(existsSync(join(wsA, ".agents", "skills", "handmade", "SKILL.md"))).toBe(true);
		expect(result.skillFilesReconciled).toBe(0);
	});

	it("counts file errors instead of throwing past the response", () => {
		apply(wsA, [{ action: "create", id: "deploy", ...FIELDS }]);
		// A directory where SKILL.md should be makes every file operation
		// fail deterministically (EISDIR on write, marker check on remove).
		rmSync(skillFile(wsA, "deploy"));
		mkdirSync(skillFile(wsA, "deploy"), { recursive: true });
		const result = store.patrol();
		expect(result.skillFileErrors).toBeGreaterThanOrEqual(1);
		rmSync(skillFile(wsA, "deploy"), { recursive: true, force: true });
	});
});

describe("skill ledger pruning", () => {
	it("prunes skill_log rows with the memory ledger", () => {
		apply(wsA, [{ action: "create", id: "deploy", ...FIELDS }]);
		expect(store.pruneLedger(new Date(Date.now() + 60_000).toISOString())).toBeGreaterThanOrEqual(1);
		expect(rawSkillLog()).toEqual([]);
	});
});

describe("skill usage accounting", () => {
	it("counts servings per partition and scope, unknown skills read undefined", () => {
		expect(store.getSkillUse(wsA, "deploy", "project")).toBeUndefined();
		apply(wsA, [{ action: "create", id: "deploy", ...FIELDS }]);
		store.recordSkillUse(wsA, "deploy", "project");
		store.recordSkillUse(wsA, "deploy", "project");
		const use = store.getSkillUse(wsA, "deploy", "project");
		expect(use?.useCount).toBe(2);
		expect(typeof use?.lastUsedAt).toBe("string");
		expect(store.getSkillUse(wsA, "deploy", "global")).toBeUndefined();
		expect(store.getSkillUse("", "deploy", "global")).toBeUndefined();
	});

	it("keeps project and global counters apart and never throws on faults", () => {
		store.recordSkillUse(wsA, "shared", "project");
		store.recordSkillUse("", "shared", "global");
		expect(store.getSkillUse(wsA, "shared", "project")?.useCount).toBe(1);
		expect(store.getSkillUse("", "shared", "global")?.useCount).toBe(1);
		expect(() => store.recordSkillUse(undefined as never, "shared", "project")).not.toThrow();
		expect(store.getSkillUse(undefined as never, "shared", "project")).toBeUndefined();
	});
});
