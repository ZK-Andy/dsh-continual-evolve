/**
 * The store's public shapes: every ledger and account interface plus the
 * {@link MemoryStore} surface every consumer (tool, extraction, card,
 * injection) programs against. Record shapes live with their row twins in
 * `./data/records.js` (single home) and are re-exported here so existing
 * importers keep working. Implementation lives in `./store.js` (assembly),
 * `./data/*` ( SQL and accounts), and `./services/skill-apply.js` (skill
 * writes); this file carries no SQL.
 */
import type { MemoryProposal } from "./services/memory-rules.js";
import type { PromptProposal } from "./services/prompt-rules.js";
import type { SkillProposal } from "./services/skill-rules.js";
import type { ProposalContext, ProposalOutcome } from "./services/memory-apply.js";
import type { MemoryRecord, PromptRecord, SkillRecord } from "./data/records.js";
import type { ItemEventEntry, ReviewSettled } from "./data/item-events.js";
import type { DailyDelta, DailyStats, ReviewLogEntry } from "./data/review-accounts.js";

export type { MemoryProposal, ProposalContext, ProposalOutcome };
export type { MemoryRecord, PromptRecord, SkillRecord } from "./data/records.js";
/** The queue's event shapes live with the table they describe (`data/item-events.ts`). */
export { ITEM_EVENT_KINDS } from "./data/item-events.js";
export type { ItemEventEntry, ItemEventKind, ReviewSettled } from "./data/item-events.js";
/** The review accounts' shapes live with the tables they describe (`data/review-accounts.ts`); re-exported for importers. */
export type { DailyDelta, DailyStats, ReviewLogEntry } from "./data/review-accounts.js";

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
 *
 * `route-backoff` and `route-halted` join them: a wake-up the failure
 * discipline suppressed is the same decision repeated, and the counted row is
 * what keeps a day of backoff (or a halted route) from burying the account in
 * identical lines.
 */
export const COALESCED_SKIP_REASONS = new Set(["no-user-prose", "no-new-events", "route-backoff", "route-halted"]);

/**
 * The ledger's `skip_reason` when a run died on a route the provider refused
 * (`AUTH`/`NO_ADAPTER`/a capability fault): the track stops calling that route
 * until it changes, instead of paying for another refusal every turn.
 */
export const ROUTE_REJECTED_REASON = "route-rejected";

/** The ledger's `skip_reason` for a wake-up the route backoff suppressed. */
export const ROUTE_BACKOFF_REASON = "route-backoff";

/** The ledger's `skip_reason` for a wake-up suppressed because the route is halted. */
export const ROUTE_HALTED_REASON = "route-halted";

/** Longest message kept; a runaway error string must not become a table row. */
export const PLUGIN_LOG_MESSAGE_MAX = 2000;

/**
 * The extraction ledger's trigger whitelist: the values its `CHECK` accepts,
 * the type its rows carry, and the list the schema guard compares a live store
 * against. One home — the DDL text is generated from it (see
 * `./data/schema.js`), so a new trigger cannot land in one place only.
 */
export const LEDGER_TRIGGERS = [
	"turn-debounce",
	"compaction",
	"close-drain",
	"explicit",
	"import",
	"item-review",
] as const;

/** One extraction-ledger trigger. */
export type LedgerTrigger = (typeof LEDGER_TRIGGERS)[number];

/** The ledger column counting the wake-ups one coalesced row stands for. */
export const LEDGER_OCCURRENCES = "occurrences";


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
	trigger: LedgerTrigger;
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
	/** Every `state` row whose key starts with `prefix` (the retention sweep's reader). */
	listState(prefix: string): { workspaceId: string; key: string; value: string }[];
	/** Drop one `state` row (retention's sweep for self-describing records). */
	deleteState(workspaceId: string, key: string): void;
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
	/**
	 * Append linkage events, one row each. Called inside the caller's
	 * transaction so a landed row and the linkages it causes commit together.
	 */
	recordItemEvents(entries: readonly ItemEventEntry[]): void;
	/**
	 * The event tier of the review queue: items whose latest linkage event is
	 * newer than their latest complete verdict. One query per drain.
	 */
	reviewEventQueue(): { workspaceId: string; kind: "memory" | "skill"; id: string }[];
	/**
	 * Consecutive keeps since the last reset — a linkage event or any non-keep
	 * verdict. Derived from the verdict rows, never stored: two writers would
	 * drift, and pruning already resets it conservatively.
	 */
	reviewSettled(workspaceId: string, kind: "memory" | "skill", id: string): ReviewSettled;
}
