/**
 * The store's public shapes: every record, ledger, and account interface
 * plus the {@link MemoryStore} surface every consumer (tool, extraction,
 * card, injection) programs against. Implementation lives in
 * `./store.js` (assembly), `./data/*` ( SQL and accounts), and
 * `./services/skill-apply.js` (skill writes); this file carries no SQL.
 */
import type { MemoryProposal } from "./memory-rules.js";
import type { PromptProposal } from "./prompt-rules.js";
import type { SkillProposal } from "./skill-rules.js";
import type { ProposalContext, ProposalOutcome } from "./store-apply.js";

export type { MemoryProposal, ProposalContext, ProposalOutcome };

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
	/**
	 * Append one plugin-log line — the durable home for plugin diagnostics,
	 * because the host's logger has no exporter on a stock install.
	 */
	logPlugin(entry: PluginLogEntry): void;
	/** Ledger and log rows older than the cutoff, removed (the unbounded tables). */
	pruneLedger(beforeIso: string): number;
	close(): void;
	/** One active prompt supplement from a partition, undefined when absent. */
	getPrompt(workspaceId: string, id: string): PromptRecord | undefined;
	/** Active prompt supplements of one partition, newest first. */
	listPrompts(workspaceId: string): PromptRecord[];
	/** Every non-archived prompt supplement of one partition, newest first. */
	listAllPrompts(workspaceId: string): PromptRecord[];
	/**
	 * Keyword search over prompt supplements, workspace-scoped: same
	 * AND-combined trigram/LIKE discipline as memory search.
	 */
	searchPrompts(workspaceId: string, query: string, limit?: number): PromptRecord[];
	/**
	 * The sole prompt write gate: validate all proposals, apply atomically,
	 * ledger with before/after snapshots. Prompts project to no files.
	 */
	applyPromptProposals(ctx: ProposalContext, proposals: readonly PromptProposal[]): PromptProposalOutcome[];
	/** Partitions holding active prompt supplements. */
	listPromptWorkspaces(): WorkspaceSummary[];
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
	/**
	 * Record one real prompt consumption (a body served by id, never a list
	 * or search hit). Same heartbeat discipline as skill usage: accounting
	 * never fails the read it rides on.
	 */
	recordPromptUse(workspaceId: string, promptId: string): void;
	/** Aggregate usage for one prompt supplement, undefined when never consumed. */
	getPromptUse(workspaceId: string, promptId: string): SkillUse | undefined;
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
