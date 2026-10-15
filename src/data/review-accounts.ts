/**
 * The review accounts: per-item verdicts (`review_log`), the daily hard-cap
 * rollup (`review_daily`), and soft-isolation (`quarantine`). One factory
 * takes the prepared statements plus the two repositories and returns the
 * six {@link MemoryStore} methods, so the store assembly stays a thin
 * spread.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { secretLeakReason } from "../services/memory-rules.js";
import type { DailyDelta, DailyStats, MemoryStore, PatrolResult, ReviewLogEntry } from "../store-types.js";
import type { MemoryRow, PromptRow, SkillRow } from "./records.js";
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
				"approved = approved + ?, applied = applied + ?, cheap_token = cheap_token + ?, evolve_token = evolve_token + ?, " +
				"backlog = ?, dropped = dropped + ?, skip_top = ?, skip_counts = ? WHERE day = ?",
		),
	};
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

type UsageMethods = Pick<
	MemoryStore,
	"recordSkillUse" | "getSkillUse" | "recordMemoryUse" | "getMemoryUse" | "recordPromptUse" | "getPromptUse"
>;

/**
 * Build the six usage-counter methods over the three repositories.
 * Presence heartbeat: a body served by id counts; accounting never fails
 * the read it rides on.
 * @param memories - The memories repository.
 * @param skills - The skills repository.
 * @param prompts - The prompts repository.
 * @returns The six store methods, spread into the assembled store.
 */
export function createUsageCounters(
	memories: Repository<MemoryRow>,
	skills: Repository<SkillRow>,
	prompts: Repository<PromptRow>,
): UsageMethods {
	return {
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
		recordPromptUse(workspaceId: string, promptId: string) {
			try {
				prompts.recordUsage(workspaceId, [promptId], new Date().toISOString());
			} catch {
				// Accounting never fails the read it rides on.
			}
		},
		getPromptUse(workspaceId: string, promptId: string) {
			try {
				const row = prompts.getUsage(workspaceId, [promptId]);
				if (row === undefined) {
					return undefined;
				}
				return { useCount: row.use_count, lastUsedAt: row.last_used_at };
			} catch {
				return undefined;
			}
		},
	};
}

/**
 * Run the secret screen over every active row of the three kinds and
 * quarantine what leaks. File side-effects stay with the caller: a
 * quarantined skill must stop loading immediately, so the caller drops
 * its managed file through the callback (hand-written files stay, with
 * an error counted so the residue stays visible).
 * @param memories - The memories repository.
 * @param skills - The skills repository.
 * @param prompts - The prompts repository.
 * @param result - The patrol result accumulating counts.
 * @param onSkillQuarantined - Drops one quarantined skill's managed file.
 */
export function quarantineSecrets(
	memories: Repository<MemoryRow>,
	skills: Repository<SkillRow>,
	prompts: Repository<PromptRow>,
	result: PatrolResult,
	onSkillQuarantined: (workspaceId: string, id: string) => void,
): void {
	for (const row of memories.activeRowList()) {
		const reason = secretLeakReason(`${row.title}\n${row.description}\n${row.body}`);
		if (reason !== undefined) {
			memories.quarantineRow(row.workspace_id, row.id);
			result.quarantined.push({ workspaceId: row.workspace_id, id: row.id, reason });
		}
	}
	for (const row of skills.activeRowList()) {
		const reason = secretLeakReason(`${row.title}\n${row.description}\n${row.body}`);
		if (reason !== undefined) {
			skills.quarantineRow(row.workspace_id, row.id);
			result.skillQuarantined.push({ workspaceId: row.workspace_id, id: row.id, reason });
			onSkillQuarantined(row.workspace_id, row.id);
		}
	}
	for (const row of prompts.activeRowList()) {
		const reason = secretLeakReason(`${row.title}\n${row.description}\n${row.body}`);
		if (reason !== undefined) {
			prompts.quarantineRow(row.workspace_id, row.id);
			result.promptQuarantined.push({ workspaceId: row.workspace_id, id: row.id, reason });
		}
	}
}
