/**
 * Same-session duplicate merges (P4a): when a session re-proposes a fact it
 * already landed, the write gate folds the old row into a versioned new row
 * (`merged-duplicate` + `merged_into`) instead of overwriting in place, so the
 * superseded text stays visible in the card's archive zone. Anything outside
 * the session scope — ordinary updates, review rewrites, tool edits — keeps
 * the legacy in-place path (P4b unifies them).
 *
 * This module never calls the model: both triggers are mechanical (same id,
 * same normalized title in the same session). It speaks only the repository
 * and the linkage helper, so `memory-apply` stays its single caller and no
 * import cycle exists.
 */
import { recordOf, type MemoryRecord, type MemoryRow } from "../data/records.js";
import type { Repository } from "../data/repository.js";
import type { LedgerFile } from "../store-types.js";
import type { ItemEventEntry } from "../store-types.js";
import { createLinkages } from "./memory-linkage.js";
import type { MemoryProposal, ProposedFields } from "./memory-rules.js";
import { normalize } from "./pre-screen.js";

/** Merged body pairs above this stay on the legacy in-place path (P4 cap). */
export const MERGE_INPUT_CHAR_CAP = 8000;

/** Version-suffix attempts before a merge fails closed. */
export const MERGE_VERSION_CAP = 100;

/** The write face a merge needs (a structural subset of the gate's database). */
export interface MergeDatabase {
	now(): string;
	memories: Repository<MemoryRow>;
	/** Review-queue linkage writer, absent in gate-only unit tests. */
	events?: ((entries: readonly ItemEventEntry[]) => void) | undefined;
}

/** The provenance a merge reads (a structural subset of the proposal context). */
export interface MergeContext {
	workspaceId: string;
	trigger: string;
	sessionId?: string | undefined;
	runId?: string | undefined;
}

/** One merge decision: which active row folds into the incoming proposal. */
export interface MergePlan {
	oldId: string;
	oldRecord: MemoryRecord;
}

/**
 * Decide whether a proposal merges instead of writing in place. Only
 * same-session repeats on the authoring path qualify: the proposal's session
 * must equal the stored row's `source_session`, the change must be
 * substantive, the old row must not be a correction target, and the pair must
 * fit the input cap. Review rewrites (`item-review`) are a second author by
 * design and always keep the in-place path. Anything else answers `undefined`
 * and the caller keeps its legacy path.
 * @param args - The store, the proposal, and what the gate already resolved.
 * @returns The merge target, or `undefined` for the legacy path.
 */
export function planMerge(args: {
	memories: Repository<MemoryRow>;
	workspaceId: string;
	trigger: string;
	sessionId: string | undefined;
	proposal: MemoryProposal;
	id: string;
	existing: MemoryRecord | undefined;
	fields: ProposedFields;
}): MergePlan | undefined {
	const { memories, workspaceId, trigger, sessionId, proposal, id, existing, fields } = args;
	if (proposal.action === "delete" || trigger === "item-review") {
		return undefined;
	}
	if (sessionId === undefined || sessionId.length === 0) {
		return undefined;
	}
	if (existing !== undefined && existing.status === "active" && existing.sourceSession === sessionId) {
		return planSameId(memories, workspaceId, fields, existing);
	}
	if (proposal.action === "create" && existing === undefined) {
		return planSameTitle(memories, workspaceId, sessionId, id, fields);
	}
	return undefined;
}

/**
 * The M1 trigger: the proposal names an active row from the same session.
 * @returns The merge plan, or `undefined` for the legacy path.
 */
function planSameId(
	memories: Repository<MemoryRow>,
	workspaceId: string,
	fields: ProposedFields,
	existing: MemoryRecord,
): MergePlan | undefined {
	if (!substantiveChange(fields, existing) || overCap(fields.body, existing.body)) {
		return undefined;
	}
	if (isCorrectedTarget(memories, workspaceId, existing.id)) {
		return undefined;
	}
	return { oldId: existing.id, oldRecord: existing };
}

/**
 * The M2 trigger: a create whose normalized title repeats a same-session row
 * under a different id (title retouch the propose call did not catch).
 * @returns The merge plan, or `undefined` for the legacy path.
 */
function planSameTitle(
	memories: Repository<MemoryRow>,
	workspaceId: string,
	sessionId: string,
	id: string,
	fields: ProposedFields,
): MergePlan | undefined {
	const wanted = normalize(fields.title);
	const hit = memories
		.listRows(workspaceId)
		.find(
			(row) =>
				row.id !== id && row.type === fields.type && row.source_session === sessionId && normalize(row.title) === wanted,
		);
	if (hit === undefined) {
		return undefined;
	}
	const oldRecord = recordOf(hit);
	if (!substantiveChange(fields, oldRecord) || overCap(fields.body, oldRecord.body)) {
		return undefined;
	}
	if (isCorrectedTarget(memories, workspaceId, hit.id)) {
		return undefined;
	}
	return { oldId: hit.id, oldRecord };
}

/**
 * Whether the merged fields change anything the screen compares (the same
 * field set `pre-screen` drops no-change updates on, so the two never disagree).
 */
function substantiveChange(fields: ProposedFields, existing: MemoryRecord): boolean {
	return (
		fields.type !== existing.type ||
		normalize(fields.title) !== normalize(existing.title) ||
		normalize(fields.description) !== normalize(existing.description) ||
		normalize(fields.body) !== normalize(existing.body) ||
		normalize(fields.notWhen) !== normalize(existing.notWhen)
	);
}

/** Whether the old/new body pair exceeds the merge input cap. */
function overCap(next: string, current: string): boolean {
	return next.length + current.length > MERGE_INPUT_CHAR_CAP;
}

/** Whether an active row points at the id with `corrects` (merging would strand it). */
function isCorrectedTarget(memories: Repository<MemoryRow>, workspaceId: string, id: string): boolean {
	return memories.listRows(workspaceId).some((row) => row.corrects === id);
}

/**
 * Allocate the new row's id: `<base>-vN`, first free suffix in partition order.
 * `getRow` ignores status, so archived versions block reuse by construction —
 * the primary key can never collide with history.
 * @param memories - The memories repository.
 * @param workspaceId - The partition.
 * @param base - The folded row's id.
 * @returns The free versioned id, or `undefined` when exhausted (fail closed).
 */
export function allocateVersionId(
	memories: Repository<MemoryRow>,
	workspaceId: string,
	base: string,
): string | undefined {
	for (let version = 2; version < 2 + MERGE_VERSION_CAP; version += 1) {
		const candidate = `${base}-v${String(version)}`;
		if (memories.getRow(workspaceId, candidate) === undefined) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Land a planned merge inside the batch's own transaction: archive the old row
 * with its reason and forward pointer, insert the versioned row, sync the
 * index, and ledger the before/after pair. The caller commits or rolls back.
 * @param args - The database, the plan, and what the gate already resolved.
 * @returns The successful outcome under the new row's id.
 * @throws When the just-inserted row is unreadable (fail loud: the batch must roll back).
 */
export function landMerge(args: {
	db: MergeDatabase;
	ctx: MergeContext;
	proposal: MemoryProposal;
	action: MemoryProposal["action"];
	plan: MergePlan;
	newId: string;
	fields: ProposedFields;
	link: string | null;
	files: LedgerFile<MemoryProposal["action"], MemoryRecord>[];
}): { id: string; action: MemoryProposal["action"]; ok: true } {
	const { db, ctx, proposal, action, plan, newId, fields, link, files } = args;
	const now = db.now();
	db.memories.archiveWithReason(ctx.workspaceId, plan.oldId, now, "merged-duplicate", newId);
	db.memories.insertRow([
		ctx.workspaceId,
		newId,
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
	db.memories.syncFts(ctx.workspaceId, newId);
	const after = db.memories.getRow(ctx.workspaceId, newId);
	if (after === undefined) {
		throw new Error(`merge landed "${newId}" but cannot read it back`);
	}
	files.push({ id: newId, action, before: plan.oldRecord, after: recordOf(after) });
	db.events?.(
		createLinkages({ workspaceId: ctx.workspaceId, memories: db.memories }, newId, { type: fields.type, title: fields.title }, link),
	);
	return { id: newId, action, ok: true };
}
