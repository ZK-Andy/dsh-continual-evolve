/**
 * The store's facet interfaces: one per capability domain, mirroring the six
 * builders in `./store.js` (memory / skill / prompt partitions, usage
 * heartbeat, review accounts, store admin). Consumers program against the
 * facet they need instead of the whole surface (ISP); {@link MemoryStore}
 * composes all six so the assembly and existing call sites keep one type.
 * Record shapes stay in `./store-types.js` — this file carries interfaces
 * only, no SQL, no values.
 */
import type { PromptProposal } from "./services/prompt-rules.js";
import type { SkillProposal } from "./services/skill-rules.js";
import type {
	DailyDelta,
	DailyStats,
	LedgerEntry,
	MemoryProposal,
	MemoryRecord,
	PatrolResult,
	PluginLogEntry,
	PromptProposalOutcome,
	PromptRecord,
	ProposalContext,
	ProposalOutcome,
	ReviewLogEntry,
	SkillFileWarning,
	SkillProposalOutcome,
	SkillRecord,
	SkillUse,
	WorkspaceSummary,
} from "./store-types.js";

/** One memory partition: reads, the sole write gate, cursors, state, catalogue. */
export interface MemoryPartition {
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
}

/** One skill partition: reads, the sole write gate, catalogue. */
export interface SkillPartition {
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
}

/** One prompt-supplement partition: reads, the sole write gate, catalogue. */
export interface PromptPartition {
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
}

/**
 * Presence heartbeat: one counter per body served by id (never a list or
 * search hit). Accounting never fails the read it rides on — failures
 * degrade silently.
 */
export interface UsageHeartbeat {
	/** Record one real skill consumption (a body served by id). */
	recordSkillUse(workspaceId: string, skillId: string, scope: string): void;
	/** Aggregate usage for one skill, undefined when never consumed. */
	getSkillUse(workspaceId: string, skillId: string, scope: string): SkillUse | undefined;
	/** Record one real memory consumption (a body served by id). */
	recordMemoryUse(workspaceId: string, memoryId: string): void;
	/** Aggregate usage for one memory, undefined when never consumed. */
	getMemoryUse(workspaceId: string, memoryId: string): SkillUse | undefined;
	/** Record one real prompt consumption (a body served by id). */
	recordPromptUse(workspaceId: string, promptId: string): void;
	/** Aggregate usage for one prompt supplement, undefined when never consumed. */
	getPromptUse(workspaceId: string, promptId: string): SkillUse | undefined;
}

/** The review loop's accounts: verdict rows, the daily budget, quarantine reads. */
export interface ReviewAccounts {
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

/** Cross-kind store admin: recency race, patrol, diagnostics, retention, close. */
export interface StoreAdmin {
	readonly path: string;
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
}

/**
 * The whole store surface every consumer historically programmed against:
 * all six facets composed. New code should depend on the narrowest facet;
 * the assembly in `./store.js` spreads the six builders over this type.
 */
export interface MemoryStore
	extends MemoryPartition,
		SkillPartition,
		PromptPartition,
		UsageHeartbeat,
		ReviewAccounts,
		StoreAdmin {}
