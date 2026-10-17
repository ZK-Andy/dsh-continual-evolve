/**
 * The review accounts: per-item verdicts (`review_log`), the daily hard-cap
 * rollup (`review_daily`), and soft-isolation (`quarantine`). One factory
 * takes the prepared statements plus the two repositories and returns the
 * six {@link MemoryStore} methods, so the store assembly stays a thin
 * spread. The queue's event tier and its derived settled streak live in
 * `./item-events.js`; usage counters in `./usage-accounts.js`.
 *
 * The shapes below are this module's own (re-exported through `store-types`):
 * they describe the two tables the accounts read and write.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { MemoryStore } from "../store-types.js";
import type { MemoryRow, SkillRow } from "./records.js";
import type { Repository } from "./repository.js";

/**
 * Verdict rows that leave an item queued: a call that never produced a verdict
 * must not read as "reviewed". Without this a single gate fault (a route blip,
 * a budget cut) locked the item out for `staleDays`, because the failure row
 * counted as a finished review (2026-10-13).
 */
export const INCOMPLETE_REVIEW_SQL =
	"(coalesce(reason, '') LIKE 'gate-llm-failed%' OR coalesce(reason, '') LIKE 'evolve-llm-failed%' " +
	"OR coalesce(reason, '') IN ('no-route', 'budget-exhausted', 'gate-parse-failed', 'evolve-parse-failed'))";

/** One day of the hard-cap account (UTC `YYYY-MM-DD`, budget = 100). */
export interface DailyStats {
	day: string;
	budget: number;
	reviewed: number;
	newItems: number;
	/** Total requeues; always the sum of the three source counters below. */
	requeued: number;
	/** Requeued because a linkage event landed after its last verdict. */
	requeuedLink: number;
	/** Requeued because a calendar milestone came due (probation, promotion). */
	requeuedClock: number;
	/** Requeued because the stale sample drew it. */
	requeuedSampled: number;
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
	/** Requeues by source; the stored total is their sum, never a fourth input. */
	requeuedLink?: number | undefined;
	requeuedClock?: number | undefined;
	requeuedSampled?: number | undefined;
	approved?: number | undefined;
	applied?: number | undefined;
	cheapToken?: number | undefined;
	evolveToken?: number | undefined;
	/** Queue depth after the run (set, not added). */
	backlog?: number | undefined;
	dropped?: number | undefined;
	skipReasons?: string[] | undefined;
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

/** The prepared statements the review accounts run on. */
export interface ReviewAccountStmts {
	reviewLog: StatementSync;
	reviewLast: StatementSync;
	reviewEvolved: StatementSync;
	reviewPrune: StatementSync;
	dailyGet: StatementSync;
	dailyUpsert: StatementSync;
	dailyConsume: StatementSync;
	dailyMerge: StatementSync;
}

/**
 * Prepare every review-account statement up front.
 * @param database - The open database handle.
 * @returns The prepared review statement bundle.
 */
export function prepareReviewStmts(database: DatabaseSync): ReviewAccountStmts {
	return {
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
		dailyConsume: database.prepare("UPDATE review_daily SET reviewed = reviewed + 1 WHERE day = ? AND reviewed < budget"),
		dailyMerge: database.prepare(
			"UPDATE review_daily SET new_items = new_items + ?, requeued = requeued + ?, " +
				"requeued_link = requeued_link + ?, requeued_clock = requeued_clock + ?, requeued_sampled = requeued_sampled + ?, " +
				"approved = approved + ?, applied = applied + ?, cheap_token = cheap_token + ?, evolve_token = evolve_token + ?, " +
				"backlog = ?, dropped = dropped + ?, skip_top = ?, skip_counts = ? WHERE day = ?",
		),
	};
}

type ReviewAccountMethods = Pick<
	MemoryStore,
	| "logReview"
	| "consumeReviewBudget"
	| "getDaily"
	| "mergeDaily"
	| "quarantine"
	| "reviewStateOf"
>;

/**
 * Build the six review-account methods over shared statements and repos.
 * @param stmts - The prepared review/daily statements.
 * @param memories - The memories repository.
 * @param skills - The skills repository.
 * @returns The six store methods, spread into the assembled store.
 */
export function createReviewAccounts(
	stmts: ReviewAccountStmts,
	memories: Repository<MemoryRow>,
	skills: Repository<SkillRow>,
): ReviewAccountMethods {
	return {
		...buildReviewLogWriter(stmts),
		...buildDailyAccounts(stmts),
		...buildReviewState(stmts, memories, skills),
	};
}

/** The verdict-row writer. */
function buildReviewLogWriter(stmts: ReviewAccountStmts): Pick<ReviewAccountMethods, "logReview"> {
	return {
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
	};
}

/** The daily hard-cap rollup accounts. */
function buildDailyAccounts(stmts: ReviewAccountStmts): Pick<ReviewAccountMethods, "consumeReviewBudget" | "getDaily" | "mergeDaily"> {
	return {
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
			const row = stmts.dailyGet.get(day) as DailyRow | undefined;
			if (row === undefined) {
				return undefined;
			}
			return toDailyStats(row);
		},
		mergeDaily(day: string, budget: number, delta: DailyDelta) {
			stmts.dailyUpsert.run(day, budget);
			const row = stmts.dailyGet.get(day) as { skip_counts: string | null; skip_top: string | null; backlog: number };
			const counts: Record<string, number> = parseCounts(row.skip_counts);
			for (const reason of delta.skipReasons ?? []) {
				counts[reason] = (counts[reason] ?? 0) + 1;
			}
			const entries = Object.entries(counts)
				.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
				.slice(0, 3)
				.map(([reason]) => reason);
			// The total is derived here, never supplied: one writer for the
			// identity `requeued = link + clock + sampled` (rollout ADR §A4).
			const link = delta.requeuedLink ?? 0;
			const clock = delta.requeuedClock ?? 0;
			const sampled = delta.requeuedSampled ?? 0;
			stmts.dailyMerge.run(
				delta.newItems ?? 0,
				link + clock + sampled,
				link,
				clock,
				sampled,
				delta.approved ?? 0,
				delta.applied ?? 0,
				delta.cheapToken ?? 0,
				delta.evolveToken ?? 0,
				delta.backlog ?? row.backlog,
				delta.dropped ?? 0,
				entries.length > 0 ? JSON.stringify(entries) : row.skip_top,
				Object.keys(counts).length > 0 ? JSON.stringify(counts) : null,
				day,
			);
		},
	};
}

/** One daily rollup row as stored (snake_case, nullable skip_top). */
interface DailyRow {
	day: string;
	budget: number;
	reviewed: number;
	new_items: number;
	requeued: number;
	requeued_link: number;
	requeued_clock: number;
	requeued_sampled: number;
	approved: number;
	applied: number;
	cheap_token: number;
	evolve_token: number;
	backlog: number;
	dropped: number;
	skip_top: string | null;
}

/** Map a stored daily row to its public stats shape. */
function toDailyStats(row: DailyRow): DailyStats {
	return {
		day: row.day,
		budget: row.budget,
		reviewed: row.reviewed,
		newItems: row.new_items,
		requeued: row.requeued,
		requeuedLink: row.requeued_link,
		requeuedClock: row.requeued_clock,
		requeuedSampled: row.requeued_sampled,
		approved: row.approved,
		applied: row.applied,
		cheapToken: row.cheap_token,
		evolveToken: row.evolve_token,
		backlog: row.backlog,
		dropped: row.dropped,
		skipTop: row.skip_top,
	};
}

/** Per-item review state: quarantine writes and last-review reads. */
function buildReviewState(
	stmts: ReviewAccountStmts,
	memories: Repository<MemoryRow>,
	skills: Repository<SkillRow>,
): Pick<ReviewAccountMethods, "quarantine" | "reviewStateOf"> {
	return {
		quarantine(workspaceId: string, kind: "memory" | "skill", id: string) {
			try {
				if (kind === "memory") {
					return memories.quarantineRow(workspaceId, id);
				}
				return skills.quarantineRow(workspaceId, id);
			} catch {
				return false;
			}
		},
		reviewStateOf(workspaceId: string, kind: "memory" | "skill", id: string) {
			try {
				const last = stmts.reviewLast.get(workspaceId, kind, id) as { ts: string | null } | undefined;
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
