import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/data/database.js";
import { archiveWithReason, repointCorrects, restoreTrial } from "../src/data/memory-lifecycle.js";
import { migrateDatabase } from "../src/data/migrate.js";

/** Lifecycle writes unit tests: stamp, repoint, and trial carry. */
const WS = "/tmp/work/memory-lifecycle";

let dbPath = "";
let database: DatabaseSync;

beforeEach(async () => {
	dbPath = join(mkdtempSync(join(tmpdir(), "evolve-lifecycle-")), "memory.db");
	database = await openDatabase(dbPath);
	migrateDatabase(database);
});

afterEach(() => {
	database.close();
});

function insert(id: string, corrects: string | null = null): void {
	database
		.prepare(
			"INSERT INTO memories (workspace_id, id, type, title, description, body, status, source_session, source_seqs, source_run, corrects, scope, probation_until, origin_workspace, not_when, archive_reason, merged_into, created_at, updated_at) VALUES (?, ?, 'user', ?, 'd', 'b', 'active', NULL, NULL, NULL, ?, 'project', NULL, NULL, '', '', NULL, '2026-01-01', '2026-01-02')",
		)
		.run(WS, id, `标题 ${id}`, corrects);
}

function rowOf(id: string): Record<string, unknown> {
	return database.prepare("SELECT status, archive_reason, merged_into, corrects, probation_until, origin_workspace FROM memories WHERE workspace_id = ? AND id = ?").get(WS, id) as Record<string, unknown>;
}

describe("archiveWithReason", () => {
	it("stamps the reason and the merge pointer in place", () => {
		insert("m-a");
		archiveWithReason(database, WS, "m-a", "2026-10-19T00:00:00.000Z", "merged-duplicate", "m-a-v2");
		expect(rowOf("m-a")).toMatchObject({ status: "archived", archive_reason: "merged-duplicate", merged_into: "m-a-v2" });
	});
});

describe("repointCorrects", () => {
	it("moves live pointers and reports the count", () => {
		insert("m-a");
		insert("m-b", "m-a");
		insert("m-c", "m-a");
		expect(repointCorrects(database, WS, "m-a", "m-a-v2")).toBe(2);
		expect(rowOf("m-b")).toMatchObject({ corrects: "m-a-v2" });
		expect(rowOf("m-c")).toMatchObject({ corrects: "m-a-v2" });
	});

	it("reports zero when nothing points at the row", () => {
		insert("m-a");
		expect(repointCorrects(database, WS, "m-a", "m-a-v2")).toBe(0);
	});
});

describe("restoreTrial", () => {
	it("carries the probation clock and the origin home", () => {
		insert("m-a-v2");
		restoreTrial(database, WS, "m-a-v2", "2026-11-19T00:00:00.000Z", WS);
		expect(rowOf("m-a-v2")).toMatchObject({ probation_until: "2026-11-19T00:00:00.000Z", origin_workspace: WS });
	});
});
