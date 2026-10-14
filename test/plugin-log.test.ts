import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPluginLog, type LiveLogger } from "../src/plugin-log.js";
import { LEDGER_RETENTION_DAYS, pruneIfDue } from "../src/retention.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

let store: MemoryStore;
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
	store = await openMemoryStore(join(mkdtempSync(join(tmpdir(), "evolve-plugin-log-")), "memory.db"));
});

afterEach(() => {
	store.close();
});

/** The live channel, recorded: the host logger face is two levels of text. */
function liveRecorder(): LiveLogger & { lines: string[] } {
	const lines: string[] = [];
	return {
		lines,
		info: (message: string): void => { lines.push(`info:${message}`); },
		warn: (message: string): void => { lines.push(`warn:${message}`); },
	};
}

/** Raw connection: the log's own shape is what the durable claim is about. */
function rawDb(): DatabaseSync {
	return new DatabaseSync(store.path);
}

function loggedRows(): { ts: string; level: string; event: string; message: string; workspace_id: string | null; session_id: string | null }[] {
	const raw = rawDb();
	const rows = raw.prepare("SELECT ts, level, event, message, workspace_id, session_id FROM plugin_log ORDER BY rowid").all() as {
		ts: string;
		level: string;
		event: string;
		message: string;
		workspace_id: string | null;
		session_id: string | null;
	}[];
	raw.close();
	return rows;
}

describe("createPluginLog", () => {
	it("writes the durable row and mirrors the line live", () => {
		const live = liveRecorder();
		const log = createPluginLog(() => store, live);
		log.warn("drain-failed", "disk gone", { workspaceId: "/tmp/ws", sessionId: "sess-1" });
		expect(loggedRows()).toMatchObject([
			{ level: "warn", event: "drain-failed", message: "disk gone", workspace_id: "/tmp/ws", session_id: "sess-1" },
		]);
		// The live channel has no field for the slug: the mirror folds it in.
		expect(live.lines).toEqual(["warn:drain-failed: disk gone"]);
	});

	it("mirrors at warn for error — the host face carries two levels", () => {
		const live = liveRecorder();
		createPluginLog(() => store, live).error("store-unavailable", "no sqlite");
		expect(live.lines).toEqual(["warn:store-unavailable: no sqlite"]);
		expect(loggedRows()[0]?.level).toBe("error");
	});

	it("mirrors without a store instead of dropping the line", () => {
		const live = liveRecorder();
		createPluginLog(() => undefined, live).info("defaultRoot", "no store yet");
		expect(live.lines).toEqual(["info:defaultRoot: no store yet"]);
		expect(loggedRows()).toEqual([]);
	});

	it("never throws when the durable write fails", () => {
		const live = liveRecorder();
		const broken = {
			...store,
			logPlugin: (): never => { throw new Error("database is locked"); },
		} as MemoryStore;
		expect(() => createPluginLog(() => broken, live).warn("drain-failed", "disk gone")).not.toThrow();
		expect(live.lines).toEqual(["warn:drain-failed: disk gone"]);
	});

	it("rides its own durability: a write also runs the daily prune", () => {
		const raw = rawDb();
		raw
			.prepare("INSERT INTO plugin_log (ts, level, event, message) VALUES (?, 'info', 'ancient', 'x')")
			.run(new Date(Date.now() - (LEDGER_RETENTION_DAYS + 1) * DAY_MS).toISOString());
		raw.close();
		const log = createPluginLog(() => store, liveRecorder());
		log.info("armed", "scheduler armed");
		expect(loggedRows().map((row) => row.event)).toEqual(["armed"]);
	});

	it("keeps the partition when the call site knows one", () => {
		createPluginLog(() => store, liveRecorder()).warn("review-drain-failed", "disk gone", { workspaceId: "/tmp/ws" });
		expect(loggedRows()[0]?.workspace_id).toBe("/tmp/ws");
		expect(loggedRows()[0]?.session_id).toBeNull();
	});
});

describe("pruneIfDue", () => {
	it("prunes once per UTC day", () => {
		store.logPlugin({ level: "info", event: "armed", message: "x" });
		const now = new Date(Date.now() + (LEDGER_RETENTION_DAYS + 1) * DAY_MS);
		expect(pruneIfDue(store, now)).toBe(1);
		// Same day: the throttle answers before touching the tables.
		expect(pruneIfDue(store, new Date(now.getTime() + 60_000))).toBe(0);
		// Next day, nothing left to prune but the check ran again.
		expect(pruneIfDue(store, new Date(now.getTime() + DAY_MS))).toBe(0);
	});

	it("keeps rows inside the window", () => {
		store.logPlugin({ level: "info", event: "fresh", message: "x" });
		expect(pruneIfDue(store)).toBe(0);
		expect(loggedRows()).toHaveLength(1);
	});
});
