/**
 * The review accounts: per-item verdicts (`review_log`), the daily hard-cap
 * rollup (`review_daily`), and soft-isolation (`quarantine`). One factory
 * takes the prepared statements plus the two repositories and returns the
 * six {@link MemoryStore} methods, so the store assembly stays a thin
 * spread.
 */
import type { StatementSync } from "node:sqlite";
import type { DailyDelta, DailyStats, MemoryStore, ReviewLogEntry } from "../store-types.js";
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

/** The prepared statements the review accounts run on. */
export interface ReviewAccountStmts {
	reviewLog: StatementSync;
	reviewLast: StatementSync;
	reviewEvolved: StatementSync;
	dailyGet: StatementSync;
	dailyUpsert: StatementSync;
	dailyConsume: StatementSync;
	dailyMerge: StatementSync;
}

type ReviewAccountMethods = Pick<
	MemoryStore,
	"logReview" | "consumeReviewBudget" | "getDaily" | "mergeDaily" | "quarantine" | "reviewStateOf"
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
						day: string;
						budget: number;
						reviewed: number;
						new_items: number;
						requeued: number;
						approved: number;
						applied: number;
						cheap_token: number;
						evolve_token: number;
						backlog: number;
						dropped: number;
						skip_top: string | null;
				  }
				| undefined;
			if (row === undefined) {
				return undefined;
			}
			const stats: DailyStats = {
				day: row.day,
				budget: row.budget,
				reviewed: row.reviewed,
				newItems: row.new_items,
				requeued: row.requeued,
				approved: row.approved,
				applied: row.applied,
				cheapToken: row.cheap_token,
				evolveToken: row.evolve_token,
				backlog: row.backlog,
				dropped: row.dropped,
				skipTop: row.skip_top,
			};
			return stats;
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
			stmts.dailyMerge.run(
				delta.newItems ?? 0,
				delta.requeued ?? 0,
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
