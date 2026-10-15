/**
 * The prompt-supplement write gate: validate one proposal and land it,
 * then ledger the batch. Workspace-only (no scope, no move-to-global, no
 * file projection): create/update/delete over the caller's partition,
 * mirroring `skill-apply.ts` minus its global half. Nothing reaches the
 * database without the mechanical gates in `prompt-rules.ts`.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { isValidMemoryId } from "./memory-rules.js";
import { promptFieldGateReasons, slugifyPromptId, type PromptFields, type PromptProposal } from "./prompt-rules.js";
import type { ProposalContext } from "./memory-apply.js";
import type { LedgerFile, PromptRecord, PromptProposalOutcome } from "../store-types.js";
import { writePromptLedger } from "../data/ledger.js";
import { promptRecordOf, type PromptRow } from "../data/records.js";
import type { Repository } from "../data/repository.js";

/** A prompt mutation's audit payload (action/record pinned, shape shared). */
export type PromptLedgerFile = LedgerFile<PromptProposal["action"], PromptRecord>;

/** The proposal id, derived from the title (slug, CJK-hash fallback) on create. */
function promptIdFor(proposal: PromptProposal): string {
	if (proposal.id !== undefined && proposal.id.trim().length > 0) {
		return proposal.id.trim();
	}
	if (proposal.action === "create" && typeof proposal.title === "string") {
		return slugifyPromptId(proposal.title);
	}
	return "";
}

function promptFail(proposal: PromptProposal, reason: string): PromptProposalOutcome {
	return {
		id: proposal.id ?? "",
		action: proposal.action as PromptProposalOutcome["action"],
		ok: false,
		reason,
	};
}

/** The merged field values a prompt create/update would write. */
function mergedPromptFields(
	proposal: PromptProposal,
	existing: PromptRecord | undefined,
	action: "create" | "update",
): { fields: PromptFields } | { reason: string } {
	const pick = (value: string | undefined, fallback: string): string => (typeof value === "string" ? value : fallback);
	if (action === "create") {
		if (typeof proposal.title !== "string" || typeof proposal.description !== "string" || typeof proposal.body !== "string") {
			return { reason: "create requires id?, title, description, body" };
		}
		return { fields: { title: proposal.title, description: proposal.description, body: proposal.body } };
	}
	if (existing === undefined) {
		return { reason: "no prompt to merge into" };
	}
	return {
		fields: {
			title: pick(proposal.title, existing.title),
			description: pick(proposal.description, existing.description),
			body: pick(proposal.body, existing.body),
		},
	};
}

/** Everything one prompt proposal needs once its id is validated. */
interface PromptApplyJob {
	prompts: Repository<PromptRow>;
	ctx: ProposalContext;
	proposal: PromptProposal;
	id: string;
	existing: PromptRecord | undefined;
	now: string;
	files: PromptLedgerFile[];
}

/**
 * Validate one prompt proposal and land it (inside the caller's transaction).
 * @param prompts - The prompts repository.
 * @param ctx - The write context (provenance + accounting).
 * @param proposal - The single mutation to validate and land.
 * @param now - The ISO instant stamped on touched rows.
 * @param files - Ledger file payloads appended on success.
 * @returns The single-proposal outcome.
 */
export function applyPromptOne(
	prompts: Repository<PromptRow>,
	ctx: ProposalContext,
	proposal: PromptProposal,
	now: string,
	files: PromptLedgerFile[],
): PromptProposalOutcome {
	const action = proposal.action;
	if (action !== "create" && action !== "update" && action !== "delete") {
		return promptFail(proposal, `unknown action ${String(action)}`);
	}
	const id = promptIdFor(proposal);
	if (!isValidMemoryId(id)) {
		return promptFail(proposal, id.length === 0 ? "id missing and cannot be derived from the title" : `malformed id "${id}"`);
	}
	const existingRow = prompts.getRow(ctx.workspaceId, id);
	const existing = existingRow === undefined || existingRow.status === "archived" ? undefined : promptRecordOf(existingRow);
	const job: PromptApplyJob = { prompts, ctx, proposal, id, existing, now, files };
	if (action === "create") {
		return createPrompt(job);
	}
	if (action === "delete") {
		return deletePrompt(job);
	}
	// action === "update"
	return updatePrompt(job);
}

/** Land a create proposal, with same-body deduplication. */
function createPrompt(job: PromptApplyJob): PromptProposalOutcome {
	const { prompts, ctx, proposal, id, existing, now, files } = job;
	const action = proposal.action;
	const merged = mergedPromptFields(proposal, undefined, "create");
	if ("reason" in merged) {
		return promptFail(proposal, merged.reason);
	}
	const reasons = promptFieldGateReasons(merged.fields);
	if (reasons.length > 0) {
		return promptFail(proposal, reasons[0] ?? "invalid prompt");
	}
	if (existing !== undefined) {
		return promptFail(proposal, `prompt "${id}" already exists in this workspace — update it instead of creating a duplicate`);
	}
	const sameBody = prompts.findBodyOwner(ctx.workspaceId, merged.fields.body);
	if (sameBody !== undefined && sameBody !== id) {
		return promptFail(proposal, `identical prompt "${sameBody}" already exists in this workspace — reuse it instead of duplicating`);
	}
	prompts.insertRow([
		ctx.workspaceId,
		id,
		merged.fields.title,
		merged.fields.description,
		merged.fields.body,
		ctx.sessionId ?? null,
		proposal.sourceSeqs ?? null,
		ctx.runId ?? (ctx.trigger === "explicit" ? "explicit" : null),
		now,
		now,
	]);
	prompts.syncFts(ctx.workspaceId, id);
	files.push({
		id,
		action,
		after: promptRecordOf(prompts.getRow(ctx.workspaceId, id) as PromptRow),
		sourceSeqs: proposal.sourceSeqs,
	});
	return { id, action, ok: true };
}

/** Land a delete proposal (no gates beyond existence). */
function deletePrompt(job: PromptApplyJob): PromptProposalOutcome {
	const { prompts, ctx, proposal, id, existing, files } = job;
	const action = proposal.action;
	if (existing === undefined) {
		return promptFail(proposal, `no prompt "${id}" to delete`);
	}
	prompts.deleteRow(ctx.workspaceId, id);
	prompts.syncFts(ctx.workspaceId, id);
	files.push({ id, action, before: existing });
	return { id, action, ok: true };
}

/** Land an update proposal over its stored row. */
function updatePrompt(job: PromptApplyJob): PromptProposalOutcome {
	const { prompts, ctx, proposal, id, existing, now, files } = job;
	const action = proposal.action;
	// action === "update"
	if (existing === undefined) {
		return promptFail(proposal, `no prompt "${id}" to update — create it instead`);
	}
	const merged = mergedPromptFields(proposal, existing, "update");
	if ("reason" in merged) {
		return promptFail(proposal, merged.reason);
	}
	const reasons = promptFieldGateReasons(merged.fields);
	if (reasons.length > 0) {
		return promptFail(proposal, reasons[0] ?? "invalid prompt");
	}
	prompts.updateRow([merged.fields.title, merged.fields.description, merged.fields.body, now, ctx.workspaceId, id]);
	prompts.syncFts(ctx.workspaceId, id);
	files.push({ id, action, before: existing, after: promptRecordOf(prompts.getRow(ctx.workspaceId, id) as PromptRow) });
	return { id, action, ok: true };
}

/**
 * Run one prompt batch: validate all proposals, apply atomically, ledger.
 * The database is the source of truth; the ledger row carries before/after
 * snapshots for undo. Prompts project to no files, so there are no intents.
 * @param prompts - The prompts repository.
 * @param database - The open database handle (for the transaction).
 * @param promptLog - The prepared prompt_log insert.
 * @param ctx - The write context (provenance + accounting).
 * @param proposals - The batch to validate and land.
 * @returns The per-proposal outcomes.
 */
export function applyPromptBatch(
	prompts: Repository<PromptRow>,
	database: DatabaseSync,
	promptLog: StatementSync,
	ctx: ProposalContext,
	proposals: readonly PromptProposal[],
): PromptProposalOutcome[] {
	const outcomes: PromptProposalOutcome[] = [];
	const files: PromptLedgerFile[] = [];
	const runId = ctx.runId ?? (ctx.trigger === "explicit" ? "explicit" : undefined);
	const now = new Date().toISOString();
	database.exec("BEGIN");
	for (const proposal of proposals) {
		const outcome = applyPromptOne(prompts, ctx, proposal, now, files);
		outcomes.push(outcome);
		if (!outcome.ok) {
			break;
		}
	}
	const applied = outcomes.every((outcome) => outcome.ok);
	database.exec(applied ? "COMMIT" : "ROLLBACK");
	const decision = applied ? ctx.decision : `${ctx.decision ?? ""} first failure: ${outcomes.find((o) => !o.ok)?.reason ?? ""}`.trim();
	writePromptLedger(promptLog, {
		runId,
		sessionId: ctx.sessionId,
		workspaceId: ctx.workspaceId,
		trigger: ctx.trigger,
		decision,
		status: applied ? "applied" : "rejected",
		files: applied ? files : [],
	});
	return outcomes;
}
