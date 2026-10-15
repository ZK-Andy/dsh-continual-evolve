/**
 * The central SQLite memory store: one database file
 * (`~/.dsh/evolve/memory.db`, rows partitioned by workspace path) holding
 * every memory record, its FTS index, the extraction ledger, and per-session
 * extraction cursors. The plugin's code is the literal sole writer — models
 * propose, the gates land. See ADR `2026-10-06-sqlite-single-store`.
 *
 * This file is the assembly root for storage: it opens the database,
 * prepares the statements, and spreads the method factories over one
 * {@link MemoryStore}. Row shapes live in `./store-types.js`, SQL bundles
 * in `./data/resource-kinds.js`, row mapping in `./data/records.js`,
 * ledgers in `./data/ledger.js`, review accounts in
 * `./data/review-accounts.js`, skill writes in `./services/skill-apply.js`,
 * and file projection in `./surfaces/skill-projection.js`.
 *
 * Requires `node:sqlite` (Node ≥ 22.5; the desktop host's EnsureNode runtime
 * guarantees v26). Unavailability is a typed error the entry point degrades
 * on — injection and tooling switch off, the host keeps running.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "./data/database.js";
import { LEDGER_OCCURRENCES, migrateDatabase } from "./data/migrate.js";
import { coalesceSkipRun, writeMemoryLedger, writeSkillLedger } from "./data/ledger.js";
import { recordOf, skillRecordOf, type MemoryRow, type SkillRow } from "./data/records.js";
import { MEMORIES, SKILLS } from "./data/resource-kinds.js";
import { Repository } from "./data/repository.js";
import { createReviewAccounts, INCOMPLETE_REVIEW_SQL } from "./data/review-accounts.js";
import { applySkillOne, type SkillFileIntent, type SkillLedgerFile } from "./services/skill-apply.js";
import { reconcileSkillFiles, removeSkillFile, skillRootOf, writeSkillFile } from "./surfaces/skill-projection.js";
import { applyProposals } from "./store-apply.js";
import { secretLeakReason } from "./memory-rules.js";
import {
	CURSOR_KEY_PREFIX,
	GLOBAL_WORKSPACE,
	PATROL_STATE_KEY,
	PLUGIN_LOG_MESSAGE_MAX,
	type MemoryStore,
	type SkillFileWarning,
	type SkillProposalOutcome,
} from "./store-types.js";

export type {
	DailyDelta,
	DailyStats,
	LedgerEntry,
	MemoryProposal,
	MemoryRecord,
	MemoryStore,
	PatrolResult,
	PluginLogEntry,
	ProposalContext,
	ProposalOutcome,
	ReviewLogEntry,
	SkillFileWarning,
	SkillProposalOutcome,
	SkillRecord,
	SkillUse,
	WorkspaceSummary,
} from "./store-types.js";
export {
	CURSOR_KEY_PREFIX,
	GLOBAL_WORKSPACE,
	MD_IMPORT_STATE_KEY,
	MEMORY_FILE_PREVIEW_LIMIT,
	PATROL_STATE_KEY,
	PLUGIN_LOG_MESSAGE_MAX,
} from "./store-types.js";
export { StoreUnavailableError } from "./data/database.js";

/** Default database location: `$DSH_HOME/evolve/memory.db`, else `~/.dsh/…`. */
export function defaultStorePath(): string {
	const home = process.env.DSH_HOME?.trim();
	return resolve(home && home.length > 0 ? home : join(homedir(), ".dsh"), "evolve", "memory.db");
}

/** Open (creating on first use) the central store. */
export async function openMemoryStore(explicitPath?: string): Promise<MemoryStore> {
	const path = explicitPath === undefined ? defaultStorePath() : resolve(explicitPath);
	const database = await openDatabase(path);
	migrateDatabase(database);
	const memories = new Repository<MemoryRow>(database, MEMORIES);
	const skills = new Repository<SkillRow>(database, SKILLS);

	const stmts = {
		stateGet: database.prepare("SELECT value FROM state WHERE workspace_id = ? AND key = ?"),
		stateSet: database.prepare(
			"INSERT INTO state (workspace_id, key, value) VALUES (?, ?, ?) " +
				"ON CONFLICT (workspace_id, key) DO UPDATE SET value = excluded.value",
		),
		cursorGet: database.prepare("SELECT CAST(value AS INTEGER) AS seq FROM state WHERE workspace_id = ? AND key = ?"),
		recentLedger: database.prepare(
			"SELECT workspace_id, MAX(ts) AS ts FROM extraction_log " +
				"WHERE workspace_id IS NOT NULL AND workspace_id <> '' GROUP BY workspace_id ORDER BY ts DESC LIMIT 1",
		),
		recentSkill: database.prepare(
			"SELECT workspace_id, MAX(ts) AS ts FROM skill_log " +
				"WHERE workspace_id IS NOT NULL AND workspace_id <> '' GROUP BY workspace_id ORDER BY ts DESC LIMIT 1",
		),
		ledger: database.prepare(
			"INSERT INTO extraction_log (run_id, ts, session_id, workspace_id, trigger, decision, skip_reason, status, duration_ms, model, usage, cheap_usage, cheap_error, files) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		),
		latestSkip: database.prepare(
			"SELECT rowid AS rid, skip_reason AS reason, status FROM extraction_log " +
				"WHERE workspace_id IS ? AND session_id IS ? ORDER BY ts DESC, rowid DESC LIMIT 1",
		),
		bumpSkip: database.prepare(`UPDATE extraction_log SET ts = ?, ${LEDGER_OCCURRENCES} = ${LEDGER_OCCURRENCES} + 1 WHERE rowid = ?`),
		prune: database.prepare("DELETE FROM extraction_log WHERE ts < ?"),
		skillLog: database.prepare(
			"INSERT INTO skill_log (run_id, ts, session_id, workspace_id, trigger, decision, status, files, warnings) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		),
		skillPrune: database.prepare("DELETE FROM skill_log WHERE ts < ?"),
		reviewLog: database.prepare(
			"INSERT INTO review_log (run_id, ts, workspace_id, item_kind, item_id, verdict, reason, proposed, model, cheap_usage, evolve_usage, applied, evolve_count) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		),
		reviewLast: database.prepare(
			`SELECT ts, applied FROM review_log WHERE workspace_id IS ? AND item_kind = ? AND item_id = ? AND NOT ${INCOMPLETE_REVIEW_SQL} ORDER BY rowid DESC LIMIT 1`,
		),
		reviewEvolved: database.prepare(
			"SELECT COUNT(*) AS n FROM review_log WHERE workspace_id IS ? AND item_kind = ? AND item_id = ? AND applied = 1",
		),
		reviewPrune: database.prepare("DELETE FROM review_log WHERE ts < ?"),
		pluginLog: database.prepare(
			"INSERT INTO plugin_log (ts, level, event, message, workspace_id, session_id) VALUES (?, ?, ?, ?, ?, ?)",
		),
		pluginLogPrune: database.prepare("DELETE FROM plugin_log WHERE ts < ?"),
		dailyGet: database.prepare("SELECT * FROM review_daily WHERE day = ?"),
		dailyUpsert: database.prepare(
			"INSERT INTO review_daily (day, budget, reviewed, new_items, requeued, approved, applied, cheap_token, evolve_token, backlog, dropped, skip_top, skip_counts) " +
				"VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL) " +
				"ON CONFLICT (day) DO UPDATE SET budget = excluded.budget",
		),
		dailyConsume: database.prepare("UPDATE review_daily SET reviewed = reviewed + 1 WHERE day = ? AND reviewed < budget"),
		dailyMerge: database.prepare(
			"UPDATE review_daily SET new_items = new_items + ?, requeued = requeued + ?, " +
				"approved = approved + ?, applied = applied + ?, cheap_token = cheap_token + ?, evolve_token = evolve_token + ?, " +
				"backlog = ?, dropped = dropped + ?, skip_top = ?, skip_counts = ? WHERE day = ?",
		),
	};

	const store: MemoryStore = {
		path,
		get(workspaceId, id) {
			const row = memories.getRow(workspaceId, id);
			return row === undefined ? undefined : recordOf(row);
		},
		list(workspaceId) {
			return memories.listRows(workspaceId).map(recordOf);
		},
		listAll(workspaceId) {
			return memories.listVisibleRows(workspaceId).map(recordOf);
		},
		search(workspaceId, query, limit = 20) {
			return memories.searchRows(workspaceId, query, limit).map(recordOf);
		},
		applyProposals(ctx, proposals) {
			return applyProposals({ database, now: () => new Date().toISOString(), memories }, ctx, proposals).outcomes;
		},
		logSkipped(entry) {
			if (coalesceSkipRun(stmts.latestSkip, stmts.bumpSkip, entry)) {
				return;
			}
			writeMemoryLedger(stmts.ledger, entry);
		},
		cursor(workspaceId, sessionId) {
			const row = stmts.cursorGet.get(workspaceId, CURSOR_KEY_PREFIX + sessionId) as { seq: number | null } | undefined;
			return row?.seq === null || row === undefined ? undefined : row.seq;
		},
		setCursor(workspaceId, sessionId, seq) {
			stmts.stateSet.run(workspaceId, CURSOR_KEY_PREFIX + sessionId, String(seq));
		},
		state(workspaceId, key) {
			const row = stmts.stateGet.get(workspaceId, key) as { value: string } | undefined;
			return row?.value;
		},
		setState(workspaceId, key, value) {
			stmts.stateSet.run(workspaceId, key, value);
		},
		listWorkspaces() {
			return memories.workspaceList().map((row) => ({ workspaceId: row.workspace_id, activeCount: row.n, updatedAt: row.u }));
		},
		mostRecentlyActiveWorkspace() {
			// All instants are ISO-8601 UTC, so the newer one is the greater
			// string; comparing them keeps the three sources one ordering.
			const rows = [stmts.recentLedger.get(), memories.recentInstant(), stmts.recentSkill.get()] as (
				| { workspace_id?: unknown; ts?: unknown }
				| undefined
			)[];
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
		},
		patrol() {
			const result = {
				ts: new Date().toISOString(),
				orphanFtsRows: 0,
				quarantined: [] as { workspaceId: string; id: string; reason: string }[],
				skillOrphanFtsRows: 0,
				skillQuarantined: [] as { workspaceId: string; id: string; reason: string }[],
				skillFilesReconciled: 0,
				skillOrphanFilesRemoved: 0,
				skillFileErrors: 0,
			};
			for (const rid of memories.ftsOrphanIds()) {
				memories.dropFtsRow(rid);
				result.orphanFtsRows += 1;
			}
			for (const row of memories.activeRowList()) {
				const reason = secretLeakReason(`${row.title}\n${row.description}\n${row.body}`);
				if (reason !== undefined) {
					memories.quarantineRow(row.workspace_id, row.id);
					result.quarantined.push({ workspaceId: row.workspace_id, id: row.id, reason });
				}
			}
			for (const rid of skills.ftsOrphanIds()) {
				skills.dropFtsRow(rid);
				result.skillOrphanFtsRows += 1;
			}
			for (const row of skills.activeRowList()) {
				const reason = secretLeakReason(`${row.title}\n${row.description}\n${row.body}`);
				if (reason !== undefined) {
					skills.quarantineRow(row.workspace_id, row.id);
					result.skillQuarantined.push({ workspaceId: row.workspace_id, id: row.id, reason });
					// A quarantined skill must stop loading immediately: drop
					// its managed file (hand-written files stay, with an error
					// counted so the residue stays visible).
					for (const warning of removeSkillFile(skillRootOf(row.workspace_id), row.id)) {
						void warning;
						result.skillFileErrors += 1;
					}
				}
			}
			reconcileSkillFiles(skills, result);
			stmts.stateSet.run(GLOBAL_WORKSPACE, PATROL_STATE_KEY, JSON.stringify(result));
			return result;
		},
		logPlugin(entry) {
			stmts.pluginLog.run(
				new Date().toISOString(),
				entry.level,
				entry.event,
				entry.message.slice(0, PLUGIN_LOG_MESSAGE_MAX),
				entry.workspaceId ?? null,
				entry.sessionId ?? null,
			);
		},
		pruneLedger(beforeIso) {
			const memory = Number(stmts.prune.run(beforeIso).changes);
			const skillRows = Number(stmts.skillPrune.run(beforeIso).changes);
			const reviews = Number(stmts.reviewPrune.run(beforeIso).changes);
			const logs = Number(stmts.pluginLogPrune.run(beforeIso).changes);
			return memory + skillRows + reviews + logs;
		},
		close() {
			database.close();
		},
		getSkill(workspaceId, id) {
			const row = skills.getRow(workspaceId, id);
			return row === undefined ? undefined : skillRecordOf(row);
		},
		listSkills(workspaceId) {
			return skills.listRows(workspaceId).map(skillRecordOf);
		},
		listAllSkills(workspaceId) {
			return skills.listVisibleRows(workspaceId).map(skillRecordOf);
		},
		searchSkills(workspaceId, query, limit = 20) {
			return skills.searchRows(workspaceId, query, limit).map(skillRecordOf);
		},
		applySkillProposals(ctx, proposals) {
			const outcomes: SkillProposalOutcome[] = [];
			const files: SkillLedgerFile[] = [];
			const intents: SkillFileIntent[] = [];
			const runId = ctx.runId ?? (ctx.trigger === "explicit" ? "explicit" : undefined);
			const now = new Date().toISOString();
			database.exec("BEGIN");
			for (const proposal of proposals) {
				const outcome = applySkillOne(skills, ctx, proposal, now, files, intents);
				outcomes.push(outcome);
				if (!outcome.ok) {
					break;
				}
			}
			const applied = outcomes.every((outcome) => outcome.ok);
			database.exec(applied ? "COMMIT" : "ROLLBACK");
			// The database is the source of truth: files sync after the commit
			// and never fail the batch — patrol retries whatever refuses.
			const warnings: SkillFileWarning[] = [];
			if (applied) {
				for (const intent of intents) {
					const root = skillRootOf(intent.partition);
					const row = skills.getRow(intent.partition, intent.id);
					if (intent.op === "write") {
						if (row === undefined || row.status !== "active") {
							continue;
						}
						warnings.push(...writeSkillFile(root, skillRecordOf(row)));
					} else {
						warnings.push(...removeSkillFile(root, intent.id));
					}
				}
			}
			const decision = applied ? ctx.decision : `${ctx.decision ?? ""} first failure: ${outcomes.find((o) => !o.ok)?.reason ?? ""}`.trim();
			writeSkillLedger(stmts.skillLog, {
				runId,
				sessionId: ctx.sessionId,
				workspaceId: ctx.workspaceId,
				trigger: ctx.trigger,
				decision,
				status: applied ? "applied" : "rejected",
				files: applied ? files : [],
				warnings,
			});
			return { outcomes, warnings };
		},
		listSkillWorkspaces() {
			return skills.workspaceList().map((row) => ({ workspaceId: row.workspace_id, activeCount: row.n, updatedAt: row.u }));
		},
		recordSkillUse(workspaceId: string, skillId: string, scope: string) {
			try {
				skills.recordUsage(workspaceId, [skillId, scope], new Date().toISOString());
			} catch {
				// Accounting never fails the read it rides on.
			}
		},
		getSkillUse(workspaceId: string, skillId: string, scope: string) {
			try {
				const row = skills.getUsage(workspaceId, [skillId, scope]);
				if (row === undefined) {
					return undefined;
				}
				return { useCount: row.use_count, lastUsedAt: row.last_used_at };
			} catch {
				return undefined;
			}
		},
		recordMemoryUse(workspaceId: string, memoryId: string) {
			try {
				memories.recordUsage(workspaceId, [memoryId], new Date().toISOString());
			} catch {
				// Accounting never fails the read it rides on.
			}
		},
		getMemoryUse(workspaceId: string, memoryId: string) {
			try {
				const row = memories.getUsage(workspaceId, [memoryId]);
				if (row === undefined) {
					return undefined;
				}
				return { useCount: row.use_count, lastUsedAt: row.last_used_at };
			} catch {
				return undefined;
			}
		},
		...createReviewAccounts(stmts, memories, skills),
	};
	return store;
}
