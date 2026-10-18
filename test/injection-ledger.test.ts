import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { INJECTION_LOG_DDL, createInjectionMethods, prepareInjectionStmts } from "../src/data/injection-log.js";

function fresh(): { db: DatabaseSync; methods: ReturnType<typeof createInjectionMethods> } {
	const db = new DatabaseSync(":memory:");
	db.exec(INJECTION_LOG_DDL);
	return { db, methods: createInjectionMethods(prepareInjectionStmts(db)) };
}

describe("injection ledger", () => {
	it("records one row per session and ignores a repeat", () => {
		const { methods } = fresh();
		methods.recordInjection({ workspaceId: "/w", sessionId: "s1", ts: "2026-10-18T00:00:00.000Z", ids: ["a", "b"], estTokens: 40 });
		methods.recordInjection({ workspaceId: "/w", sessionId: "s1", ts: "2026-10-18T00:01:00.000Z", ids: ["c"], estTokens: 10 });
		const rows = methods.listInjections("/w", "2026-10-17T00:00:00.000Z");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.ids).toEqual(["a", "b"]);
		expect(rows[0]?.estTokens).toBe(40);
	});

	it("filters by workspace and since, newest first", () => {
		const { methods } = fresh();
		methods.recordInjection({ workspaceId: "/w", sessionId: "old", ts: "2026-10-01T00:00:00.000Z", ids: ["a"], estTokens: 5 });
		methods.recordInjection({ workspaceId: "/w", sessionId: "new", ts: "2026-10-18T00:00:00.000Z", ids: ["b"], estTokens: 5 });
		methods.recordInjection({ workspaceId: "/other", sessionId: "x", ts: "2026-10-18T00:00:00.000Z", ids: ["c"], estTokens: 5 });
		const rows = methods.listInjections("/w", "2026-10-10T00:00:00.000Z");
		expect(rows.map((row) => row.sessionId)).toEqual(["new"]);
	});

	it("prunes rows older than the cutoff", () => {
		const { methods } = fresh();
		methods.recordInjection({ workspaceId: "/w", sessionId: "old", ts: "2026-09-01T00:00:00.000Z", ids: ["a"], estTokens: 5 });
		methods.recordInjection({ workspaceId: "/w", sessionId: "new", ts: "2026-10-18T00:00:00.000Z", ids: ["b"], estTokens: 5 });
		expect(methods.pruneInjections("2026-10-01T00:00:00.000Z")).toBe(1);
		expect(methods.listInjections("/w", "2026-01-01T00:00:00.000Z").map((row) => row.sessionId)).toEqual(["new"]);
	});

	it("survives an id payload that is not a JSON array", () => {
		const { db, methods } = fresh();
		db.prepare(
			"INSERT INTO injection_log (workspace_id, session_id, ts, memory_ids, item_count, est_tokens) VALUES (?, ?, ?, ?, ?, ?)",
		).run("/w", "bad", "2026-10-18T00:00:00.000Z", "{not-json", 0, 0);
		expect(methods.listInjections("/w", "2026-10-17T00:00:00.000Z")[0]?.ids).toEqual([]);
	});
});
