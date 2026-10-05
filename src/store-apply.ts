/**
 * The transactional heart of the sole write path: validate every proposal,
 * apply all of them inside one transaction, ledger each mutation with its
 * before/after snapshot, and roll the whole batch back when any proposal
 * fails. Explicit tool writes and extraction runs land through this same
 * gate — there is no other writer.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
	fieldGateReasons,
	isValidMemoryId,
	type MemoryProposal,
	type MemoryType,
	slugifyId,
} from "./memory-rules.js";
import type { LedgerEntry, MemoryRecord } from "./store.js";

/** What a single proposal produced. */
export interface ProposalOutcome {
	id: string;
	action: MemoryProposal["action"];
	ok: boolean;
	/** Blocking reason when `ok` is false. */
	reason?: string;
}

/** The write context every proposal batch carries (provenance + accounting). */
export interface ProposalContext {
	workspaceId: string;
	trigger: LedgerEntry["trigger"];
	/** Origin session (stored on created rows and ledger rows). */
	sessionId?: string | undefined;
	/** Extraction run id; tool writes default to `'explicit'`. */
	runId?: string | undefined;
	model?: string | undefined;
	usage?: unknown;
	/** One-line model decision summary for the ledger. */
	decision?: string | undefined;
}

/** One mutation's audit payload (embedded in the ledger row's `files` JSON). */
interface LedgerFile {
	id: string;
	action: MemoryProposal["action"];
	before?: MemoryRecord;
	after?: MemoryRecord;
	sourceSeqs?: string | undefined;
}

/** Minimal database face `applyProposals` needs (store.ts hands the real one). */
export interface ApplyDatabase {
	database: DatabaseSync;
	now(): string;
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
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

const INSERT_SQL =
	"INSERT INTO memories (workspace_id, id, type, title, description, body, status, source_session, source_seqs, source_run, created_at, updated_at) " +
	"VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)";
const UPDATE_SQL =
	"UPDATE memories SET type = ?, title = ?, description = ?, body = ?, updated_at = ? WHERE workspace_id = ? AND id = ?";
const DELETE_SQL = "DELETE FROM memories WHERE workspace_id = ? AND id = ?";
const FTS_DROP_SQL =
	"DELETE FROM memories_fts WHERE rowid IN (SELECT rowid FROM memories_fts WHERE workspace_id = ? AND id = ?)";
const FTS_INSERT_SQL =
	"INSERT INTO memories_fts (workspace_id, id, title, description, body) " +
	"SELECT workspace_id, id, title, description, body FROM memories WHERE workspace_id = ? AND id = ?";

/** Re-sync the FTS row for one memory id from its table row (delete + insert). */
function syncFts(db: ApplyDatabase, workspaceId: string, id: string): void {
	db.database.prepare(FTS_DROP_SQL).run(workspaceId, id);
	db.database.prepare(FTS_INSERT_SQL).run(workspaceId, id);
}

/**
 * Validate and apply the whole batch atomically. A batch with any invalid
 * proposal mutates nothing and still lands a `rejected` ledger row; an
 * applied batch lands an `applied` row with full before/after snapshots.
 */
export function applyProposals(
	db: ApplyDatabase,
	ctx: ProposalContext,
	proposals: readonly MemoryProposal[],
): { outcomes: ProposalOutcome[]; applied: boolean } {
	const started = Date.now();
	const outcomes: ProposalOutcome[] = [];
	const files: LedgerFile[] = [];
	const runId = ctx.runId ?? (ctx.trigger === "explicit" ? "explicit" : undefined);
	const get = db.database.prepare("SELECT * FROM memories WHERE workspace_id = ? AND id = ?");
	const insert = db.database.prepare(INSERT_SQL);
	const update = db.database.prepare(UPDATE_SQL);
	const del = db.database.prepare(DELETE_SQL);

	db.database.exec("BEGIN");
	for (const proposal of proposals) {
		const outcome = applyOne(db, ctx, proposal, { get, insert, update, del }, files);
		outcomes.push(outcome);
		if (!outcome.ok) {
			break;
		}
	}
	const applied = outcomes.every((outcome) => outcome.ok);
	db.database.exec(applied ? "COMMIT" : "ROLLBACK");

	const ledger: LedgerEntry = {
		runId,
		sessionId: ctx.sessionId,
		workspaceId: ctx.workspaceId,
		trigger: ctx.trigger,
		decision: ctx.decision,
		status: applied ? "applied" : "rejected",
		durationMs: Date.now() - started,
		model: ctx.model,
		usage: ctx.usage,
		files: applied ? files : [],
	};
	if (!applied) {
		ledger.decision = `${ctx.decision ?? ""} first failure: ${outcomes.find((o) => !o.ok)?.reason ?? ""}`.trim();
	}
	writeLedger(db.database.prepare(LEDGER_SQL), ledger);
	return { outcomes, applied };
}

const LEDGER_SQL =
	"INSERT INTO extraction_log (run_id, ts, session_id, workspace_id, trigger, decision, skip_reason, status, duration_ms, model, usage, files) " +
	"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

function writeLedger(stmt: StatementSync, entry: LedgerEntry): void {
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
		entry.files === undefined ? null : JSON.stringify(entry.files),
	);
}

interface PreparedStatements {
	get: StatementSync;
	insert: StatementSync;
	update: StatementSync;
	del: StatementSync;
}

/** Validate one proposal and land it; appends the audit payload on success. */
function applyOne(
	db: ApplyDatabase,
	ctx: ProposalContext,
	proposal: MemoryProposal,
	stmts: PreparedStatements,
	files: LedgerFile[],
): ProposalOutcome {
	const action = proposal.action;
	if (action !== "create" && action !== "update" && action !== "delete") {
		return fail(proposal, `unknown action ${String(action)}`);
	}
	const id = idFor(proposal);
	if (!isValidMemoryId(id)) {
		return fail(proposal, id.length === 0 ? "id missing and cannot be derived from the title" : `malformed id "${id}"`);
	}
	const existingRow = stmts.get.get(ctx.workspaceId, id) as MemoryRow | undefined;
	const existing = existingRow === undefined ? undefined : recordOf(existingRow);

	if (action === "delete") {
		if (existing === undefined) {
			return fail(proposal, `no memory "${id}" to delete`);
		}
		stmts.del.run(ctx.workspaceId, id);
		syncFts(db, ctx.workspaceId, id);
		files.push({ id, action, before: existing });
		return { id, action, ok: true };
	}

	const fields = mergedFields(proposal, existing, action);
	if ("reason" in fields) {
		return fail(proposal, fields.reason);
	}
	const reasons = fieldGateReasons(fields.fields);
	if (reasons.length > 0) {
		return fail(proposal, reasons[0] ?? "invalid record");
	}
	if (action === "create") {
		if (existing !== undefined) {
			return fail(proposal, `memory "${id}" already exists — update it instead of creating a duplicate`);
		}
		const now = db.now();
		stmts.insert.run(
			ctx.workspaceId,
			id,
			fields.fields.type,
			fields.fields.title,
			fields.fields.description,
			fields.fields.body,
			ctx.sessionId ?? null,
			proposal.sourceSeqs ?? null,
			ctx.runId ?? (ctx.trigger === "explicit" ? "explicit" : null),
			now,
			now,
		);
		syncFts(db, ctx.workspaceId, id);
		files.push({
			id,
			action,
			after: recordOf(stmts.get.get(ctx.workspaceId, id) as unknown as MemoryRow),
			sourceSeqs: proposal.sourceSeqs,
		});
		return { id, action, ok: true };
	}
	// action === "update"
	if (existing === undefined) {
		return fail(proposal, `no memory "${id}" to update — create it instead`);
	}
	stmts.update.run(
		fields.fields.type,
		fields.fields.title,
		fields.fields.description,
		fields.fields.body,
		db.now(),
		ctx.workspaceId,
		id,
	);
	syncFts(db, ctx.workspaceId, id);
	files.push({ id, action, before: existing, after: recordOf(stmts.get.get(ctx.workspaceId, id) as unknown as MemoryRow) });
	return { id, action, ok: true };
}

/** Failure outcome, carrying the proposal id when one was readable. */
function fail(proposal: MemoryProposal, reason: string): ProposalOutcome {
	return { id: proposal.id ?? "", action: proposal.action as ProposalOutcome["action"], ok: false, reason };
}

/** The proposal id, derived from the title (slug, CJK-hash fallback) on create. */
function idFor(proposal: MemoryProposal): string {
	if (proposal.id !== undefined && proposal.id.trim().length > 0) {
		return proposal.id.trim();
	}
	if (proposal.action === "create" && typeof proposal.title === "string") {
		return slugifyId(proposal.title);
	}
	return "";
}

/**
 * The merged field values a create/update would write. Create needs all
 * fields supplied; update merges over the stored record. A missing-required
 * result carries a `reason` instead.
 */
function mergedFields(
	proposal: MemoryProposal,
	existing: MemoryRecord | undefined,
	action: "create" | "update",
): { fields: { type: MemoryType; title: string; description: string; body: string } } | { reason: string } {
	const pick = (value: string | undefined, fallback: string): string =>
		typeof value === "string" ? value : fallback;
	if (action === "create") {
		if (typeof proposal.type !== "string" || typeof proposal.title !== "string" ||
			typeof proposal.description !== "string" || typeof proposal.body !== "string") {
			return { reason: "create requires id?, type, title, description, body" };
		}
		return {
			fields: {
				type: proposal.type as MemoryType,
				title: proposal.title,
				description: proposal.description,
				body: proposal.body,
			},
		};
	}
	if (existing === undefined) {
		return { reason: "no memory to merge into" };
	}
	return {
		fields: {
			type: (typeof proposal.type === "string" ? proposal.type : existing.type) as MemoryType,
			title: pick(proposal.title, existing.title),
			description: pick(proposal.description, existing.description),
			body: pick(proposal.body, existing.body),
		},
	};
}
