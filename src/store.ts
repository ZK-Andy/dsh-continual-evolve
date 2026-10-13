/**
 * The central SQLite memory store: one database file
 * (`~/.dsh/evolve/memory.db`, rows partitioned by workspace path) holding
 * every memory record, its FTS index, the extraction ledger, and per-session
 * extraction cursors. The plugin's code is the literal sole writer — models
 * propose, `applyProposals` gates and lands. See ADR
 * `2026-10-06-sqlite-single-store`.
 *
 * Requires `node:sqlite` (Node ≥ 22.5; the desktop host's EnsureNode runtime
 * guarantees v26). Unavailability is a typed error the entry point degrades
 * on — injection and tooling switch off, the host keeps running.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryProposal } from "./memory-rules.js";
import { secretLeakReason } from "./memory-rules.js";
import {
	globalSkillsDir,
	projectSkillsDir,
	renderSkillMarkdown,
	SKILL_GENERATED_MARKER,
	skillDir,
	skillFieldGateReasons,
	slugifySkillId,
	validateRenderedSkill,
	type SkillFields,
	type SkillProposal,
} from "./skill-rules.js";
import { isValidMemoryId } from "./memory-rules.js";
import { applyProposals, type ProposalContext, type ProposalOutcome } from "./store-apply.js";

export type { MemoryProposal, ProposalContext, ProposalOutcome };

/** Thrown when the runtime lacks `node:sqlite` — the degrade signal. */
export class StoreUnavailableError extends Error {}

/** State-table keys owned by the store (partitioned per workspace, `""` = global). */
export const CURSOR_KEY_PREFIX = "seq:";
export const PATROL_STATE_KEY = "patrol:last";
export const MD_IMPORT_STATE_KEY = "md-imported";
/** Global partition id for workspace-independent state rows. */
export const GLOBAL_WORKSPACE = "";
/** Preview size cap for the card's content endpoint (ZCode's viewer uses 5 MiB). */
export const MEMORY_FILE_PREVIEW_LIMIT = 5 * 1024 * 1024;
/** Ledger column counting the wake-ups one coalesced row stands for. */
const LEDGER_OCCURRENCES = "occurrences";
/**
 * Skips a busy-but-quiet session repeats verbatim, turn after turn: the
 * ledger keeps one counted row instead of one row per wake-up. Fault-shaped
 * skips (`no-route`, `no-surface`, `no-workspace`) and every failure stay one
 * row per occurrence — a persistent fault deserves a timeline, not a counter.
 */
const COALESCED_SKIP_REASONS = new Set(["no-user-prose", "no-new-events"]);

/**
 * Verdict rows that leave an item queued: a call that never produced a verdict
 * must not read as "reviewed". Without this a single gate fault (a route blip,
 * a budget cut) locked the item out for `staleDays`, because the failure row
 * counted as a finished review (2026-10-13).
 */
const INCOMPLETE_REVIEW_SQL =
	"(coalesce(reason, '') LIKE 'gate-llm-failed%' OR coalesce(reason, '') LIKE 'evolve-llm-failed%' " +
	"OR coalesce(reason, '') IN ('no-route', 'budget-exhausted', 'gate-parse-failed', 'evolve-parse-failed'))";

const DDL = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS memories (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('user','feedback','reference')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) <= 65536),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','quarantined','archived')),
  source_session TEXT,
  source_seqs TEXT,
  source_run TEXT,
  corrects TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_mem_ws_status ON memories(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_mem_ws_updated ON memories(workspace_id, updated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  workspace_id, id, title, description, body, tokenize='trigram');
-- FTS rows are synced in code by applyProposals (plain DELETE + INSERT), not
-- by triggers: node:sqlite rejects the FTS5 'delete'-command INSERT that
-- AFTER DELETE/UPDATE triggers would need (SQL logic error, verified on
-- SQLite 3.53.4). The sole-writer design makes code-side sync reliable;
-- patrol() reconciles any residue.
CREATE TABLE IF NOT EXISTS extraction_log (
  run_id TEXT, ts TEXT NOT NULL, session_id TEXT, workspace_id TEXT,
  trigger TEXT CHECK (trigger IN ('turn-debounce','compaction','close-drain','explicit','import','item-review')),
  decision TEXT, skip_reason TEXT,
  status TEXT, duration_ms INTEGER, model TEXT, usage TEXT,
  cheap_usage TEXT, cheap_error TEXT,
  files TEXT, occurrences INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS state (
  workspace_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
CREATE TABLE IF NOT EXISTS skills (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) <= 65536),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','quarantined','archived')),
  source_session TEXT,
  source_seqs TEXT,
  source_run TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_skill_ws_status ON skills(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_skill_ws_updated ON skills(workspace_id, updated_at);
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  workspace_id, id, title, description, body, tokenize='trigram');
-- Like memories_fts, synced in code by the skill apply path (plain DELETE +
-- INSERT), never by triggers, for the same node:sqlite FTS5 reason.
CREATE TABLE IF NOT EXISTS skill_log (
  run_id TEXT, ts TEXT NOT NULL, session_id TEXT, workspace_id TEXT,
  trigger TEXT, decision TEXT, status TEXT, files TEXT, warnings TEXT
);
-- Skill usage counters (V2 usage loop): one aggregate row per skill, never a
-- per-hit ledger, so the table cannot grow without bound and needs no prune.
CREATE TABLE IF NOT EXISTS skill_usage (
  workspace_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project','global')),
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  PRIMARY KEY (workspace_id, skill_id, scope)
) STRICT;
-- Memory usage counters (content-quality loop): one aggregate row per memory,
-- the same presence-heartbeat discipline as skill_usage — a body served by id
-- counts, search/list hits stay uncounted.
CREATE TABLE IF NOT EXISTS memory_usage (
  workspace_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  PRIMARY KEY (workspace_id, memory_id)
) STRICT;
-- Per-item content-review verdicts (the item-review trigger's account):
-- one row per reviewed item per run, with the model it ran on so a failure
-- rate can be attributed instead of guessed at. Pruned with the ledgers.
CREATE TABLE IF NOT EXISTS review_log (
  run_id TEXT, ts TEXT NOT NULL, workspace_id TEXT,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('memory','skill')),
  item_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('keep','rewrite','quarantine','skip')),
  reason TEXT,
  proposed TEXT,
  model TEXT,
  cheap_usage TEXT, evolve_usage TEXT,
  applied INTEGER NOT NULL DEFAULT 0,
  evolve_count INTEGER NOT NULL DEFAULT 0
);
-- One rollup row per UTC day: the hard-cap account (budget vs reviewed vs
-- backlog vs dropped) plus the token account split by cheap/evolve purpose.
CREATE TABLE IF NOT EXISTS review_daily (
  day TEXT NOT NULL PRIMARY KEY,
  budget INTEGER NOT NULL,
  reviewed INTEGER NOT NULL DEFAULT 0,
  new_items INTEGER NOT NULL DEFAULT 0,
  requeued INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  applied INTEGER NOT NULL DEFAULT 0,
  cheap_token INTEGER NOT NULL DEFAULT 0,
  evolve_token INTEGER NOT NULL DEFAULT 0,
  backlog INTEGER NOT NULL DEFAULT 0,
  dropped INTEGER NOT NULL DEFAULT 0,
  skip_top TEXT,
  skip_counts TEXT
) STRICT;
`;

/** One stored skill record (snake_case columns camelCased). Skills carry no type. */
export interface SkillRecord {
	workspaceId: string;
	id: string;
	title: string;
	description: string;
	body: string;
	status: "active" | "quarantined" | "archived";
	/** Origin session id, `null` for imports. */
	sourceSession: string | null;
	/** Trajectory seq range the skill came from ("820-831"), `null` when unknown. */
	sourceSeqs: string | null;
	/** The run that wrote it; `'explicit'` for tool writes. */
	sourceRun: string | null;
	createdAt: string;
	updatedAt: string;
}

/** What a single skill proposal produced. */
export interface SkillProposalOutcome {
	id: string;
	action: SkillProposal["action"];
	ok: boolean;
	/** Blocking reason when `ok` is false. */
	reason?: string;
}

/** A non-fatal file-projection problem the caller should surface. */
export interface SkillFileWarning {
	id: string;
	warning: string;
}

/** Aggregate consumption of one skill (the V2 usage loop's only counter). */
export interface SkillUse {
	useCount: number;
	/** ISO instant of the last counted use, `null` when never consumed. */
	lastUsedAt: string | null;
}

/** One per-item content-review verdict (the `item-review` account's row). */
export interface ReviewLogEntry {
	runId?: string | undefined;
	workspaceId?: string | undefined;
	itemKind: "memory" | "skill";
	itemId: string;
	verdict: "keep" | "rewrite" | "quarantine" | "skip";
	reason?: string | undefined;
	/** The model this verdict ran on; `undefined` only when the run had no route at all. */
	model?: string | undefined;
	/** Normalized usage JSON of the cheap gate call, `undefined` when skipped before any call. */
	cheapUsage?: unknown;
	/** Normalized usage JSON of the evolve call, `undefined` unless rewritten. */
	evolveUsage?: unknown;
	/** Whether the rewrite landed (1) or the row is verdict-only (0). */
	applied?: number | undefined;
	/** How many times this item has evolved including this run. */
	evolveCount?: number | undefined;
	/**
	 * The rewrite the model proposed when the row did NOT land it (trial mode),
	 * as `{title, description, body, corrects}`. Without it a dry run ledgers
	 * only why it would change an item, never into what — and the "into what"
	 * is the part a human has to judge before turning the trial off.
	 */
	proposed?: unknown;
}

/** One day of the hard-cap account (UTC `YYYY-MM-DD`, budget = 100). */
export interface DailyStats {
	day: string;
	budget: number;
	reviewed: number;
	newItems: number;
	requeued: number;
	approved: number;
	applied: number;
	cheapToken: number;
	evolveToken: number;
	backlog: number;
	dropped: number;
	/** JSON array of the top skip reasons, `null` when none. */
	skipTop: string | null;
}

/** Additive counters merged into today's rollup by one run. */
export interface DailyDelta {
	newItems?: number | undefined;
	requeued?: number | undefined;
	approved?: number | undefined;
	applied?: number | undefined;
	cheapToken?: number | undefined;
	evolveToken?: number | undefined;
	/** Queue depth after the run (set, not added). */
	backlog?: number | undefined;
	dropped?: number | undefined;
	skipReasons?: string[] | undefined;
}

/** One stored memory record (snake_case columns camelCased). */
export interface MemoryRecord {
	workspaceId: string;
	id: string;
	type: "user" | "feedback" | "reference";
	title: string;
	description: string;
	body: string;
	status: "active" | "quarantined" | "archived";
	/** Origin session id, `null` for imports. */
	sourceSession: string | null;
	/** Trajectory seq range the fact came from ("820-831"), `null` when unknown. */
	sourceSeqs: string | null;
	/** The extraction run that wrote it; `'explicit'` for tool writes. */
	sourceRun: string | null;
	/** Id of the memory this row corrects/supersedes in the same workspace, `null` when standalone. */
	corrects: string | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * One ledger row (audit + rollback via embedded before/after snapshots).
 * Consecutive mechanical skips of the same kind share one row, whose
 * `occurrences` column counts the wake-ups it stands for (`1` for everything
 * else); the interface never sets it — the store owns that column.
 */
export interface LedgerEntry {
	runId?: string | undefined;
	sessionId?: string | undefined;
	workspaceId?: string | undefined;
	trigger: "turn-debounce" | "compaction" | "close-drain" | "explicit" | "import" | "item-review";
	decision?: string | undefined;
	skipReason?: string | undefined;
	status?: string | undefined;
	durationMs?: number | undefined;
	model?: string | undefined;
	usage?: unknown;
	/** Pre-gate call payload (extraction cheap gate); `undefined` when the run never reached it. */
	cheapUsage?: unknown;
	/**
	 * Why the pre-gate call left no payload: the error head when the gate
	 * threw (fail open). `undefined` when the gate never ran, never resolved
	 * to an answer, or was not reached — the column exists so that a failed
	 * gate is tellable from a gate that never existed.
	 */
	cheapError?: string | undefined;
	/** Applied/attempted mutations: `{id, action, before?, after?, sourceSeqs}`; a parse-failed run instead carries the raw answer's head. */
	files?: unknown;
}

/** Workspace rows the card's selector lists. */
export interface WorkspaceSummary {
	workspaceId: string;
	activeCount: number;
	updatedAt: string;
}

/** What a patrol pass found and did. */
export interface PatrolResult {
	ts: string;
	/** Orphan FTS rows (no matching memory) removed. */
	orphanFtsRows: number;
	/** Records quarantined by the secret screen, with the redacted reasons. */
	quarantined: { workspaceId: string; id: string; reason: string }[];
	/** Orphan skill FTS rows (no matching skill) removed. */
	skillOrphanFtsRows: number;
	/** Skills quarantined by the secret screen, with the redacted reasons. */
	skillQuarantined: { workspaceId: string; id: string; reason: string }[];
	/** Managed SKILL.md files rewritten or created to match the store. */
	skillFilesReconciled: number;
	/** Orphan managed SKILL.md files (no active store row) removed. */
	skillOrphanFilesRemoved: number;
	/** Managed file operations that failed (retried by the next patrol). */
	skillFileErrors: number;
}

/** The store surface every consumer (tool, extraction, card, injection) uses. */
export interface MemoryStore {
	readonly path: string;
	get(workspaceId: string, id: string): MemoryRecord | undefined;
	/** Active records, injection order: feedback > user > reference, then newest. */
	list(workspaceId: string): MemoryRecord[];
	/** Every non-archived record regardless of status (the card's projection). */
	listAll(workspaceId: string): MemoryRecord[];
	/**
	 * Keyword search, workspace-scoped: whitespace-separated tokens are
	 * AND-combined — trigram FTS when every token is ≥3 chars, literal LIKE
	 * substrings otherwise, and a LIKE fallback whenever FTS finds nothing.
	 */
	search(workspaceId: string, query: string, limit?: number): MemoryRecord[];
	/** The sole write gate: validate all proposals, apply atomically, ledger. */
	applyProposals(ctx: ProposalContext, proposals: readonly MemoryProposal[]): ProposalOutcome[];
	/** Ledger a run that produced no mutations (skips must be auditable too). */
	logSkipped(entry: LedgerEntry): void;
	cursor(workspaceId: string, sessionId: string): number | undefined;
	setCursor(workspaceId: string, sessionId: string, seq: number): void;
	state(workspaceId: string, key: string): string | undefined;
	setState(workspaceId: string, key: string, value: string): void;
	listWorkspaces(): WorkspaceSummary[];
	/**
	 * The partition with the most recent session activity: the newest ledger
	 * instant against the newest memory or skill write, whichever is later.
	 * The ledgers carry a row for every run — including skips and explicit
	 * writes — so they track "a session worked here", while the memory write
	 * is the durable fallback for a partition whose ledger rows were pruned.
	 * Undefined only when the store holds neither.
	 */
	mostRecentlyActiveWorkspace(): string | undefined;
	/** Hygiene pass: orphan FTS cleanup + secret quarantine. */
	patrol(): PatrolResult;
	/** Ledger rows older than the cutoff, removed (the one unbounded table). */
	pruneLedger(beforeIso: string): number;
	close(): void;
	/** One active skill row from a partition, undefined when absent. */
	getSkill(workspaceId: string, id: string): SkillRecord | undefined;
	/** Active skills of one partition, newest first. */
	listSkills(workspaceId: string): SkillRecord[];
	/** Every non-archived skill of one partition, newest first. */
	listAllSkills(workspaceId: string): SkillRecord[];
	/**
	 * Keyword search over skills, workspace-scoped: same AND-combined
	 * trigram/LIKE discipline as memory search.
	 */
	searchSkills(workspaceId: string, query: string, limit?: number): SkillRecord[];
	/**
	 * The sole skill write gate: validate all proposals, apply atomically,
	 * ledger with before/after snapshots, then sync the materialized files.
	 * File sync never fails the batch — the database is the source of truth
	 * and patrol retries whatever the filesystem refused.
	 */
	applySkillProposals(
		ctx: ProposalContext,
		proposals: readonly SkillProposal[],
	): { outcomes: SkillProposalOutcome[]; warnings: SkillFileWarning[] };
	/** Partitions holding active skills (the card's skill fence). */
	listSkillWorkspaces(): WorkspaceSummary[];
	/**
	 * Record one real skill consumption (a body served by id, never a list
	 * or search hit). Accounting never fails the read — failures degrade
	 * silently, exactly like file sync never fails a write batch.
	 */
	recordSkillUse(workspaceId: string, skillId: string, scope: string): void;
	/** Aggregate usage for one skill, undefined when never consumed. */
	getSkillUse(workspaceId: string, skillId: string, scope: string): SkillUse | undefined;
	/**
	 * Record one real memory consumption (a body served by id, never a list
	 * or search hit). Same heartbeat discipline as skill usage: accounting
	 * never fails the read it rides on.
	 */
	recordMemoryUse(workspaceId: string, memoryId: string): void;
	/** Aggregate usage for one memory, undefined when never consumed. */
	getMemoryUse(workspaceId: string, memoryId: string): SkillUse | undefined;
	/** Append one per-item content-review verdict (the `item-review` account). */
	logReview(entry: ReviewLogEntry): void;
	/**
	 * Atomically consume one unit of today's review budget: returns the
	 * remaining budget after consumption, or -1 when the day is exhausted
	 * (the caller drops the low-priority item and counts it as dropped).
	 */
	consumeReviewBudget(day: string, budget: number): number;
	/** Today's rollup row, undefined when nothing ran yet today. */
	getDaily(day: string): DailyStats | undefined;
	/** Merge one run's counters into today's rollup row (upsert, additive). */
	mergeDaily(day: string, budget: number, delta: DailyDelta): void;
	/**
	 * Soft-isolate one item (review quarantine verdict): hidden from
	 * injection and reads, never deleted — the ledger keeps the before
	 * snapshot for undo. Returns false when the row is absent.
	 */
	quarantine(workspaceId: string, kind: "memory" | "skill", id: string): boolean;
	/**
	 * The review history of one item: last verdict instant and landed
	 * rewrite count, undefined when never reviewed (a new item).
	 */
	reviewStateOf(workspaceId: string, kind: "memory" | "skill", id: string): { lastTs: string | null; evolveCount: number } | undefined;
}

/** Default database location: `$DSH_HOME/evolve/memory.db`, else `~/.dsh/…`. */
export function defaultStorePath(): string {
	const home = process.env.DSH_HOME?.trim();
	return resolve(home && home.length > 0 ? home : join(homedir(), ".dsh"), "evolve", "memory.db");
}

interface MemoryRow {
	workspace_id: string;
	id: string;
	type: string;
	title: string;
	description: string;
	body: string;
	status: string;
	source_session: string | null;
	source_seqs: string | null;
	source_run: string | null;
	corrects: string | null;
	created_at: string;
	updated_at: string;
}

function recordOf(row: MemoryRow): MemoryRecord {
	return {
		workspaceId: row.workspace_id,
		id: row.id,
		type: row.type as MemoryRecord["type"],
		title: row.title,
		description: row.description,
		body: row.body,
		status: row.status as MemoryRecord["status"],
		sourceSession: row.source_session,
		sourceSeqs: row.source_seqs,
		sourceRun: row.source_run,
		corrects: row.corrects ?? null,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

interface SkillRow {
	workspace_id: string;
	id: string;
	title: string;
	description: string;
	body: string;
	status: string;
	source_session: string | null;
	source_seqs: string | null;
	source_run: string | null;
	created_at: string;
	updated_at: string;
}

function skillRecordOf(row: SkillRow): SkillRecord {
	return {
		workspaceId: row.workspace_id,
		id: row.id,
		title: row.title,
		description: row.description,
		body: row.body,
		status: row.status as SkillRecord["status"],
		sourceSession: row.source_session,
		sourceSeqs: row.source_seqs,
		sourceRun: row.source_run,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

const LIST_ORDER =
	"ORDER BY CASE type WHEN 'feedback' THEN 0 WHEN 'user' THEN 1 ELSE 2 END, updated_at DESC";

/** Quote one token as an FTS5 phrase (trigram needs ≥3 chars to match). */
function ftsPhrase(token: string): string {
	return `"${token.replaceAll('"', '""')}"`;
}

/**
 * Split a query into keyword tokens on ASCII or full-width whitespace. Each
 * token is matched on its own and AND-combined: trigram FTS can only match
 * ≥3-char runs, so a keyword pair like `中文 交接` is unrepresentable as one
 * FTS phrase and silently returns nothing under a phrase match.
 */
function queryTokens(query: string): string[] {
	return query.split(/[\s\u3000]+/).filter((token) => token.length > 0);
}

/** `%token%` with LIKE metacharacters escaped — keywords match literally. */
function likePattern(token: string): string {
	return `%${token.replaceAll(/[\\%_]/g, "\\$&")}%`;
}

/** The materialized directory for one skill partition (global vs project). */
function skillRootOf(workspaceId: string): string {
	return workspaceId === "" ? globalSkillsDir() : projectSkillsDir(workspaceId);
}

/** Read a materialized file, undefined when missing or unreadable. */
function readSkillFile(root: string, id: string): string | undefined {
	let dir: string;
	try {
		dir = skillDir(root, id);
	} catch {
		return undefined;
	}
	try {
		return readFileSync(join(dir, "SKILL.md"), "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Write one active skill row as its SKILL.md (atomic tmp + rename so the
 * host watcher never sees a partial file). Returns materialization warnings —
 * the row already landed, so the caller surfaces them instead of failing.
 */
function writeSkillFile(root: string, record: SkillRecord): SkillFileWarning[] {
	const rendered = renderSkillMarkdown(record);
	const warnings = validateRenderedSkill(record).map((problem) => ({ id: record.id, warning: `skill ${record.id}: ${problem}` }));
	let dir: string;
	try {
		dir = skillDir(root, record.id);
	} catch (error) {
		return [{ id: record.id, warning: `skill ${record.id}: ${error instanceof Error ? error.message : String(error)}` }];
	}
	try {
		mkdirSync(dir, { recursive: true });
		const temp = join(dir, `SKILL.md.${process.pid}.tmp`);
		writeFileSync(temp, rendered, "utf8");
		renameSync(temp, join(dir, "SKILL.md"));
	} catch (error) {
		warnings.push({ id: record.id, warning: `skill ${record.id}: file write failed, patrol will retry: ${error instanceof Error ? error.message : String(error)}` });
	}
	return warnings;
}

/**
 * Remove one skill's materialized directory after its row left the active
 * set. Only files carrying the generated marker are removed — a hand-written
 * skill that happens to share the directory is left in place with a warning.
 */
function removeSkillFile(root: string, id: string): SkillFileWarning[] {
	let dir: string;
	try {
		dir = skillDir(root, id);
	} catch (error) {
		return [{ id, warning: `skill ${id}: ${error instanceof Error ? error.message : String(error)}` }];
	}
	let current: string;
	try {
		current = readFileSync(join(dir, "SKILL.md"), "utf8");
	} catch {
		return [];
	}
	if (!current.includes(SKILL_GENERATED_MARKER)) {
		return [{ id, warning: `skill ${id}: ${join(dir, "SKILL.md")} is hand-written, left in place` }];
	}
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch (error) {
		return [{ id, warning: `skill ${id}: file removal failed, patrol will retry: ${error instanceof Error ? error.message : String(error)}` }];
	}
	return [];
}

/** Open (creating on first use) the central store. */
export async function openMemoryStore(explicitPath?: string): Promise<MemoryStore> {
	const path = explicitPath === undefined ? defaultStorePath() : resolve(explicitPath);
	let database: DatabaseSync;
	try {
		const { DatabaseSync } = await import("node:sqlite");
		// The parent directory must exist before SQLite opens the file — a
		// fresh `~/.dsh` has no `evolve/` yet.
		mkdirSync(dirname(path), { recursive: true });
		database = new DatabaseSync(path);
	} catch (error) {
		throw new StoreUnavailableError(
			`node:sqlite unavailable (Node ≥ 22.5 required) — memory store disabled: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	database.exec(DDL);
	ensureLedgerOccurrences(database);
	ensureMemoriesCorrects(database);
	ensureExtractionCheapUsage(database);
	ensureExtractionCheapError(database);
	ensureReviewProposed(database);
	ensureReviewModel(database);

	const stmts = {
		get: database.prepare("SELECT * FROM memories WHERE workspace_id = ? AND id = ?"),
		list: database.prepare(`SELECT * FROM memories WHERE workspace_id = ? AND status = 'active' ${LIST_ORDER}`),
		listAll: database.prepare(`SELECT * FROM memories WHERE workspace_id = ? AND status != 'archived' ${LIST_ORDER}`),
		fts: database.prepare(
			`SELECT m.* FROM memories m WHERE (m.workspace_id, m.id) IN (
				 SELECT workspace_id, id FROM memories_fts WHERE memories_fts MATCH ? AND workspace_id = ?
				) AND m.status = 'active' ${LIST_ORDER} LIMIT ?`,
		),
		stateGet: database.prepare("SELECT value FROM state WHERE workspace_id = ? AND key = ?"),
		stateSet: database.prepare(
			"INSERT INTO state (workspace_id, key, value) VALUES (?, ?, ?) " +
				"ON CONFLICT (workspace_id, key) DO UPDATE SET value = excluded.value",
		),
		cursorGet: database.prepare(
			"SELECT CAST(value AS INTEGER) AS seq FROM state WHERE workspace_id = ? AND key = ?",
		),
		workspaces: database.prepare(
			"SELECT workspace_id, COUNT(*) AS n, MAX(updated_at) AS u FROM memories WHERE status = 'active' GROUP BY workspace_id ORDER BY u DESC",
		),
		recentLedger: database.prepare(
			"SELECT workspace_id, MAX(ts) AS ts FROM extraction_log " +
				"WHERE workspace_id IS NOT NULL AND workspace_id <> '' GROUP BY workspace_id ORDER BY ts DESC LIMIT 1",
		),
		recentMemory: database.prepare(
			"SELECT workspace_id, MAX(updated_at) AS ts FROM memories " +
				"WHERE status = 'active' AND workspace_id <> '' GROUP BY workspace_id ORDER BY ts DESC LIMIT 1",
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
		bumpSkip: database.prepare(
			`UPDATE extraction_log SET ts = ?, ${LEDGER_OCCURRENCES} = ${LEDGER_OCCURRENCES} + 1 WHERE rowid = ?`,
		),
		prune: database.prepare("DELETE FROM extraction_log WHERE ts < ?"),
		ftsOrphans: database.prepare(
			"SELECT f.rowid AS rid FROM memories_fts f LEFT JOIN memories m ON m.workspace_id = f.workspace_id AND m.id = f.id WHERE m.id IS NULL",
		),
		ftsDrop: database.prepare("DELETE FROM memories_fts WHERE rowid = ?"),
		activeRows: database.prepare("SELECT * FROM memories WHERE status = 'active'"),
		quarantine: database.prepare("UPDATE memories SET status = 'quarantined' WHERE workspace_id = ? AND id = ?"),
		skillGet: database.prepare("SELECT * FROM skills WHERE workspace_id = ? AND id = ?"),
		skillList: database.prepare("SELECT * FROM skills WHERE workspace_id = ? AND status = 'active' ORDER BY updated_at DESC"),
		skillListAll: database.prepare("SELECT * FROM skills WHERE workspace_id = ? AND status != 'archived' ORDER BY updated_at DESC"),
		skillFts: database.prepare(
			`SELECT s.* FROM skills s WHERE (s.workspace_id, s.id) IN (
				 SELECT workspace_id, id FROM skills_fts WHERE skills_fts MATCH ? AND workspace_id = ?
				) AND s.status = 'active' ORDER BY updated_at DESC LIMIT ?`,
		),
		skillInsert: database.prepare(
			"INSERT INTO skills (workspace_id, id, title, description, body, status, source_session, source_seqs, source_run, created_at, updated_at) " +
				"VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)",
		),
		skillUpdate: database.prepare("UPDATE skills SET title = ?, description = ?, body = ?, updated_at = ? WHERE workspace_id = ? AND id = ?"),
		skillArchive: database.prepare("UPDATE skills SET status = 'archived', updated_at = ? WHERE workspace_id = ? AND id = ?"),
		skillDelete: database.prepare("DELETE FROM skills WHERE workspace_id = ? AND id = ?"),
		skillSameBody: database.prepare("SELECT id FROM skills WHERE workspace_id = ? AND status = 'active' AND body = ? LIMIT 1"),
		skillLog: database.prepare(
			"INSERT INTO skill_log (run_id, ts, session_id, workspace_id, trigger, decision, status, files, warnings) " +
				"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		),
		skillPrune: database.prepare("DELETE FROM skill_log WHERE ts < ?"),
		skillFtsOrphans: database.prepare(
			"SELECT f.rowid AS rid FROM skills_fts f LEFT JOIN skills m ON m.workspace_id = f.workspace_id AND m.id = f.id WHERE m.id IS NULL",
		),
		skillFtsDrop: database.prepare("DELETE FROM skills_fts WHERE rowid = ?"),
		skillActiveRows: database.prepare("SELECT * FROM skills WHERE status = 'active'"),
		skillQuarantine: database.prepare("UPDATE skills SET status = 'quarantined' WHERE workspace_id = ? AND id = ?"),
		skillWorkspaces: database.prepare(
			"SELECT workspace_id, COUNT(*) AS n, MAX(updated_at) AS u FROM skills WHERE status = 'active' GROUP BY workspace_id ORDER BY u DESC",
		),
		skillUseGet: database.prepare(
			"SELECT use_count, last_used_at FROM skill_usage WHERE workspace_id = ? AND skill_id = ? AND scope = ?",
		),
		skillUseUpsert: database.prepare(
			"INSERT INTO skill_usage (workspace_id, skill_id, scope, use_count, last_used_at) VALUES (?, ?, ?, 1, ?) " +
				"ON CONFLICT (workspace_id, skill_id, scope) DO UPDATE SET use_count = use_count + 1, last_used_at = excluded.last_used_at",
		),
		memUseGet: database.prepare(
			"SELECT use_count, last_used_at FROM memory_usage WHERE workspace_id = ? AND memory_id = ?",
		),
		memUseUpsert: database.prepare(
			"INSERT INTO memory_usage (workspace_id, memory_id, use_count, last_used_at) VALUES (?, ?, 1, ?) " +
				"ON CONFLICT (workspace_id, memory_id) DO UPDATE SET use_count = use_count + 1, last_used_at = excluded.last_used_at",
		),
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
		dailyGet: database.prepare("SELECT * FROM review_daily WHERE day = ?"),
		dailyUpsert: database.prepare(
			"INSERT INTO review_daily (day, budget, reviewed, new_items, requeued, approved, applied, cheap_token, evolve_token, backlog, dropped, skip_top, skip_counts) " +
				"VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, NULL) " +
				"ON CONFLICT (day) DO UPDATE SET budget = excluded.budget",
		),
		dailyConsume: database.prepare(
			"UPDATE review_daily SET reviewed = reviewed + 1 WHERE day = ? AND reviewed < budget",
		),
		dailyMerge: database.prepare(
			"UPDATE review_daily SET new_items = new_items + ?, requeued = requeued + ?, " +
				"approved = approved + ?, applied = applied + ?, cheap_token = cheap_token + ?, evolve_token = evolve_token + ?, " +
				"backlog = ?, dropped = dropped + ?, skip_top = ?, skip_counts = ? WHERE day = ?",
		),
	};

	// LIKE fallback: one OR-triplet per token, every token required. Statements
	// are cached by token count — the query set repeats, the counts don't grow.
	const likeStmts = new Map<number, ReturnType<DatabaseSync["prepare"]>>();
	const likeSearch = (workspaceId: string, tokens: readonly string[], limit: number): MemoryRecord[] => {
		let stmt = likeStmts.get(tokens.length);
		if (stmt === undefined) {
			const clause = tokens
				.map(() => "(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')")
				.join(" AND ");
			stmt = database.prepare(
				`SELECT * FROM memories WHERE workspace_id = ? AND status = 'active' AND ${clause} ${LIST_ORDER} LIMIT ?`,
			);
			likeStmts.set(tokens.length, stmt);
		}
		const patterns = tokens.flatMap((token) => {
			const pattern = likePattern(token);
			return [pattern, pattern, pattern];
		});
		return (stmt.all(workspaceId, ...patterns, limit) as unknown as MemoryRow[]).map(recordOf);
	};

	/**
	 * Fold a repeat of the previous row's mechanical skip into that row: the
	 * quiet turns of one session are one cursor position, so they are one
	 * ledger row carrying how many wake-ups it stands for. Only a
	 * *consecutive* repeat coalesces — anything in between (a model decision,
	 * an applied batch, a different reason, another session) starts a new row,
	 * which is exactly what "the same cursor position" means here. The bumped
	 * row takes the newest `ts`, so recency queries still see the session as
	 * active.
	 */
	const coalesceSkip = (entry: LedgerEntry): boolean => {
		if (entry.status !== "skipped" || entry.skipReason === undefined || !COALESCED_SKIP_REASONS.has(entry.skipReason)) {
			return false;
		}
		const latest = stmts.latestSkip.get(entry.workspaceId ?? null, entry.sessionId ?? null) as
			| { rid: number; reason: string | null; status: string | null }
			| undefined;
		if (latest === undefined || latest.status !== "skipped" || latest.reason !== entry.skipReason) {
			return false;
		}
		stmts.bumpSkip.run(new Date().toISOString(), latest.rid);
		return true;
	};

	// Skill LIKE fallback mirrors the memory one: one OR-triplet per token,
	// every token required, statements cached by token count.
	const skillLikeStmts = new Map<number, ReturnType<DatabaseSync["prepare"]>>();
	const skillLikeSearch = (workspaceId: string, tokens: readonly string[], limit: number): SkillRecord[] => {
		let stmt = skillLikeStmts.get(tokens.length);
		if (stmt === undefined) {
			const clause = tokens
				.map(() => "(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')")
				.join(" AND ");
			stmt = database.prepare(
				`SELECT * FROM skills WHERE workspace_id = ? AND status = 'active' AND ${clause} ORDER BY updated_at DESC LIMIT ?`,
			);
			skillLikeStmts.set(tokens.length, stmt);
		}
		const patterns = tokens.flatMap((token) => {
			const pattern = likePattern(token);
			return [pattern, pattern, pattern];
		});
		return (stmt.all(workspaceId, ...patterns, limit) as unknown as SkillRow[]).map(skillRecordOf);
	};

	/** Re-sync the FTS row for one skill id from its table row (delete + insert). */
	const skillFtsSync = (workspaceId: string, id: string): void => {
		database.prepare("DELETE FROM skills_fts WHERE rowid IN (SELECT rowid FROM skills_fts WHERE workspace_id = ? AND id = ?)").run(workspaceId, id);
		database.prepare(
			"INSERT INTO skills_fts (workspace_id, id, title, description, body) SELECT workspace_id, id, title, description, body FROM skills WHERE workspace_id = ? AND id = ?",
		).run(workspaceId, id);
	};

	interface SkillLedgerFile {
		id: string;
		action: SkillProposal["action"];
		scope: string;
		before?: SkillRecord;
		after?: SkillRecord;
		sourceSeqs?: string | undefined;
	}

	const writeSkillLedger = (
		entry: { runId: string | undefined; sessionId: string | undefined; workspaceId: string | undefined; trigger: ProposalContext["trigger"]; decision: string | undefined; status: string | undefined; files: unknown; warnings: unknown },
	): void => {
		stmts.skillLog.run(
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
	};

	/** The proposal id, derived from the title (slug, CJK-hash fallback) on create. */
	const skillIdFor = (proposal: SkillProposal): string => {
		if (proposal.id !== undefined && proposal.id.trim().length > 0) {
			return proposal.id.trim();
		}
		if (proposal.action === "create" && typeof proposal.title === "string") {
			return slugifySkillId(proposal.title);
		}
		return "";
	};

	/** The scope update/delete targets (`global` only when asked for). */
	const skillScopeOf = (proposal: SkillProposal): string | { reason: string } => {
		if (proposal.scope !== undefined && proposal.scope !== "project" && proposal.scope !== "global") {
			return { reason: `scope must be "project" or "global", got "${proposal.scope}"` };
		}
		return proposal.scope ?? "project";
	};

	/** The partition a scope names: global rows live in `""`, project rows in the context workspace. */
	const skillPartitionOf = (ctx: ProposalContext, scope: string): string => (scope === "global" ? "" : ctx.workspaceId);

	interface SkillFileIntent {
		partition: string;
		id: string;
		op: "write" | "remove";
	}

	const skillFail = (proposal: SkillProposal, reason: string): SkillProposalOutcome => ({
		id: proposal.id ?? "",
		action: proposal.action as SkillProposalOutcome["action"],
		ok: false,
		reason,
	});

	/** The merged field values a skill create/update would write. */
	const mergedSkillFields = (
		proposal: SkillProposal,
		existing: SkillRecord | undefined,
		action: "create" | "update",
	): { fields: SkillFields } | { reason: string } => {
		const pick = (value: string | undefined, fallback: string): string => (typeof value === "string" ? value : fallback);
		if (action === "create") {
			if (typeof proposal.title !== "string" || typeof proposal.description !== "string" || typeof proposal.body !== "string") {
				return { reason: "create requires id?, title, description, body" };
			}
			return { fields: { title: proposal.title, description: proposal.description, body: proposal.body } };
		}
		if (existing === undefined) {
			return { reason: "no skill to merge into" };
		}
		return {
			fields: {
				title: pick(proposal.title, existing.title),
				description: pick(proposal.description, existing.description),
				body: pick(proposal.body, existing.body),
			},
		};
	};

	const identicalSkill = (a: SkillRecord, fields: SkillFields): boolean =>
		a.title === fields.title && a.description === fields.description && a.body === fields.body;

	/** Validate one skill proposal and land it; file work happens post-commit via intents. */
	const applySkillOne = (
		ctx: ProposalContext,
		proposal: SkillProposal,
		now: string,
		files: SkillLedgerFile[],
		intents: SkillFileIntent[],
	): SkillProposalOutcome => {
		const action = proposal.action;
		if (action !== "create" && action !== "update" && action !== "delete" && action !== "move-to-global") {
			return skillFail(proposal, `unknown action ${String(action)}`);
		}
		const id = skillIdFor(proposal);
		if (!isValidMemoryId(id)) {
			return skillFail(proposal, id.length === 0 ? "id missing and cannot be derived from the title" : `malformed id "${id}"`);
		}

		if (action === "create") {
			if (ctx.workspaceId === "") {
				return skillFail(proposal, "skills are created in a project — move one to global explicitly afterwards");
			}
			const merged = mergedSkillFields(proposal, undefined, "create");
			if ("reason" in merged) {
				return skillFail(proposal, merged.reason);
			}
			const reasons = skillFieldGateReasons(merged.fields);
			if (reasons.length > 0) {
				return skillFail(proposal, reasons[0] ?? "invalid skill");
			}
			const projectRow = stmts.skillGet.get(ctx.workspaceId, id) as SkillRow | undefined;
			if (projectRow !== undefined && projectRow.status !== "archived") {
				return skillFail(proposal, `skill "${id}" already exists in this project — update it instead of creating a duplicate`);
			}
			const globalRow = stmts.skillGet.get("", id) as SkillRow | undefined;
			if (globalRow !== undefined && globalRow.status !== "archived") {
				const global = skillRecordOf(globalRow);
				if (identicalSkill(global, merged.fields)) {
					return skillFail(proposal, `identical global skill "${id}" already exists — call it directly, nothing to create`);
				}
				return skillFail(proposal, `global skill "${id}" exists with different content — rename yours, or delete the global row first`);
			}
			const sameBody = stmts.skillSameBody.get(ctx.workspaceId, merged.fields.body) as { id: string } | undefined;
			if (sameBody !== undefined && sameBody.id !== id) {
				return skillFail(proposal, `identical skill "${sameBody.id}" already exists in this project — reuse it instead of duplicating`);
			}
			const sameGlobalBody = stmts.skillSameBody.get("", merged.fields.body) as { id: string } | undefined;
			if (sameGlobalBody !== undefined) {
				return skillFail(proposal, `identical global skill "${sameGlobalBody.id}" already exists — call it directly instead of duplicating`);
			}
			stmts.skillInsert.run(
				ctx.workspaceId, id, merged.fields.title, merged.fields.description, merged.fields.body,
				ctx.sessionId ?? null, proposal.sourceSeqs ?? null, ctx.runId ?? (ctx.trigger === "explicit" ? "explicit" : null), now, now,
			);
			skillFtsSync(ctx.workspaceId, id);
			files.push({ id, action, scope: "project", after: skillRecordOf(stmts.skillGet.get(ctx.workspaceId, id) as unknown as SkillRow), sourceSeqs: proposal.sourceSeqs });
			intents.push({ partition: ctx.workspaceId, id, op: "write" });
			return { id, action, ok: true };
		}

		if (action === "move-to-global") {
			const projectRow = stmts.skillGet.get(ctx.workspaceId, id) as SkillRow | undefined;
			if (projectRow === undefined || projectRow.status === "archived") {
				return skillFail(proposal, `no project skill "${id}" to move — create it in the project first`);
			}
			const project = skillRecordOf(projectRow);
			if (project.status !== "active") {
				return skillFail(proposal, `project skill "${id}" is ${project.status} — only active skills move to global`);
			}
			const globalRow = stmts.skillGet.get("", id) as SkillRow | undefined;
			if (globalRow !== undefined && globalRow.status !== "archived") {
				return skillFail(proposal, `global skill "${id}" already exists — delete it first, or keep the project copy shadowing it`);
			}
			const reasons = skillFieldGateReasons({ title: project.title, description: project.description, body: project.body });
			if (reasons.length > 0) {
				return skillFail(proposal, reasons[0] ?? "invalid skill");
			}
			stmts.skillInsert.run(
				"", id, project.title, project.description, project.body,
				project.sourceSession, project.sourceSeqs, ctx.runId ?? (ctx.trigger === "explicit" ? "explicit" : null), now, now,
			);
			skillFtsSync("", id);
			stmts.skillArchive.run(now, ctx.workspaceId, id);
			skillFtsSync(ctx.workspaceId, id);
			files.push({ id, action, scope: "project", before: project });
			files.push({ id, action, scope: "global", after: skillRecordOf(stmts.skillGet.get("", id) as unknown as SkillRow) });
			intents.push({ partition: "", id, op: "write" });
			intents.push({ partition: ctx.workspaceId, id, op: "remove" });
			return { id, action, ok: true };
		}

		const scope = skillScopeOf(proposal);
		if (typeof scope !== "string") {
			return skillFail(proposal, scope.reason);
		}
		const partition = skillPartitionOf(ctx, scope);
		const existingRow = stmts.skillGet.get(partition, id) as SkillRow | undefined;
		const existing = existingRow === undefined || existingRow.status === "archived" ? undefined : skillRecordOf(existingRow);

		if (action === "delete") {
			if (existing === undefined) {
				return skillFail(proposal, `no ${scope} skill "${id}" to delete`);
			}
			stmts.skillDelete.run(partition, id);
			skillFtsSync(partition, id);
			files.push({ id, action, scope, before: existing });
			intents.push({ partition, id, op: "remove" });
			return { id, action, ok: true };
		}
		// action === "update"
		if (existing === undefined) {
			return skillFail(proposal, `no ${scope} skill "${id}" to update — create it in the project instead`);
		}
		const merged = mergedSkillFields(proposal, existing, "update");
		if ("reason" in merged) {
			return skillFail(proposal, merged.reason);
		}
		const reasons = skillFieldGateReasons(merged.fields);
		if (reasons.length > 0) {
			return skillFail(proposal, reasons[0] ?? "invalid skill");
		}
		stmts.skillUpdate.run(merged.fields.title, merged.fields.description, merged.fields.body, now, partition, id);
		skillFtsSync(partition, id);
		files.push({ id, action, scope, before: existing, after: skillRecordOf(stmts.skillGet.get(partition, id) as unknown as SkillRow) });
		intents.push({ partition, id, op: "write" });
		return { id, action, ok: true };
	};

	/**
	 * Bring every managed SKILL.md back in line with the store: rewrite
	 * missing or drifted files, drop orphan managed files. Only files
	 * carrying the generated marker are ever written or removed.
	 */
	const reconcileSkillFiles = (result: PatrolResult): void => {
		const active = stmts.skillActiveRows.all() as unknown as SkillRow[];
		for (const row of active) {
			const record = skillRecordOf(row);
			const root = skillRootOf(record.workspaceId);
			let current: string | undefined;
			try {
				current = readSkillFile(root, record.id);
			} catch {
				current = undefined;
			}
			if (current === renderSkillMarkdown(record)) {
				continue;
			}
			try {
				const problems = writeSkillFile(root, record);
				if (problems.length === 0) {
					result.skillFilesReconciled += 1;
				} else {
					result.skillFileErrors += 1;
				}
			} catch {
				result.skillFileErrors += 1;
			}
		}
		const roots = new Map<string, string>();
		for (const row of active) {
			roots.set(skillRootOf(row.workspace_id), row.workspace_id);
		}
		roots.set(skillRootOf(""), "");
		for (const [root, partition] of roots) {
			let names: string[];
			try {
				names = readdirSync(root, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name);
			} catch {
				continue;
			}
			for (const name of names) {
				let content: string;
				try {
					content = readFileSync(join(root, name, "SKILL.md"), "utf8");
				} catch {
					continue;
				}
				if (!content.includes(SKILL_GENERATED_MARKER)) {
					continue;
				}
				const row = stmts.skillGet.get(partition, name) as SkillRow | undefined;
				if (row !== undefined && row.status === "active") {
					continue;
				}
				try {
					rmSync(join(root, name), { recursive: true, force: true });
					result.skillOrphanFilesRemoved += 1;
				} catch {
					result.skillFileErrors += 1;
				}
			}
		}
	};

	const store: MemoryStore = {
		path,
		get(workspaceId, id) {
			const row = stmts.get.get(workspaceId, id) as MemoryRow | undefined;
			return row === undefined ? undefined : recordOf(row);
		},
		list(workspaceId) {
			return (stmts.list.all(workspaceId) as unknown as MemoryRow[]).map(recordOf);
		},
		listAll(workspaceId) {
			return (stmts.listAll.all(workspaceId) as unknown as MemoryRow[]).map(recordOf);
		},
		search(workspaceId, query, limit = 20) {
			const tokens = queryTokens(query);
			if (tokens.length === 0) {
				return [];
			}
			if (tokens.every((token) => token.length >= 3)) {
				const hits = stmts.fts.all(tokens.map(ftsPhrase).join(" AND "), workspaceId, limit) as unknown as MemoryRow[];
				if (hits.length > 0) {
					return hits.map(recordOf);
				}
			}
			return likeSearch(workspaceId, tokens, limit);
		},
		applyProposals(ctx, proposals) {
			return applyProposals({ database, now: () => new Date().toISOString() }, ctx, proposals).outcomes;
		},
		logSkipped(entry) {
			if (coalesceSkip(entry)) {
				return;
			}
			writeLedger(stmts.ledger, entry);
		},
		cursor(workspaceId, sessionId) {
			const row = stmts.cursorGet.get(workspaceId, CURSOR_KEY_PREFIX + sessionId) as
				| { seq: number | null }
				| undefined;
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
			return (stmts.workspaces.all() as { workspace_id: string; n: number; u: string }[]).map((row) => ({
				workspaceId: row.workspace_id,
				activeCount: row.n,
				updatedAt: row.u,
			}));
		},
		mostRecentlyActiveWorkspace() {
			// All instants are ISO-8601 UTC, so the newer one is the greater
			// string; comparing them keeps the three sources one ordering.
			const rows = [stmts.recentLedger.get(), stmts.recentMemory.get(), stmts.recentSkill.get()] as (
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
			const result: PatrolResult = {
				ts: new Date().toISOString(),
				orphanFtsRows: 0,
				quarantined: [],
				skillOrphanFtsRows: 0,
				skillQuarantined: [],
				skillFilesReconciled: 0,
				skillOrphanFilesRemoved: 0,
				skillFileErrors: 0,
			};
			for (const row of stmts.ftsOrphans.all() as { rid: number }[]) {
				stmts.ftsDrop.run(row.rid);
				result.orphanFtsRows += 1;
			}
			for (const row of stmts.activeRows.all() as unknown as MemoryRow[]) {
				const reason = secretLeakReason(`${row.title}\n${row.description}\n${row.body}`);
				if (reason !== undefined) {
					stmts.quarantine.run(row.workspace_id, row.id);
					result.quarantined.push({ workspaceId: row.workspace_id, id: row.id, reason });
				}
			}
			for (const row of stmts.skillFtsOrphans.all() as { rid: number }[]) {
				stmts.skillFtsDrop.run(row.rid);
				result.skillOrphanFtsRows += 1;
			}
			for (const row of stmts.skillActiveRows.all() as unknown as SkillRow[]) {
				const reason = secretLeakReason(`${row.title}\n${row.description}\n${row.body}`);
				if (reason !== undefined) {
					stmts.skillQuarantine.run(row.workspace_id, row.id);
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
			reconcileSkillFiles(result);
			stmts.stateSet.run(GLOBAL_WORKSPACE, PATROL_STATE_KEY, JSON.stringify(result));
			return result;
		},
		pruneLedger(beforeIso) {
			const memory = Number(stmts.prune.run(beforeIso).changes);
			const skills = Number(stmts.skillPrune.run(beforeIso).changes);
			const reviews = Number(stmts.reviewPrune.run(beforeIso).changes);
			return memory + skills + reviews;
		},
		close() {
			database.close();
		},
		getSkill(workspaceId, id) {
			const row = stmts.skillGet.get(workspaceId, id) as SkillRow | undefined;
			return row === undefined ? undefined : skillRecordOf(row);
		},
		listSkills(workspaceId) {
			return (stmts.skillList.all(workspaceId) as unknown as SkillRow[]).map(skillRecordOf);
		},
		listAllSkills(workspaceId) {
			return (stmts.skillListAll.all(workspaceId) as unknown as SkillRow[]).map(skillRecordOf);
		},
		searchSkills(workspaceId, query, limit = 20) {
			const tokens = queryTokens(query);
			if (tokens.length === 0) {
				return [];
			}
			if (tokens.every((token) => token.length >= 3)) {
				const hits = stmts.skillFts.all(tokens.map(ftsPhrase).join(" AND "), workspaceId, limit) as unknown as SkillRow[];
				if (hits.length > 0) {
					return hits.map(skillRecordOf);
				}
			}
			return skillLikeSearch(workspaceId, tokens, limit);
		},
		applySkillProposals(ctx, proposals) {
			const outcomes: SkillProposalOutcome[] = [];
			const files: SkillLedgerFile[] = [];
			const intents: SkillFileIntent[] = [];
			const runId = ctx.runId ?? (ctx.trigger === "explicit" ? "explicit" : undefined);
			const now = new Date().toISOString();
			database.exec("BEGIN");
			for (const proposal of proposals) {
				const outcome = applySkillOne(ctx, proposal, now, files, intents);
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
					const row = stmts.skillGet.get(intent.partition, intent.id) as SkillRow | undefined;
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
			writeSkillLedger({
				runId, sessionId: ctx.sessionId, workspaceId: ctx.workspaceId, trigger: ctx.trigger,
				decision, status: applied ? "applied" : "rejected",
				files: applied ? files : [], warnings,
			});
			return { outcomes, warnings };
		},
		listSkillWorkspaces() {
			return (stmts.skillWorkspaces.all() as { workspace_id: string; n: number; u: string }[]).map((row) => ({
				workspaceId: row.workspace_id,
				activeCount: row.n,
				updatedAt: row.u,
			}));
		},
		recordSkillUse(workspaceId: string, skillId: string, scope: string) {
			try {
				stmts.skillUseUpsert.run(workspaceId, skillId, scope, new Date().toISOString());
			} catch {
				// Accounting never fails the read it rides on.
			}
		},
		getSkillUse(workspaceId: string, skillId: string, scope: string) {
			try {
				const row = stmts.skillUseGet.get(workspaceId, skillId, scope) as
					| { use_count: number; last_used_at: string | null }
					| undefined;
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
				stmts.memUseUpsert.run(workspaceId, memoryId, new Date().toISOString());
			} catch {
				// Accounting never fails the read it rides on.
			}
		},
		getMemoryUse(workspaceId: string, memoryId: string) {
			try {
				const row = stmts.memUseGet.get(workspaceId, memoryId) as
					| { use_count: number; last_used_at: string | null }
					| undefined;
				if (row === undefined) {
					return undefined;
				}
				return { useCount: row.use_count, lastUsedAt: row.last_used_at };
			} catch {
				return undefined;
			}
		},
		logReview(entry: ReviewLogEntry) {
			stmts.reviewLog.run(
				entry.runId ?? null,
				new Date().toISOString(),
				entry.workspaceId ?? null,
				entry.itemKind,
				entry.itemId,
				entry.verdict,
				entry.reason ?? null,
				entry.proposed === undefined ? null : JSON.stringify(entry.proposed),
				entry.model ?? null,
				entry.cheapUsage === undefined ? null : JSON.stringify(entry.cheapUsage),
				entry.evolveUsage === undefined ? null : JSON.stringify(entry.evolveUsage),
				entry.applied ?? 0,
				entry.evolveCount ?? 0,
			);
		},
		consumeReviewBudget(day: string, budget: number) {
			stmts.dailyUpsert.run(day, budget);
			const result = stmts.dailyConsume.run(day) as { changes?: unknown };
			if (Number(result.changes) === 0) {
				return -1;
			}
			const row = stmts.dailyGet.get(day) as { budget: number; reviewed: number } | undefined;
			if (row === undefined) {
				return -1;
			}
			return row.budget - row.reviewed;
		},
		getDaily(day: string) {
			const row = stmts.dailyGet.get(day) as
				| {
					day: string; budget: number; reviewed: number; new_items: number; requeued: number;
					approved: number; applied: number; cheap_token: number; evolve_token: number;
					backlog: number; dropped: number; skip_top: string | null;
				}
				| undefined;
			if (row === undefined) {
				return undefined;
			}
			return {
				day: row.day, budget: row.budget, reviewed: row.reviewed, newItems: row.new_items,
				requeued: row.requeued, approved: row.approved, applied: row.applied,
				cheapToken: row.cheap_token, evolveToken: row.evolve_token,
				backlog: row.backlog, dropped: row.dropped, skipTop: row.skip_top,
			};
		},
		mergeDaily(day: string, budget: number, delta: DailyDelta) {			stmts.dailyUpsert.run(day, budget);
			const row = stmts.dailyGet.get(day) as { skip_counts: string | null; skip_top: string | null; backlog: number };
			const counts: Record<string, number> = parseCounts(row.skip_counts);
			for (const reason of delta.skipReasons ?? []) {
				counts[reason] = (counts[reason] ?? 0) + 1;
			}
			const entries = Object.entries(counts)
				.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
				.slice(0, 3)
				.map(([reason]) => reason);
			stmts.dailyMerge.run(
				delta.newItems ?? 0, delta.requeued ?? 0, delta.approved ?? 0, delta.applied ?? 0,
				delta.cheapToken ?? 0, delta.evolveToken ?? 0,
				delta.backlog ?? row.backlog,
				delta.dropped ?? 0,
				entries.length > 0 ? JSON.stringify(entries) : row.skip_top,
				Object.keys(counts).length > 0 ? JSON.stringify(counts) : null,
				day,
			);
		},
		quarantine(workspaceId: string, kind: "memory" | "skill", id: string) {
			try {
				const result = (kind === "memory" ? stmts.quarantine : stmts.skillQuarantine).run(workspaceId, id) as {
					changes?: unknown;
				};
				return Number(result.changes) > 0;
			} catch {
				return false;
			}
		},
		reviewStateOf(workspaceId: string, kind: "memory" | "skill", id: string) {
			try {
				const last = stmts.reviewLast.get(workspaceId, kind, id) as
					| { ts: string | null }
					| undefined;
				if (last === undefined) {
					return undefined;
				}
				const evolved = stmts.reviewEvolved.get(workspaceId, kind, id) as { n: number };
				return { lastTs: last.ts, evolveCount: Number(evolved.n) };
			} catch {
				return undefined;
			}
		},
	};
	return store;
}

/**
 * Add the ledger's `occurrences` column to a store created before coalescing
 * existed. The DDL only covers fresh files, and the plugin is the sole writer
 * of an existing user database — the one migration the ledger needs.
 */
function ensureLedgerOccurrences(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('extraction_log')").all() as { name: string }[];
	if (columns.some((column) => column.name === LEDGER_OCCURRENCES)) {
		return;
	}
	database.exec(`ALTER TABLE extraction_log ADD COLUMN ${LEDGER_OCCURRENCES} INTEGER NOT NULL DEFAULT 1`);
}

/**
 * Add the memories `corrects` link column to a store created before the
 * correction-linking field existed. Same single-migration discipline as the
 * ledger occurrences column above.
 */
function ensureMemoriesCorrects(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('memories')").all() as { name: string }[];
	if (columns.some((column) => column.name === "corrects")) {
		return;
	}
	database.exec("ALTER TABLE memories ADD COLUMN corrects TEXT");
}

/**
 * Add the extraction ledger `cheap_usage` column to a store created before
 * the cheap pre-gate existed. Same single-migration discipline as the
 * columns above.
 */
function ensureExtractionCheapUsage(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('extraction_log')").all() as { name: string }[];
	if (columns.some((column) => column.name === "cheap_usage")) {
		return;
	}
	database.exec("ALTER TABLE extraction_log ADD COLUMN cheap_usage TEXT");
}

/**
 * Add the extraction ledger `cheap_error` column to a store created before
 * the failed-gate head was ledgered. Separate from the `cheap_usage`
 * migration above so a store that already carries that column still gains
 * this one. Same single-migration discipline as the columns above.
 */
function ensureExtractionCheapError(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('extraction_log')").all() as { name: string }[];
	if (columns.some((column) => column.name === "cheap_error")) {
		return;
	}
	database.exec("ALTER TABLE extraction_log ADD COLUMN cheap_error TEXT");
}

/**
 * Add the review ledger `proposed` column to a store created before trial
 * mode started keeping the rewrite it declined to land. Same single-migration
 * discipline as the columns above.
 */
function ensureReviewProposed(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('review_log')").all() as { name: string }[];
	if (columns.some((column) => column.name === "proposed")) {
		return;
	}
	database.exec("ALTER TABLE review_log ADD COLUMN proposed TEXT");
}

/**
 * Add the review ledger `model` column to a store created before verdict rows
 * recorded the model they ran on. Same single-migration discipline as the
 * columns above.
 */
function ensureReviewModel(database: DatabaseSync): void {
	const columns = database.prepare("SELECT name FROM pragma_table_info('review_log')").all() as { name: string }[];
	if (columns.some((column) => column.name === "model")) {
		return;
	}
	database.exec("ALTER TABLE review_log ADD COLUMN model TEXT");
}

/** Parse the daily skip-counts map; corrupt payloads degrade to empty. */
function parseCounts(raw: string | null): Record<string, number> {
	if (raw === null) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return {};
		}
		const counts: Record<string, number> = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value === "number" && Number.isFinite(value) && value > 0) {
				counts[key] = Math.floor(value);
			}
		}
		return counts;
	} catch {
		return {};
	}
}

/** JSON-encode the optional ledger fields and insert the row (never throws past a warn). */
function writeLedger(stmt: { run(...args: unknown[]): unknown }, entry: LedgerEntry): void {
	stmt.run(
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
