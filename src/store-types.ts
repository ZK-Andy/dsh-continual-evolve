/**
 * The store's shared shapes: every record, ledger, and account interface
 * plus the constants both sides use. The store surface itself lives in
 * `./store-facets.js` (one interface per capability domain, composed as
 * {@link MemoryStore}); implementation lives in `./store.js` (assembly),
 * `./data/*` (SQL and accounts), and `./services/skill-apply.js` (skill
 * writes); this file carries no SQL.
 */
import type { MemoryProposal } from "./services/memory-rules.js";
import type { SkillProposal } from "./services/skill-rules.js";
import type { ProposalContext, ProposalOutcome } from "./services/memory-apply.js";

export type { MemoryProposal, ProposalContext, ProposalOutcome };

/** Re-exported so existing importers keep working: the composed store surface (facets in `./store-facets.js`). */
export type { MemoryStore } from "./store-facets.js";

/** State-table keys owned by the store (partitioned per workspace, `""` = global). */
export const CURSOR_KEY_PREFIX = "seq:";
export const PATROL_STATE_KEY = "patrol:last";
export const MD_IMPORT_STATE_KEY = "md-imported";
/** Global partition id for workspace-independent state rows. */
export const GLOBAL_WORKSPACE = "";
/** Preview size cap for the card's content endpoint (ZCode's viewer uses 5 MiB). */
export const MEMORY_FILE_PREVIEW_LIMIT = 5 * 1024 * 1024;
/**
 * Skips a busy-but-quiet session repeats verbatim, turn after turn: the
 * ledger keeps one counted row instead of one row per wake-up. Fault-shaped
 * skips (`no-route`, `no-surface`, `no-workspace`) and every failure stay one
 * row per occurrence — a persistent fault deserves a timeline, not a counter.
 */
export const COALESCED_SKIP_REASONS = new Set(["no-user-prose", "no-new-events"]);

/** Longest message kept; a runaway error string must not become a table row. */
export const PLUGIN_LOG_MESSAGE_MAX = 2000;

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

/** One stored prompt supplement (workspace-scoped reusable prompt text). Prompts carry no type and no scope. */
export interface PromptRecord {
	workspaceId: string;
	id: string;
	title: string;
	description: string;
	body: string;
	status: "active" | "quarantined" | "archived";
	/** Origin session id, `null` for imports. */
	sourceSession: string | null;
	/** Trajectory seq range the supplement came from ("820-831"), `null` when unknown. */
	sourceSeqs: string | null;
	/** The run that wrote it; `'explicit'` for tool writes. */
	sourceRun: string | null;
	createdAt: string;
	updatedAt: string;
}

/** What a single prompt proposal produced. */
export interface PromptProposalOutcome {
	id: string;
	action: "create" | "update" | "delete";
	ok: boolean;
	/** Blocking reason when `ok` is false. */
	reason?: string;
}

/**
 * One mutation's audit payload, embedded in a ledger row's `files` JSON
 * (before/after snapshots for undo). Single definition — the three write
 * paths alias it with their own action/record types instead of redeclaring
 * the shape.
 */
export interface LedgerFile<Action extends string = string, Snapshot = unknown> {
	id: string;
	action: Action;
	/** Skill scope for skill rows; absent for memories and prompts. */
	scope?: string | undefined;
	before?: Snapshot | undefined;
	after?: Snapshot | undefined;
	sourceSeqs?: string | undefined;
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

/** One plugin-log line: the level, a stable event slug, and the message. */
export interface PluginLogEntry {
	level: "info" | "warn" | "error";
	/**
	 * The event's stable name (`drain-failed`, `card-no-webserver` …), so the
	 * table can be counted and grepped instead of read line by line.
	 */
	event: string;
	message: string;
	/** The partition the line belongs to, when the call site knows one. */
	workspaceId?: string | undefined;
	sessionId?: string | undefined;
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
	/** Orphan prompt FTS rows (no matching prompt) removed. */
	promptOrphanFtsRows: number;
	/** Prompts quarantined by the secret screen, with the redacted reasons. */
	promptQuarantined: { workspaceId: string; id: string; reason: string }[];
}
