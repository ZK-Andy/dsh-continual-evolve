/**
 * The transactional heart of the sole write path: validate every proposal,
 * apply all of them inside one transaction, ledger each mutation with its
 * before/after snapshot, and roll the whole batch back when any proposal
 * fails. Explicit tool writes and extraction runs land through this same
 * gate — there is no other writer.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { shouldStorePromptJson } from "./extraction-prompt.js";
import {
	fieldGateReasons,
	isValidMemoryId,
	type MemoryProposal,
	type MemoryScope,
	type MemoryType,
	type ProposedFields,
	slugifyId,
} from "./memory-rules.js";
import type { ItemEventEntry, LedgerEntry, LedgerFile, MemoryRecord } from "../store-types.js";
import { createLinkages, updateLinkages } from "./memory-linkage.js";
import { commitWithLedger, writeMemoryLedger } from "../data/ledger.js";
import { recordOf, type MemoryRow } from "../data/records.js";
import { type Repository } from "../data/repository.js";

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
	/** Pre-gate call payload (extraction cheap gate); carried into the ledger row. */
	cheapUsage?: unknown;
	/** Error head when the pre-gate call threw (fail open); carried into the ledger row. */
	cheapError?: string | undefined;
	/** Classification call payload (P2 two-stage); carried into the ledger row. */
	classifyUsage?: unknown;
	/** Error head when the classify call threw (fail open); carried into the ledger row. */
	classifyError?: string | undefined;
	/** Truncated prompts JSON (P2 audit, failures + 5% sample); carried into the ledger row. */
	promptJson?: string | undefined;
	/** Per-item drop warnings (P2拒因分布); carried into the ledger row. */
	droppedWarnings?: { id: string; reason: string }[] | undefined;
	/** One-line model decision summary for the ledger. */
	decision?: string | undefined;
}

/** One memory mutation's audit payload (action/record pinned, shape shared). */
type MemoryLedgerFile = LedgerFile<MemoryProposal["action"], MemoryRecord>;

/** Minimal database face `applyProposals` needs (store.ts hands the real one). */
export interface ApplyDatabase {
	database: DatabaseSync;
	now(): string;
	/** The memories repository: all memories-table access goes through it. */
	memories: Repository<MemoryRow>;
	/** The pre-prepared extraction ledger statement (owned by `data/ledger.ts`). */
	ledger: StatementSync;
	/**
	 * Append review-queue linkage events. Called inside the batch's own
	 * transaction, so the row and the linkages it causes commit together.
	 * Absent in unit tests that exercise the gate alone.
	 */
	events?: ((entries: readonly ItemEventEntry[]) => void) | undefined;
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
	const files: MemoryLedgerFile[] = [];
	const runId = ctx.runId ?? (ctx.trigger === "explicit" ? "explicit" : undefined);

	db.database.exec("BEGIN");
	for (const proposal of proposals) {
		const outcome = applyOne(db, ctx, proposal, files);
		outcomes.push(outcome);
		if (!outcome.ok) {
			break;
		}
	}
	const applied = outcomes.every((outcome) => outcome.ok);
	const status = applied ? "applied" : "rejected";
	const ledger: LedgerEntry = {
		runId,
		sessionId: ctx.sessionId,
		workspaceId: ctx.workspaceId,
		trigger: ctx.trigger,
		decision: ctx.decision,
		status,
		durationMs: Date.now() - started,
		model: ctx.model,
		usage: ctx.usage,
		cheapUsage: ctx.cheapUsage,
		cheapError: ctx.cheapError,
		classifyUsage: ctx.classifyUsage,
		classifyError: ctx.classifyError,
		promptJson: ctx.promptJson !== undefined && shouldStorePromptJson(runId, status) ? ctx.promptJson : undefined,
		droppedWarnings: ctx.droppedWarnings,
		files: applied ? files : [],
	};
	if (!applied) {
		ledger.decision = `${ctx.decision ?? ""} first failure: ${outcomes.find((o) => !o.ok)?.reason ?? ""}`.trim();
	}
	if (applied) {
		// Body and audit row commit together: a ledger write that fails rolls the
		// body back instead of leaving an edit with no trace (2026-10-16).
		commitWithLedger(db.database, () => writeMemoryLedger(db.ledger, ledger));
	} else {
		db.database.exec("ROLLBACK");
		writeMemoryLedger(db.ledger, ledger);
	}
	return { outcomes, applied };
}

/** Everything one memory proposal needs once gates have passed. */
interface MemoryApplyJob {
	db: ApplyDatabase;
	ctx: ProposalContext;
	proposal: MemoryProposal;
	id: string;
	existing: MemoryRecord | undefined;
	fields: ProposedFields;
	link: string | null;
	files: MemoryLedgerFile[];
}

/** Validate one proposal and land it; appends the audit payload on success. */
function applyOne(
	db: ApplyDatabase,
	ctx: ProposalContext,
	proposal: MemoryProposal,
	files: MemoryLedgerFile[],
): ProposalOutcome {
	const action = proposal.action;
	if (action !== "create" && action !== "update" && action !== "delete") {
		return fail(proposal, `unknown action ${String(action)}`);
	}
	const id = idFor(proposal);
	if (!isValidMemoryId(id)) {
		return fail(proposal, id.length === 0 ? "id missing and cannot be derived from the title" : `malformed id "${id}"`);
	}
	const existingRow = db.memories.getRow(ctx.workspaceId, id);
	const existing = existingRow === undefined ? undefined : recordOf(existingRow);

	if (action === "delete") {
		return deleteMemory({ db, ctx, proposal, id, existing, files });
	}

	const fields = mergedFields(proposal, existing, action);
	if ("reason" in fields) {
		return fail(proposal, fields.reason);
	}
	const link = checkCorrects(db.memories, ctx.workspaceId, proposal, id);
	if ("reason" in link) {
		return fail(proposal, link.reason);
	}
	const reasons = fieldGateReasons(fields.fields);
	if (reasons.length > 0) {
		return fail(proposal, reasons[0] ?? "invalid record");
	}
	const job: MemoryApplyJob = { db, ctx, proposal, id, existing, fields: fields.fields, link: link.value, files };
	if (action === "create") {
		return createMemory(job);
	}
	// action === "update"
	return updateMemory(job);
}

/** Land a delete proposal (no gates beyond existence). */
function deleteMemory(job: Pick<MemoryApplyJob, "db" | "ctx" | "proposal" | "id" | "existing" | "files">): ProposalOutcome {
	const { db, ctx, proposal, id, existing, files } = job;
	const action = proposal.action;
	if (existing === undefined) {
		return fail(proposal, `no memory "${id}" to delete`);
	}
	db.memories.deleteRow(ctx.workspaceId, id);
	db.memories.syncFts(ctx.workspaceId, id);
	files.push({ id, action, before: existing });
	return { id, action, ok: true };
}

/** Land a create proposal with its validated fields and correction link. */
function createMemory(job: MemoryApplyJob): ProposalOutcome {
	const { db, ctx, proposal, id, existing, fields, link, files } = job;
	const action = proposal.action;
	if (existing !== undefined) {
		return fail(proposal, `memory "${id}" already exists — update it instead of creating a duplicate`);
	}
	const now = db.now();
	db.memories.insertRow([
		ctx.workspaceId,
		id,
		fields.type,
		fields.title,
		fields.description,
		fields.body,
		fields.scope,
		ctx.sessionId ?? null,
		proposal.sourceSeqs ?? null,
		ctx.runId ?? (ctx.trigger === "explicit" ? "explicit" : null),
		link,
		fields.notWhen,
		now,
		now,
	]);
	db.memories.syncFts(ctx.workspaceId, id);
	files.push({
		id,
		action,
		after: recordOf(db.memories.getRow(ctx.workspaceId, id) as MemoryRow),
		sourceSeqs: proposal.sourceSeqs,
	});
	db.events?.(createLinkages({ workspaceId: ctx.workspaceId, memories: db.memories }, id, fields, link));
	return { id, action, ok: true };
}

/** Land an update proposal over its stored row. */
function updateMemory(job: MemoryApplyJob): ProposalOutcome {
	const { db, ctx, proposal, id, existing, fields, link, files } = job;
	const action = proposal.action;
	// action === "update"
	if (existing === undefined) {
		return fail(proposal, `no memory "${id}" to update — create it instead`);
	}
	db.memories.updateRow([
		fields.type,
		fields.title,
		fields.description,
		fields.body,
		fields.scope,
		link,
		fields.notWhen,
		db.now(),
		ctx.workspaceId,
		id,
	]);
	db.memories.syncFts(ctx.workspaceId, id);
	files.push({ id, action, before: existing, after: recordOf(db.memories.getRow(ctx.workspaceId, id) as MemoryRow) });
	// A plain text update (the review's own rewrite included) links nobody.
	db.events?.(updateLinkages({ workspaceId: ctx.workspaceId, memories: db.memories }, id, link));
	return { id, action, ok: true };
}

/** Failure outcome, carrying the proposal id when one was readable. */
function fail(proposal: MemoryProposal, reason: string): ProposalOutcome {
	return { id: proposal.id ?? "", action: proposal.action as ProposalOutcome["action"], ok: false, reason };
}

/**
 * Resolve the correction link: absent (or explicitly empty-checked) proposals
 * carry `null`, which keeps an existing link on update and stores null on
 * create. A named target must be a well-formed id in the same workspace,
 * must exist, must be active, and must not be the row itself.
 */
function checkCorrects(
	memories: Repository<MemoryRow>,
	workspaceId: string,
	proposal: MemoryProposal,
	id: string,
): { value: string | null } | { reason: string } {
	const raw = proposal.corrects;
	if (raw === undefined) {
		return { value: null };
	}
	const target = raw.trim();
	if (target.length === 0) {
		return { reason: "corrects must not be empty — omit it instead" };
	}
	if (!isValidMemoryId(target)) {
		return { reason: `malformed corrects target "${target}"` };
	}
	if (target === id) {
		return { reason: `memory "${id}" cannot correct itself` };
	}
	const row = memories.getRow(workspaceId, target);
	if (row === undefined) {
		return { reason: `no memory "${target}" to correct` };
	}
	if (row.status !== "active") {
		return { reason: `memory "${target}" is not active and cannot be corrected` };
	}
	return { value: target };
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
): { fields: ProposedFields } | { reason: string } {
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
				// Cast narrows the proposal's free-form string to the taxonomy; the
				// field gate right after rejects anything outside it.
				scope: (typeof proposal.scope === "string" ? proposal.scope : "project") as MemoryScope,
				notWhen: typeof proposal.notWhen === "string" ? proposal.notWhen : "",
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
			// Omitted scope keeps the stored one: an update that only touches
			// text must not silently reset a promotion candidate to `project`.
			scope: (typeof proposal.scope === "string" ? proposal.scope : existing.scope) as MemoryScope,
			notWhen: pick(proposal.notWhen, existing.notWhen),
		},
	};
}
