/**
 * Ledger writers: the extraction ledger (`extraction_log`) and the skill
 * ledger (`skill_log`). Rows are audit + rollback payloads; preparation
 * stays with the store assembly, JSON encoding and skip coalescing live
 * here exactly once.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { COALESCED_SKIP_REASONS, LEDGER_OCCURRENCES, type LedgerEntry } from "../store-types.js";

/**
 * JSON-encode the optional ledger fields and insert the row.
 * @param ledger - The prepared extraction_log insert.
 * @param entry - The ledger row to append.
 */
export function writeMemoryLedger(ledger: StatementSync, entry: LedgerEntry): void {
	ledger.run(
		entry.runId ?? null,
		new Date().toISOString(),
		entry.sessionId ?? null,
		entry.workspaceId ?? null,
		entry.trigger,
		entry.decision ?? null,
		entry.skipReason ?? null,
		entry.status ?? null,
		entry.durationMs ?? null,
		entry.model ?? null,
		entry.usage === undefined ? null : JSON.stringify(entry.usage),
		entry.cheapUsage === undefined ? null : JSON.stringify(entry.cheapUsage),
		entry.cheapError ?? null,
		entry.files === undefined ? null : JSON.stringify(entry.files),
	);
}

/**
 * Insert one skill ledger row.
 * @param skillLog - The prepared skill_log insert.
 * @param entry - Run provenance, decision, file payload, and warnings.
 */
export function writeSkillLedger(
	skillLog: StatementSync,
	entry: {
		runId: string | undefined;
		sessionId: string | undefined;
		workspaceId: string | undefined;
		trigger: string;
		decision: string | undefined;
		status: string | undefined;
		files: unknown;
		warnings: unknown;
	},
): void {
	skillLog.run(
		entry.runId ?? null,
		new Date().toISOString(),
		entry.sessionId ?? null,
		entry.workspaceId ?? null,
		entry.trigger,
		entry.decision ?? null,
		entry.status ?? null,
		entry.files === undefined ? null : JSON.stringify(entry.files),
		entry.warnings === undefined ? null : JSON.stringify(entry.warnings),
	);
}

/**
 * Insert one prompt ledger row (the prompts write account: before/after
 * snapshots for undo, no file warnings — prompts project to no files).
 * @param promptLog - The prepared prompt_log insert.
 * @param entry - Run provenance, decision, and file payload.
 */
export function writePromptLedger(
	promptLog: StatementSync,
	entry: {
		runId: string | undefined;
		sessionId: string | undefined;
		workspaceId: string | undefined;
		trigger: string;
		decision: string | undefined;
		status: string | undefined;
		files: unknown;
	},
): void {
	promptLog.run(
		entry.runId ?? null,
		new Date().toISOString(),
		entry.sessionId ?? null,
		entry.workspaceId ?? null,
		entry.trigger,
		entry.decision ?? null,
		entry.status ?? null,
		entry.files === undefined ? null : JSON.stringify(entry.files),
	);
}

/**
 * Pick the newest workspace among recency probes. All instants are ISO-8601
 * UTC, so the newer one is the greater string; comparing them keeps every
 * source on one ordering.
 * @param rows - One probe row per source (ledger recency, table recency).
 * @returns The newest workspace id, undefined when every source is empty.
 */
export function latestWorkspaceId(rows: readonly ({ workspace_id?: unknown; ts?: unknown } | undefined)[]): string | undefined {
	let best: { workspaceId: string; ts: string } | undefined;
	for (const row of rows) {
		const workspaceId = row?.workspace_id;
		const ts = row?.ts;
		if (typeof workspaceId !== "string" || workspaceId.length === 0 || typeof ts !== "string") {
			continue;
		}
		if (best === undefined || ts > best.ts) {
			best = { workspaceId, ts };
		}
	}
	return best?.workspaceId;
}
/**
 * The prepared ledger and log statements (extraction/skill/prompt ledgers,
 * recency probes, prune deletes, plugin log). Preparation lives here with
 * the writers; the store assembly only composes the bundle.
 */
export interface LedgerStmts {
	ledger: StatementSync;
	latestSkip: StatementSync;
	bumpSkip: StatementSync;
	prune: StatementSync;
	skillLog: StatementSync;
	skillPrune: StatementSync;
	promptLog: StatementSync;
	promptPrune: StatementSync;
	recentLedger: StatementSync;
	recentSkill: StatementSync;
	recentPrompt: StatementSync;
	pluginLog: StatementSync;
	pluginLogPrune: StatementSync;
}

/**
 * The prepared key-value state statements (extraction cursors and named
 * store keys, partitioned per workspace). Preparation lives here with the
 * other bookkeeping bundles so the store assembly holds no SQL.
 */
export interface StateStmts {
	stateGet: StatementSync;
	stateSet: StatementSync;
	stateListPrefix: StatementSync;
	stateDelete: StatementSync;
	cursorGet: StatementSync;
}

/**
 * Prepare the key-value state statements up front.
 * @param database - The open database handle.
 * @returns The prepared state statement bundle.
 */
export function prepareStateStmts(database: DatabaseSync): StateStmts {
	return {
		stateGet: database.prepare("SELECT value FROM state WHERE workspace_id = ? AND key = ?"),
		stateSet: database.prepare(
			"INSERT INTO state (workspace_id, key, value) VALUES (?, ?, ?) " +
				"ON CONFLICT (workspace_id, key) DO UPDATE SET value = excluded.value",
		),
		stateListPrefix: database.prepare("SELECT workspace_id, key, value FROM state WHERE key LIKE ? || '%'"),
		stateDelete: database.prepare("DELETE FROM state WHERE workspace_id = ? AND key = ?"),
		cursorGet: database.prepare("SELECT CAST(value AS INTEGER) AS seq FROM state WHERE workspace_id = ? AND key = ?"),
	};
}

/**
 * Prepare every ledger and log statement up front.
 * @param database - The open database handle.
 * @returns The prepared ledger statement bundle.
 */
export function prepareLedgerStmts(database: DatabaseSync): LedgerStmts {
	return {
		ledger: database.prepare(
			"INSERT INTO extraction_log (run_id, ts, session_id, workspace_id, trigger, decision, skip_reason, status, duration_ms, model, usage, cheap_usage, cheap_error, files) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		),
		latestSkip: database.prepare(
			"SELECT rowid AS rid, skip_reason AS reason, status FROM extraction_log " +
				"WHERE workspace_id IS ? AND session_id IS ? ORDER BY ts DESC, rowid DESC LIMIT 1",
		),
		bumpSkip: database.prepare(
			`UPDATE extraction_log SET ts = ?, ${LEDGER_OCCURRENCES} = ${LEDGER_OCCURRENCES} + 1 WHERE rowid = ?`,
		),
		prune: database.prepare("DELETE FROM extraction_log WHERE ts < ?"),
		skillLog: database.prepare(
			"INSERT INTO skill_log (run_id, ts, session_id, workspace_id, trigger, decision, status, files, warnings) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		),
		skillPrune: database.prepare("DELETE FROM skill_log WHERE ts < ?"),
		promptLog: database.prepare(
			"INSERT INTO prompt_log (run_id, ts, session_id, workspace_id, trigger, decision, status, files) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		),
		promptPrune: database.prepare("DELETE FROM prompt_log WHERE ts < ?"),
		recentLedger: database.prepare(
			"SELECT workspace_id, MAX(ts) AS ts FROM extraction_log " +
				"WHERE workspace_id IS NOT NULL AND workspace_id <> '' GROUP BY workspace_id ORDER BY ts DESC LIMIT 1",
		),
		recentSkill: database.prepare(
			"SELECT workspace_id, MAX(ts) AS ts FROM skill_log " +
				"WHERE workspace_id IS NOT NULL AND workspace_id <> '' GROUP BY workspace_id ORDER BY ts DESC LIMIT 1",
		),
		recentPrompt: database.prepare(
			"SELECT workspace_id, MAX(ts) AS ts FROM prompt_log " +
				"WHERE workspace_id IS NOT NULL AND workspace_id <> '' GROUP BY workspace_id ORDER BY ts DESC LIMIT 1",
		),
		pluginLog: database.prepare(
			"INSERT INTO plugin_log (ts, level, event, message, workspace_id, session_id) VALUES (?, ?, ?, ?, ?, ?)",
		),
		pluginLogPrune: database.prepare("DELETE FROM plugin_log WHERE ts < ?"),
	};
}

/**
 * Write the audit row inside the caller's open transaction, then commit.
 *
 * The mutation and its audit row are one unit: a store that cannot record a
 * change does not make it. That is the 2026-10-16 lesson — the audit insert
 * hit a stale `CHECK` *after* the body had committed, so the edit landed with
 * no trace and the ledger called the run a failure. The caller's rejected path
 * keeps its post-rollback row: nothing landed, so there is nothing to undo.
 *
 * @param database - The handle holding the open transaction.
 * @param writeLedger - The audit-row write to run before COMMIT.
 * @throws Whatever the ledger write throws, after rolling the transaction back.
 */
export function commitWithLedger(database: DatabaseSync, writeLedger: () => void): void {
	try {
		writeLedger();
		database.exec("COMMIT");
	} catch (error) {
		try {
			database.exec("ROLLBACK");
		} catch {
			// A COMMIT that itself failed has already ended the transaction; the
			// ledger error is the one the caller needs to see.
		}
		throw error;
	}
}

/**
 * Fold a repeat of the previous row's mechanical skip into that row: the
 * quiet turns of one session are one cursor position, so they are one
 * ledger row carrying how many wake-ups it stands for. Only a
 * *consecutive* repeat coalesces — anything in between starts a new row.
 * The bumped row takes the newest `ts`, so recency queries still see the
 * session as active.
 * @param latestSkip - The prepared latest-skip lookup.
 * @param bumpSkip - The prepared skip-row bump.
 * @param entry - The skip to ledger.
 * @returns True when the skip folded into the previous row.
 */
export function coalesceSkipRun(latestSkip: StatementSync, bumpSkip: StatementSync, entry: LedgerEntry): boolean {
	if (entry.status !== "skipped" || entry.skipReason === undefined || !COALESCED_SKIP_REASONS.has(entry.skipReason)) {
		return false;
	}
	const latest = latestSkip.get(entry.workspaceId ?? null, entry.sessionId ?? null) as
		| { rid: number; reason: string | null; status: string | null }
		| undefined;
	if (latest === undefined || latest.status !== "skipped" || latest.reason !== entry.skipReason) {
		return false;
	}
	bumpSkip.run(new Date().toISOString(), latest.rid);
	return true;
}
