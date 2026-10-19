import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVAL_PREVIEW_CHAR_CAP, EVAL_QUERY_CHAR_CAP, EVAL_REPLY_CHAR_CAP, pruneEvalCases, writeEvalCases, type EvalCaseWrite } from "../src/data/eval-cases.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";
import { pruneIfDue } from "../src/services/retention.js";
import { redactText } from "../src/data/secret.js";

/**
 * Eval cases (P5a): truncate at the door, mask secrets in replies, prune at
 * 30 days with the ledgers. The fake credential below is synthetic
 * (`ghp_` + repeated letter) and matches the GitHub-token pattern on shape
 * alone — no live secret.
 */
const WS = "/tmp/work/eval-cases";
const FAKE_TOKEN = `ghp_${"A".repeat(36)}`;

function entry(overrides: Partial<EvalCaseWrite> = {}): EvalCaseWrite {
	return {
		runId: "run-1",
		taskId: "task-001",
		arm: "current",
		workspaceId: WS,
		query: "什么时候可以 publish",
		injectionPreview: "发版前必须 CI 全绿",
		reply: "先看 CI 状态再决定",
		createdAt: "2026-10-19T00:00:00.000Z",
		...overrides,
	};
}

function rowsOf(dbPath: string): { reply: string; query: string }[] {
	const db = new DatabaseSync(dbPath);
	const rows = db.prepare("SELECT query, reply FROM eval_cases").all() as { query: string; reply: string }[];
	db.close();
	return rows;
}

let dbPath = "";
let store: MemoryStore;

beforeEach(async () => {
	dbPath = join(mkdtempSync(join(tmpdir(), "evolve-eval-cases-")), "memory.db");
	store = await openMemoryStore(dbPath);
});

afterEach(() => {
	store.close();
});

describe("redactText", () => {
	it("masks every credential match and leaves clean text alone", () => {
		expect(redactText(`token is ${FAKE_TOKEN} ok`)).toBe("token is [redacted-GitHub token] ok");
		expect(redactText(`first ${FAKE_TOKEN} second ${FAKE_TOKEN}`)).toBe("first [redacted-GitHub token] second [redacted-GitHub token]");
		expect(redactText("nothing secret here")).toBe("nothing secret here");
	});
});

describe("writeEvalCases", () => {
	it("creates the table on migrate and stores the triple", async () => {
		const db = new DatabaseSync(dbPath);
		expect(writeEvalCases(db, [entry()])).toBe(1);
		db.close();
		expect(rowsOf(dbPath)).toEqual([{ query: "什么时候可以 publish", reply: "先看 CI 状态再决定" }]);
	});

	it("writes nothing for an empty batch", async () => {
		const db = new DatabaseSync(dbPath);
		expect(writeEvalCases(db, [])).toBe(0);
		db.close();
	});

	it("truncates over-long fields at the caps", async () => {
		const db = new DatabaseSync(dbPath);
		writeEvalCases(db, [
			entry({
				query: "q".repeat(EVAL_QUERY_CHAR_CAP + 10),
				injectionPreview: "p".repeat(EVAL_PREVIEW_CHAR_CAP + 10),
				reply: "r".repeat(EVAL_REPLY_CHAR_CAP + 10),
			}),
		]);
		db.close();
		const [row] = rowsOf(dbPath);
		expect(row?.query.length).toBe(EVAL_QUERY_CHAR_CAP);
		expect(row?.reply.length).toBe(EVAL_REPLY_CHAR_CAP);
	});

	it("masks a fake key in the stored reply (observable masked state)", async () => {
		const db = new DatabaseSync(dbPath);
		writeEvalCases(db, [entry({ reply: `token ${FAKE_TOKEN} done` })]);
		db.close();
		const [row] = rowsOf(dbPath);
		expect(row?.reply).toBe("token [redacted-GitHub token] done");
		expect(row?.reply).not.toContain(FAKE_TOKEN);
	});

	it("rejects an arm outside the whitelist", async () => {
		const db = new DatabaseSync(dbPath);
		expect(() => writeEvalCases(db, [entry({ arm: "turbo" as never })])).toThrow();
		db.close();
	});

	it("replaces the same run/task/arm row idempotently", async () => {
		const db = new DatabaseSync(dbPath);
		writeEvalCases(db, [entry({ reply: "first" })]);
		writeEvalCases(db, [entry({ reply: "second" })]);
		db.close();
		expect(rowsOf(dbPath)).toEqual([{ query: "什么时候可以 publish", reply: "second" }]);
	});
});

describe("pruneEvalCases", () => {
	it("drops rows older than the cutoff, swept by retention with the ledgers", async () => {
		const db = new DatabaseSync(dbPath);
		writeEvalCases(db, [entry({ taskId: "old", createdAt: "2026-08-01T00:00:00.000Z" })]);
		writeEvalCases(db, [entry({ taskId: "new", createdAt: "2026-10-19T00:00:00.000Z" })]);
		expect(pruneEvalCases(db, "2026-09-19T00:00:00.000Z")).toBe(1);
		writeEvalCases(db, [entry({ taskId: "older", createdAt: "2026-08-01T00:00:00.000Z" })]);
		db.close();
		// Retention sweeps eval cases with the same 30-day mouth as the ledgers.
		expect(pruneIfDue(store, new Date("2026-10-19T00:00:00.000Z"))).toBeGreaterThanOrEqual(1);
	});
});
