import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	coalesceSkipRun,
	latestWorkspaceId,
	prepareLedgerStmts,
	writeMemoryLedger,
	writePromptLedger,
	writeSkillLedger,
} from "../src/data/ledger.js";
import { migrateDatabase } from "../src/data/migrate.js";

let roots: string[] = [];

function freshDb(): { database: DatabaseSync; stmts: ReturnType<typeof prepareLedgerStmts> } {
	const root = mkdtempSync(join(tmpdir(), "evolve-ledger-db-"));
	roots.push(root);
	const database = new DatabaseSync(join(root, "t.db"));
	migrateDatabase(database);
	return { database, stmts: prepareLedgerStmts(database) };
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
});

describe("writeMemoryLedger", () => {
	it("writes a minimal row and a full row", () => {
		const { database, stmts } = freshDb();
		try {
			writeMemoryLedger(stmts.ledger, { trigger: "turn-debounce", status: "skipped", skipReason: "no-user-prose" });
			writeMemoryLedger(stmts.ledger, {
				runId: "r1",
				sessionId: "s1",
				workspaceId: "/ws",
				trigger: "explicit",
				decision: "d",
				status: "applied",
				durationMs: 7,
				model: "m",
				usage: { t: 1 },
				cheapUsage: { c: 2 },
				cheapError: "e",
				files: [{ id: "a" }],
			});
			const rows = database.prepare("SELECT trigger, usage, files, cheap_error FROM extraction_log ORDER BY rowid").all() as {
				trigger: string;
				usage: string | null;
				files: string | null;
				cheap_error: string | null;
			}[];
			expect(rows).toHaveLength(2);
			expect(rows[0]).toMatchObject({ trigger: "turn-debounce", usage: null, files: null, cheap_error: null });
			expect(rows[1]).toMatchObject({ trigger: "explicit", cheap_error: "e" });
			expect(JSON.parse(rows[1].usage ?? "")).toEqual({ t: 1 });
			expect(JSON.parse(rows[1].files ?? "")).toEqual([{ id: "a" }]);
		} finally {
			database.close();
		}
	});
});

describe("writeSkillLedger", () => {
	it("nulls absent payloads and encodes present ones", () => {
		const { database, stmts } = freshDb();
		try {
			writeSkillLedger(stmts.skillLog, {
				runId: undefined,
				sessionId: undefined,
				workspaceId: "/ws",
				trigger: "explicit",
				decision: "d",
				status: "applied",
				files: undefined,
				warnings: undefined,
			});
			writeSkillLedger(stmts.skillLog, {
				runId: "r",
				sessionId: "s",
				workspaceId: "/ws",
				trigger: "explicit",
				decision: "d",
				status: "applied",
				files: [{ id: "a" }],
				warnings: [{ id: "a", warning: "w" }],
			});
			const rows = database.prepare("SELECT files, warnings FROM skill_log ORDER BY rowid").all() as {
				files: string | null;
				warnings: string | null;
			}[];
			expect(rows[0]).toEqual({ files: null, warnings: null });
			expect(JSON.parse(rows[1].files ?? "")).toEqual([{ id: "a" }]);
			expect(JSON.parse(rows[1].warnings ?? "")).toEqual([{ id: "a", warning: "w" }]);
		} finally {
			database.close();
		}
	});
});

describe("writePromptLedger", () => {
	it("nulls an absent payload and encodes a present one", () => {
		const { database, stmts } = freshDb();
		try {
			writePromptLedger(stmts.promptLog, {
				runId: undefined,
				sessionId: undefined,
				workspaceId: "/ws",
				trigger: "explicit",
				decision: undefined,
				status: "rejected",
				files: undefined,
			});
			writePromptLedger(stmts.promptLog, {
				runId: "r",
				sessionId: "s",
				workspaceId: "/ws",
				trigger: "explicit",
				decision: "d",
				status: "applied",
				files: [{ id: "a" }],
			});
			const rows = database.prepare("SELECT files FROM prompt_log ORDER BY rowid").all() as { files: string | null }[];
			expect(rows[0]).toEqual({ files: null });
			expect(JSON.parse(rows[1].files ?? "")).toEqual([{ id: "a" }]);
		} finally {
			database.close();
		}
	});
});

describe("coalesceSkipRun", () => {
	it("passes through non-skips and unlisted reasons", () => {
		const { database, stmts } = freshDb();
		try {
			expect(coalesceSkipRun(stmts.latestSkip, stmts.bumpSkip, { trigger: "turn-debounce", status: "applied" })).toBe(false);
			expect(
				coalesceSkipRun(stmts.latestSkip, stmts.bumpSkip, { trigger: "turn-debounce", status: "skipped", skipReason: "no-route" }),
			).toBe(false);
			expect(
				coalesceSkipRun(stmts.latestSkip, stmts.bumpSkip, {
					trigger: "turn-debounce",
					status: "skipped",
					skipReason: "no-user-prose",
					workspaceId: "/ws",
					sessionId: "s",
				}),
			).toBe(false);
		} finally {
			database.close();
		}
	});

	it("folds a consecutive repeat into the previous row", () => {
		const { database, stmts } = freshDb();
		try {
			const entry = { trigger: "turn-debounce" as const, status: "skipped", skipReason: "no-user-prose", workspaceId: "/ws", sessionId: "s" };
			writeMemoryLedger(stmts.ledger, entry);
			expect(coalesceSkipRun(stmts.latestSkip, stmts.bumpSkip, entry)).toBe(true);
			const row = database.prepare("SELECT occurrences FROM extraction_log").get() as { occurrences: number };
			expect(row.occurrences).toBe(2);
			expect(database.prepare("SELECT COUNT(*) AS n FROM extraction_log").get()).toMatchObject({ n: 1 });
		} finally {
			database.close();
		}
	});

	it("starts a new row when the previous row differs", () => {
		const { database, stmts } = freshDb();
		try {
			writeMemoryLedger(stmts.ledger, { trigger: "turn-debounce", status: "applied", workspaceId: "/ws", sessionId: "s" });
			expect(
				coalesceSkipRun(stmts.latestSkip, stmts.bumpSkip, {
					trigger: "turn-debounce",
					status: "skipped",
					skipReason: "no-user-prose",
					workspaceId: "/ws",
					sessionId: "s",
				}),
			).toBe(false);
		} finally {
			database.close();
		}
	});
});

describe("latestWorkspaceId", () => {
	it("returns undefined for empty input and skips garbage rows", () => {
		expect(latestWorkspaceId([])).toBeUndefined();
		expect(latestWorkspaceId([undefined, { workspace_id: "", ts: "2026-10-15T00:00:00.000Z" }, { workspace_id: "/ws" }])).toBeUndefined();
	});

	it("picks the newest instant across sources", () => {
		expect(
			latestWorkspaceId([
				{ workspace_id: "/old", ts: "2026-10-14T00:00:00.000Z" },
				{ workspace_id: "/new", ts: "2026-10-15T00:00:00.000Z" },
				undefined,
			]),
		).toBe("/new");
	});
});
