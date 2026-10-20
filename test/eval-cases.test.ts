import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

/**
 * Eval cases (P5a, write path and reader retired 2026-10-20): the table keeps
 * its shape — the arm whitelist and the column order — although nothing writes
 * it any more. Rows are seeded with raw SQL on purpose: the store has no writer
 * to seed them with, and the ledger's own prune is the only thing that still
 * reaches the table.
 */
const WS = "/tmp/work/eval-cases";


let dbPath = "";
let store: MemoryStore;

beforeEach(async () => {
	dbPath = join(mkdtempSync(join(tmpdir(), "evolve-eval-cases-")), "memory.db");
	store = await openMemoryStore(dbPath);
});

afterEach(() => {
	store.close();
});

describe("eval_cases retention", () => {
	it("is swept by the ledger's own prune, not by a module-local helper", () => {
		const db = new DatabaseSync(dbPath);
		db
			.prepare(
				"INSERT INTO eval_cases (run_id, task_id, arm, workspace_id, query, injection_preview, reply, created_at) VALUES ('r', 't', 'base', ?, 'q', 'p', 'r', '2026-08-01T00:00:00.000Z')",
			)
			.run(WS);
		db.close();
		// Exactly one row, and only the expired one: in production code the
		// ledger's own statement is the only thing that still touches the table.
		expect(store.pruneLedger("2026-09-19T00:00:00.000Z")).toBe(1);
	});
});

describe("eval_cases table", () => {
	it("exists after migrate and holds the eight P5a columns", async () => {
		const db = new DatabaseSync(dbPath);
		const columns = (db.prepare("PRAGMA table_info(eval_cases)").all() as { name: string }[]).map((column) => column.name);
		db.close();
		expect(columns).toEqual(["run_id", "task_id", "arm", "workspace_id", "query", "injection_preview", "reply", "created_at"]);
	});

	it("rejects an arm outside the whitelist", async () => {
		const db = new DatabaseSync(dbPath);
		expect(() =>
			db
				.prepare(
					"INSERT INTO eval_cases (run_id, task_id, arm, workspace_id, query, injection_preview, reply, created_at) VALUES ('r', 't', 'turbo', ?, 'q', 'p', 'r', '2026-10-19')",
				)
				.run(WS),
		).toThrow();
		db.close();
	});
});
