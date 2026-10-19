/**
 * The central SQLite memory store: one database file
 * (`~/.dsh/evolve/memory.db`, rows partitioned by workspace path) holding
 * every memory record, its FTS index, the extraction ledger, and per-session
 * extraction cursors. The plugin's code is the literal sole writer — models
 * propose, the gates land. See ADR `2026-10-06-sqlite-single-store`.
 *
 * This file is the assembly root for storage: it opens the database,
 * prepares the statements, and spreads the method factories over one
 * {@link MemoryStore}. Row and record shapes share one home in
 * `./data/records.js`, SQL bundles in `./data/resource-kinds.js`,
 * ledgers in `./data/ledger.js`, review accounts in
 * `./data/review-accounts.js`, skill writes in `./services/skill-apply.js`,
 * and file projection in `./services/skill-files.js`.
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
import { coalesceSkipRun, latestWorkspaceId, prepareLedgerStmts, prepareStateStmts, writeMemoryLedger, type LedgerStmts, type StateStmts } from "./data/ledger.js";
import { promptRecordOf, recordOf, skillRecordOf, type MemoryRow, type PromptRow, type SkillRow } from "./data/records.js";
import { openRepositories, type Repository } from "./data/repository.js";
import {
	createInjectionMethods,
	createItemEventMethods,
	createReviewAccounts,
	createTieringMethods,
	createUsageCounters,
	itemEventWriter,
	prepareInjectionStmts,
	prepareItemEventStmts,
	prepareReviewStmts,
	prepareTieringStmts,
	type InjectionStmts,
	type ItemEventStmts,
	type ReviewAccountStmts,
	type TieringStmts,
} from "./data/accounts.js";
import { runPatrol } from "./data/patrol.js";
import { applySkillBatch } from "./services/skill-apply.js";
import { applyPromptBatch } from "./services/prompt-apply.js";
import { reconcileSkillFiles, removeSkillFile, skillRootOf, writeSkillFile } from "./services/skill-files.js";
import { applyProposals } from "./services/memory-apply.js";
import {
	CURSOR_KEY_PREFIX,
	GLOBAL_WORKSPACE,
	PLUGIN_LOG_MESSAGE_MAX,
	type ItemEventEntry,
	type MemoryRecord,
	type MemoryStore,
} from "./store-types.js";

export type {
	DailyDelta,
	DailyStats,
	ItemEventEntry,
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
	ROUTE_BACKOFF_REASON,
	ROUTE_HALTED_REASON,
	ROUTE_REJECTED_REASON,
} from "./store-types.js";
export { StoreUnavailableError } from "./data/database.js";

/** Default database location: `$DSH_HOME/evolve/memory.db`, else `~/.dsh/…`. */
export function defaultStorePath(): string {
	const home = process.env.DSH_HOME?.trim();
	return resolve(home && home.length > 0 ? home : join(homedir(), ".dsh"), "evolve", "memory.db");
}

/** The prepared statements one open store holds (state keys plus both bundles). */
type StoreStatements = StateStmts & LedgerStmts & ReviewAccountStmts & ItemEventStmts & InjectionStmts & TieringStmts;

/** Open (creating on first use) the central store. */
export async function openMemoryStore(explicitPath?: string): Promise<MemoryStore> {
	const path = explicitPath === undefined ? defaultStorePath() : resolve(explicitPath);
	const database = await openDatabase(path);
	migrateDatabase(database);
	const { memories, skills, prompts } = openRepositories(database);

	const stmts: StoreStatements = {
		...prepareStateStmts(database),
		...prepareLedgerStmts(database),
		...prepareReviewStmts(database),
		...prepareItemEventStmts(database),
		...prepareInjectionStmts(database),
		...prepareTieringStmts(database),
	};

	const store: MemoryStore = {
		path,
		...buildMemoryMethods(memories, database, stmts, itemEventWriter(stmts)),
		...buildSkillMethods(skills, database, stmts.skillLog),
		...buildPromptMethods(prompts, database, stmts.promptLog),
		...buildCommonMethods(memories, skills, prompts, database, stmts),
		...createUsageCounters(memories, skills, prompts),
		...createReviewAccounts(stmts, memories, skills),
		...createItemEventMethods(stmts),
		...createTieringMethods(database, memories, stmts, () => new Date()),
		...createInjectionMethods(stmts),
	};
	return store;
}

/**
 * The memory reads, with the global (L0) partition merged in: a project
 * session sees person-level rows without owning them, and a local row with the
 * same id shadows the global one (the L0/L1 rule of
 * `2026-10-13-memory-tiering-and-promotion`).
 * @param memories - The memories repository.
 * @returns The five read methods.
 */
function memoryReads(memories: Repository<MemoryRow>): Pick<MemoryStore, "get" | "list" | "listAll" | "listArchived" | "search"> {
	return {
		get(workspaceId, id) {
			// A local row shadows the global one unless it is archived: promotion
			// archives the source row, and the promoted copy must then be what a
			// read returns (the archived row is history, not a shadow).
			const local = memories.getRow(workspaceId, id);
			if (local !== undefined && local.status !== "archived") {
				return recordOf(local);
			}
			const global = workspaceId === GLOBAL_WORKSPACE ? undefined : memories.getRow(GLOBAL_WORKSPACE, id);
			if (global !== undefined && global.status !== "archived") {
				return recordOf(global);
			}
			return local === undefined ? undefined : recordOf(local);
		},
		list(workspaceId) {
			// L0 first: the injection index is this list, so a person-level fact
			// outranks project detail inside the section budget.
			if (workspaceId === GLOBAL_WORKSPACE) {
				return memories.listRows(GLOBAL_WORKSPACE).map(recordOf);
			}
			const local = memories.listRows(workspaceId).map(recordOf);
			return [...unshadowed(memories, local), ...local];
		},
		listAll(workspaceId) {
			// The card's projection stays partition-scoped: the global partition
			// lists itself, and merging here would show every row twice.
			return memories.listVisibleRows(workspaceId).map(recordOf);
		},
		listArchived(workspaceId, limit = 50) {
			return memories.listArchivedRows(workspaceId, limit).map(recordOf);
		},
		search(workspaceId, query, limit = 20) {
			const local = memories.searchRows(workspaceId, query, limit).map(recordOf);
			if (workspaceId === GLOBAL_WORKSPACE) {
				return local;
			}
			return [...unshadowed(memories, local), ...local].slice(0, limit);
		},
	};
}

/**
 * The global rows no local record shadows, in injection order.
 * @param memories - The memories repository.
 * @param local - The partition's own records.
 * @returns The global records eligible for the merged read.
 */
function unshadowed(memories: Repository<MemoryRow>, local: readonly MemoryRecord[]): MemoryRecord[] {
	const shadowed = new Set(local.map((record) => record.id));
	return memories.listRows(GLOBAL_WORKSPACE).map(recordOf).filter((record) => !shadowed.has(record.id));
}

/** The memory read/write methods over one memories repository. */
function buildMemoryMethods(
	memories: Repository<MemoryRow>,
	database: DatabaseSync,
	stmts: Pick<
		StoreStatements,
		"stateGet" | "stateSet" | "stateListPrefix" | "stateDelete" | "cursorGet" | "latestSkip" | "bumpSkip" | "ledger"
	>,
	events: (entries: readonly ItemEventEntry[]) => void,
): Pick<
	MemoryStore,
	| "get"
	| "list"
	| "listAll"
	| "listArchived"
	| "search"
	| "applyProposals"
	| "logSkipped"
	| "cursor"
	| "setCursor"
	| "state"
	| "setState"
	| "listState"
	| "deleteState"
	| "listWorkspaces"
> {
	return {
		...memoryReads(memories),
		applyProposals(ctx, proposals) {
			return applyProposals(
				{ database, now: () => new Date().toISOString(), memories, ledger: stmts.ledger, events },
				ctx,
				proposals,
			).outcomes;
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
		listState(prefix) {
			const rows = stmts.stateListPrefix.all(prefix) as { workspace_id: string; key: string; value: string }[];
			return rows.map((row) => ({ workspaceId: row.workspace_id, key: row.key, value: row.value }));
		},
		deleteState(workspaceId, key) {
			stmts.stateDelete.run(workspaceId, key);
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
		| "evalPrune"
		| "skillPrune"
		| "promptPrune"
		| "reviewPrune"
		| "itemEventPrune"
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
			const events = Number(stmts.itemEventPrune.run(beforeIso).changes);
			const logs = Number(stmts.pluginLogPrune.run(beforeIso).changes);
			const evalRows = Number(stmts.evalPrune.run(beforeIso).changes);
			return memory + skillRows + promptRows + reviews + events + logs + evalRows;
		},
		close() {
			database.close();
		},
	};
}
