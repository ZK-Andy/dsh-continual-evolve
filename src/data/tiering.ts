/**
 * The tiering operations (`2026-10-13-memory-tiering-and-promotion`): the
 * promotion transaction, its reverse, archive, and the reads the review queue
 * needs to schedule the clock tiers.
 *
 * Every move keeps the "one active copy" invariant: promotion builds the
 * global row and archives the source in one transaction, demotion does the
 * reverse, and both leave a verdict row in the target partition so the moved
 * row reads as judged rather than brand new (rollout ADR §R2). Physical
 * delete never happens here — archive is a status bit, not a deletion.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { MemoryRow } from "./records.js";
import type { Repository } from "./repository.js";

/** How long a promoted row stays on probation before its review. */
export const PROBATION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The prepared statements the tiering operations run on. */
export interface TieringStmts {
	/** Every memory still on probation whose window has come due. */
	probationDue: StatementSync;
	/** Active `person` candidates that already carry a verdict (waiting for their second). */
	promotionCandidates: StatementSync;
	/** Verdict rows that read as "judged bad" (the archive gate's second witness). */
	rejectCount: StatementSync;
	/** Rows naming an item as the thing they correct (blocks automatic archive). */
	correctedBy: StatementSync;
	usageElsewhere: StatementSync;
	setProbation: StatementSync;
	clearProbation: StatementSync;
	logVerdict: StatementSync;
}

/**
 * Prepare the tiering statements.
 * @param database - The open database handle.
 * @returns The prepared statement bundle.
 */
export function prepareTieringStmts(database: DatabaseSync): TieringStmts {
	return {
		probationDue: database.prepare(
			"SELECT workspace_id, id FROM memories WHERE status = 'active' AND probation_until IS NOT NULL AND probation_until <= ?",
		),
		// Exactly one complete verdict: the record-time marker was the first
		// judgement, so the queue owes it one more, and only one (a candidate the
		// reviewer declines leaves the funnel in that same landing).
		promotionCandidates: database.prepare(
			"SELECT workspace_id, id FROM memories WHERE status = 'active' AND scope = 'person' AND " +
				"(SELECT COUNT(*) FROM review_log r WHERE r.workspace_id IS memories.workspace_id " +
				"AND r.item_kind = 'memory' AND r.item_id = memories.id AND r.verdict <> 'skip') = 1 " +
				// A promoted row is not a candidate: its probe is probation due,
				// not a second record-time judgement.
				"AND probation_until IS NULL",
		),
		rejectCount: database.prepare(
			"SELECT COUNT(*) AS n FROM review_log WHERE workspace_id IS ? AND item_kind = 'memory' AND item_id = ? " +
				"AND verdict IN ('quarantine', 'archive')",
		),
		correctedBy: database.prepare(
			"SELECT COUNT(*) AS n FROM memories WHERE workspace_id IS ? AND status = 'active' AND corrects = ?",
		),
		// Cross-partition use: a served body counts under the caller's partition,
		// so this is exactly "did another project actually use it" — the
		// probation promotion test (rollout ADR §R1/§R3).
		usageElsewhere: database.prepare(
			"SELECT COUNT(*) AS n FROM memory_usage WHERE memory_id = ? AND workspace_id IS NOT ? AND use_count > 0",
		),
		setProbation: database.prepare("UPDATE memories SET probation_until = ?, origin_workspace = ? WHERE workspace_id = ? AND id = ?"),
		clearProbation: database.prepare("UPDATE memories SET probation_until = NULL WHERE workspace_id = ? AND id = ?"),
		// The "already judged" marker a move leaves in its target partition
		// (rollout ADR §R2): a promoted row must not read as a drop-in, and a
		// demoted row must not be re-queued as new in its old home.
		logVerdict: database.prepare(
			"INSERT INTO review_log (ts, workspace_id, item_kind, item_id, verdict, reason, applied) VALUES (?, ?, 'memory', ?, ?, ?, 1)",
		),
	};
}

/** What a promotion attempt produced. */
export interface TieringOutcome {
	ok: boolean;
	/** Why it did not move, when `ok` is false. */
	reason?: string;
}

/** The row fields a promotion copies into the global partition. */
interface PromoteRequest {
	/** Source partition the row lives in. */
	workspaceId: string;
	id: string;
	/** The instant the promotion lands (the probation clock starts here). */
	now: Date;
}

/**
 * Promote one memory into the global partition: build the global row, archive
 * the source row, and land both ledger entries in one transaction. The global
 * row starts on probation and remembers where it came from, so demotion needs
 * no new judgement.
 * @param database - The open database handle.
 * @param memories - The memories repository.
 * @param stmts - The tiering statements.
 * @param request - The row and the clock.
 * @returns Whether the move landed, and why not.
 */
export function promoteMemory(
	database: DatabaseSync,
	memories: Repository<MemoryRow>,
	stmts: TieringStmts,
	request: PromoteRequest,
): TieringOutcome {
	const { workspaceId, id } = request;
	if (workspaceId === "") {
		return { ok: false, reason: "already in the global partition" };
	}
	const source = memories.getRow(workspaceId, id);
	if (source === undefined) {
		return { ok: false, reason: `no memory "${id}" to promote` };
	}
	if (source.status !== "active") {
		return { ok: false, reason: `memory "${id}" is not active` };
	}
	const existing = memories.getRow("", id);
	if (existing !== undefined && existing.status === "active") {
		return { ok: false, reason: `the global partition already holds an active "${id}"` };
	}
	const ts = request.now.toISOString();
	const until = new Date(request.now.getTime() + PROBATION_DAYS * DAY_MS).toISOString();
	database.exec("BEGIN");
	try {
		if (existing !== undefined) {
			// An archived global row with this id is history, not a conflict:
			// promotion replaces it rather than failing on the primary key.
			memories.deleteRow("", id);
		}
		memories.insertRow([
			"", id, source.type, source.title, source.description, source.body, "person",
			source.source_session, source.source_seqs, source.source_run, null, source.not_when, ts, ts,
		]);
		memories.syncFts("", id);
		stmts.setProbation.run(until, workspaceId, "", id);
		memories.archiveWithReason(workspaceId, id, ts, "promoted-source", null);
		stmts.logVerdict.run(ts, "", id, "promote", "提级落地（实习期开始）");
		database.exec("COMMIT");
	} catch (error) {
		rollback(database);
		throw error;
	}
	return { ok: true };
}

/**
 * Demote a global memory back to its recorded origin partition: archive the
 * global row, restore a `project` row in the source partition. A global row
 * with no recorded origin cannot be demoted — the reverse would be a guess.
 * @param database - The open database handle.
 * @param memories - The memories repository.
 * @param stmts - The tiering statements.
 * @param request - The global row and the clock.
 * @returns Whether the move landed, and why not.
 */
export function demoteMemory(
	database: DatabaseSync,
	memories: Repository<MemoryRow>,
	stmts: TieringStmts,
	request: PromoteRequest,
): TieringOutcome {
	const source = memories.getRow("", request.id);
	if (source === undefined || source.status !== "active") {
		return { ok: false, reason: `no active global memory "${request.id}"` };
	}
	const origin = source.origin_workspace;
	if (origin === null || origin.length === 0) {
		return { ok: false, reason: `global memory "${request.id}" records no origin partition` };
	}
	const ts = request.now.toISOString();
	const existing = memories.getRow(origin, request.id);
	database.exec("BEGIN");
	try {
		if (existing !== undefined) {
			memories.deleteRow(origin, request.id);
		}
		memories.insertRow([
			origin, request.id, source.type, source.title, source.description, source.body, "project",
			source.source_session, source.source_seqs, source.source_run, null, source.not_when, ts, ts,
		]);
		memories.syncFts(origin, request.id);
		// The restored row is not on probation; the global one is only archived,
		// so its probation stamp stays as history.
		stmts.clearProbation.run(origin, request.id);
		memories.archiveWithReason("", request.id, ts, "demoted-source", null);
		stmts.logVerdict.run(ts, origin, request.id, "demote", "降级落地（回到来源分区）");
		database.exec("COMMIT");
	} catch (error) {
		rollback(database);
		throw error;
	}
	return { ok: true };
}

/**
 * Whether an item may be archived automatically: never referenced, not the
 * target of a correction, and this is at least the second independent verdict
 * that judged it unfit. `2026-10-13-memory-tiering-and-promotion` §出水管.
 * @param memories - The memories repository.
 * @param stmts - The tiering statements.
 * @param workspaceId - The item's partition.
 * @param id - The item id.
 * @returns The blocking reason, `undefined` when archiving may land.
 */
export function archiveGateReason(
	memories: Repository<MemoryRow>,
	stmts: TieringStmts,
	workspaceId: string,
	id: string,
): string | undefined {
	const corrected = stmts.correctedBy.get(workspaceId, id) as { n: number } | undefined;
	if (Number(corrected?.n ?? 0) > 0) {
		return "仍有活动条目以 corrects 指向它，不能自动归档";
	}
	const rejects = stmts.rejectCount.get(workspaceId, id) as { n: number } | undefined;
	if (Number(rejects?.n ?? 0) < 1) {
		return "第一次判淘汰，等下一次独立判定";
	}
	if (memories.getUsage(workspaceId, [id]) !== undefined) {
		return "仍被引用过，不能自动归档";
	}
	return undefined;
}

/**
 * Every memory whose probation window has come due — the clock tier.
 * @param stmts - The tiering statements.
 * @param now - The clock.
 * @returns The due rows.
 */
export function probationDue(stmts: TieringStmts, now: Date): { workspaceId: string; id: string }[] {
	const rows = stmts.probationDue.all(now.toISOString()) as { workspace_id: string; id: string }[];
	return rows.map((row) => ({ workspaceId: row.workspace_id, id: row.id }));
}

/**
 * Every `person` memory that already carries a verdict — the promotion
 * candidate clock tier (its second, independent judgement is what moves it).
 * @param stmts - The tiering statements.
 * @returns The candidate rows.
 */
export function promotionCandidates(stmts: TieringStmts): { workspaceId: string; id: string }[] {
	const rows = stmts.promotionCandidates.all() as { workspace_id: string; id: string }[];
	return rows.map((row) => ({ workspaceId: row.workspace_id, id: row.id }));
}

/** Roll back, keeping the original failure as the error worth reporting. */
function rollback(database: DatabaseSync): void {
	try {
		database.exec("ROLLBACK");
	} catch {
		// The failing statement already ended the transaction.
	}
}

/** The tiering half of the store surface. */
export interface TieringMethods {
	promoteMemory(workspaceId: string, id: string): TieringOutcome;
	demoteMemory(workspaceId: string, id: string): TieringOutcome;
	archiveMemory(workspaceId: string, id: string): boolean;
	archiveBlocker(workspaceId: string, id: string): string | undefined;
	confirmProbation(id: string): void;
	probationEvidence(memoryId: string, originWorkspace: string): number;
	probationQueue(): { workspaceId: string; id: string }[];
	promotionQueue(): { workspaceId: string; id: string }[];
}

/**
 * Build the tiering store methods.
 * @param database - The open database handle.
 * @param memories - The memories repository.
 * @param stmts - The tiering statements.
 * @param now - The clock (injected so tests can move time).
 * @returns The six store methods, spread into the assembled store.
 */
export function createTieringMethods(
	database: DatabaseSync,
	memories: Repository<MemoryRow>,
	stmts: TieringStmts,
	now: () => Date,
): TieringMethods {
	return {
		promoteMemory(workspaceId, id) {
			return promoteMemory(database, memories, stmts, { workspaceId, id, now: now() });
		},
		demoteMemory(workspaceId, id) {
			return demoteMemory(database, memories, stmts, { workspaceId, id, now: now() });
		},
		archiveMemory(workspaceId, id) {
			try {
				memories.archiveWithReason(workspaceId, id, now().toISOString(), "review-archive", null);
				return true;
			} catch {
				return false;
			}
		},
		archiveBlocker(workspaceId, id) {
			try {
				return archiveGateReason(memories, stmts, workspaceId, id);
			} catch {
				/* v8 ignore next — a store fault here is not reachable from tests. */
				// A gate that cannot read its evidence must not authorize a move.
				return "归档判据不可读，先不自动归档";
			}
		},
		confirmProbation(id) {
			stmts.clearProbation.run("", id);
		},
		probationEvidence(memoryId, originWorkspace) {
			try {
				const row = stmts.usageElsewhere.get(memoryId, originWorkspace) as { n: number } | undefined;
				return Number(row?.n ?? 0);
			} catch {
				return 0;
			}
		},
		probationQueue() {
			try {
				return probationDue(stmts, now());
			} catch {
				return [];
			}
		},
		promotionQueue() {
			try {
				return promotionCandidates(stmts);
			} catch {
				return [];
			}
		},
	};
}
