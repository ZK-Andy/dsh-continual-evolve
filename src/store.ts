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
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { openDatabase } from "./data/database.js";
import { migrateDatabase } from "./data/migrate.js";
import { coalesceSkipRun, latestWorkspaceId, prepareLedgerStmts, writeMemoryLedger, type LedgerStmts } from "./data/ledger.js";
import { promptRecordOf, recordOf, skillRecordOf, type MemoryRow, type PromptRow, type SkillRow } from "./data/records.js";
import { openRepositories, type Repository } from "./data/repository.js";
import { createReviewAccounts, createUsageCounters, prepareReviewStmts, type ReviewAccountStmts } from "./data/review-accounts.js";
import { runPatrol } from "./data/patrol.js";
import { applySkillBatch } from "./services/skill-apply.js";
import { applyPromptBatch } from "./services/prompt-apply.js";
import { reconcileSkillFiles, removeSkillFile, skillRootOf, writeSkillFile } from "./surfaces/skill-projection.js";
import { applyProposals } from "./services/memory-apply.js";
import {
	CURSOR_KEY_PREFIX,
	PLUGIN_LOG_MESSAGE_MAX,
	type MemoryStore,
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
	PromptProposalOutcome,
	PromptRecord,
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

/** The prepared statements one open store holds (state keys plus both bundles). */
type StoreStatements = {
	stateGet: StatementSync;
	stateSet: StatementSync;
	cursorGet: StatementSync;
} & LedgerStmts & ReviewAccountStmts;

/** Open (creating on first use) the central store. */
export async function openMemoryStore(explicitPath?: string): Promise<MemoryStore> {
	const path = explicitPath === undefined ? defaultStorePath() : resolve(explicitPath);
	const database = await openDatabase(path);
	migrateDatabase(database);
	const { memories, skills, prompts } = openRepositories(database);

	const stmts: StoreStatements = {
		stateGet: database.prepare("SELECT value FROM state WHERE workspace_id = ? AND key = ?"),
		stateSet: database.prepare(
			"INSERT INTO state (workspace_id, key, value) VALUES (?, ?, ?) " +
				"ON CONFLICT (workspace_id, key) DO UPDATE SET value = excluded.value",
		),
		cursorGet: database.prepare("SELECT CAST(value AS INTEGER) AS seq FROM state WHERE workspace_id = ? AND key = ?"),
		...prepareLedgerStmts(database),
		...prepareReviewStmts(database),
	};

	const store: MemoryStore = {
		path,
		...buildMemoryMethods(memories, database, stmts),
		...buildSkillMethods(skills, database, stmts.skillLog),
		...buildPromptMethods(prompts, database, stmts.promptLog),
		...buildCommonMethods(memories, skills, prompts, database, stmts),
		...createUsageCounters(memories, skills, prompts),
		...createReviewAccounts(stmts, memories, skills),
	};
	return store;
}

/** The memory read/write methods over one memories repository. */
function buildMemoryMethods(
	memories: Repository<MemoryRow>,
	database: DatabaseSync,
	stmts: Pick<StoreStatements, "stateGet" | "stateSet" | "cursorGet" | "latestSkip" | "bumpSkip" | "ledger">,
): Pick<
	MemoryStore,
	| "get"
	| "list"
	| "listAll"
	| "search"
	| "applyProposals"
	| "logSkipped"
	| "cursor"
	| "setCursor"
	| "state"
	| "setState"
	| "listWorkspaces"
> {
	return {
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
			return applyProposals({ database, now: () => new Date().toISOString(), memories, ledger: stmts.ledger }, ctx, proposals).outcomes;
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
	};
}

/** The skill read/write methods over one skills repository. */
function buildSkillMethods(
	skills: Repository<SkillRow>,
	database: DatabaseSync,
	skillLog: StatementSync,
): Pick<MemoryStore, "getSkill" | "listSkills" | "listAllSkills" | "searchSkills" | "applySkillProposals" | "listSkillWorkspaces"> {
	return {
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
			return applySkillBatch(skills, database, skillLog, ctx, proposals, {
				rootOf: skillRootOf,
				writeFile: writeSkillFile,
				removeFile: removeSkillFile,
			});
		},
		listSkillWorkspaces() {
			return skills.workspaceList().map((row) => ({ workspaceId: row.workspace_id, activeCount: row.n, updatedAt: row.u }));
		},
	};
}

/** The prompt read/write methods over one prompts repository. */
function buildPromptMethods(
	prompts: Repository<PromptRow>,
	database: DatabaseSync,
	promptLog: StatementSync,
): Pick<MemoryStore, "getPrompt" | "listPrompts" | "listAllPrompts" | "searchPrompts" | "applyPromptProposals" | "listPromptWorkspaces"> {
	return {
		getPrompt(workspaceId, id) {
			const row = prompts.getRow(workspaceId, id);
			return row === undefined ? undefined : promptRecordOf(row);
		},
		listPrompts(workspaceId) {
			return prompts.listRows(workspaceId).map(promptRecordOf);
		},
		listAllPrompts(workspaceId) {
			return prompts.listVisibleRows(workspaceId).map(promptRecordOf);
		},
		searchPrompts(workspaceId, query, limit = 20) {
			return prompts.searchRows(workspaceId, query, limit).map(promptRecordOf);
		},
		applyPromptProposals(ctx, proposals) {
			return applyPromptBatch(prompts, database, promptLog, ctx, proposals);
		},
		listPromptWorkspaces() {
			return prompts.workspaceList().map((row) => ({ workspaceId: row.workspace_id, activeCount: row.n, updatedAt: row.u }));
		},
	};
}

/** The cross-kind methods: recency race, patrol, plugin log, retention, close. */
function buildCommonMethods(
	memories: Repository<MemoryRow>,
	skills: Repository<SkillRow>,
	prompts: Repository<PromptRow>,
	database: DatabaseSync,
	stmts: Pick<
		StoreStatements,
		| "stateSet"
		| "recentLedger"
		| "recentSkill"
		| "recentPrompt"
		| "prune"
		| "skillPrune"
		| "promptPrune"
		| "reviewPrune"
		| "pluginLogPrune"
		| "pluginLog"
	>,
): Pick<MemoryStore, "mostRecentlyActiveWorkspace" | "patrol" | "logPlugin" | "pruneLedger" | "close"> {
	return {
		mostRecentlyActiveWorkspace() {
			return latestWorkspaceId([
				stmts.recentLedger.get() as { workspace_id?: unknown; ts?: unknown } | undefined,
				memories.recentInstant(),
				stmts.recentSkill.get() as { workspace_id?: unknown; ts?: unknown } | undefined,
				stmts.recentPrompt.get() as { workspace_id?: unknown; ts?: unknown } | undefined,
				prompts.recentInstant(),
			]);
		},
		patrol() {
			return runPatrol(memories, skills, prompts, (workspaceId, key, value) => stmts.stateSet.run(workspaceId, key, value), {
				rootOf: skillRootOf,
				removeFile: removeSkillFile,
				reconcile: reconcileSkillFiles,
			});
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
			const promptRows = Number(stmts.promptPrune.run(beforeIso).changes);
			const reviews = Number(stmts.reviewPrune.run(beforeIso).changes);
			const logs = Number(stmts.pluginLogPrune.run(beforeIso).changes);
			return memory + skillRows + promptRows + reviews + logs;
		},
		close() {
			database.close();
		},
	};
}
