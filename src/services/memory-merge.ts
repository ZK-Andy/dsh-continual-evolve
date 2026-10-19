/**
 * Duplicate merges (P4): when a proposal repeats a fact the store already
 * holds, the write gate folds the old row into a versioned new row
 * (`merged-duplicate` + `merged_into`) instead of overwriting in place, so the
 * superseded text stays visible in the card's archive zone.
 *
 * Two triggers, both mechanical (P4a proved them; P4b unified them):
 * - M1 same id: the proposal names an active row. Ids are unique keys, so
 *   reusing one asserts identity across sessions and verbs — a substantive
 *   same-id proposal always versions.
 * - M2 same title: a create whose normalized title repeats a same-session row
 *   under a different id. Title matching stays session-bound: common titles
 *   recur across authors, and cross-author auto-merges would be误删.
 *
 * Review rewrites (`item-review`) are a second author by design and always
 * keep the in-place path; deletes stay physical. This module never calls the
 * model. It speaks only the repository and the linkage/usage helpers, so
 * `memory-apply` stays its single caller and no import cycle exists.
 */
import type { DatabaseSync } from "node:sqlite";
import { archiveWithReason, repointCorrects, restoreTrial } from "../data/memory-lifecycle.js";
import { recordOf, type MemoryRecord, type MemoryRow } from "../data/records.js";
import type { Repository } from "../data/repository.js";
import { moveMemoryUsage } from "../data/usage-accounts.js";
import type { LedgerFile } from "../store-types.js";
import type { ItemEventEntry } from "../store-types.js";
import { createLinkages, updateLinkages } from "./memory-linkage.js";
import type { MemoryProposal, ProposedFields } from "./memory-rules.js";
import { normalize } from "./pre-screen.js";

/** Version-suffix attempts before a merge fails closed. */
export const MERGE_VERSION_CAP = 100;

/** The write face a merge needs (a structural subset of the gate's database). */
export interface MergeDatabase {
	database: DatabaseSync;
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
 * Decide whether a proposal merges instead of writing in place. A substantive
 * same-id proposal always versions (M1); a create repeating a same-session
 * title versions (M2). Anything else answers `undefined` and the caller keeps
 * its legacy path (in-place update, plain create, legacy failures, deletes).
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
	if (existing !== undefined && existing.status === "active" && substantiveChange(fields, existing)) {
		return { oldId: existing.id, oldRecord: existing };
	}
	if (proposal.action === "create" && existing === undefined && sessionId !== undefined && sessionId.length > 0) {
		return planSameTitle(memories, workspaceId, sessionId, id, fields);
	}
	return undefined;
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
	if (!substantiveChange(fields, oldRecord)) {
		return undefined;
	}
	return { oldId: hit.id, oldRecord };
}

/**
 * Whether the merged fields change anything the screen compares (the same
 * field set `pre-screen` drops no-change updates on, so the two never disagree).
 * A proposal that only (re)names a correction target is not substantive: the
 * link edit stays a cheap in-place write, never a version.
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
 * with its reason and forward pointer, repoint live `corrects` links, carry
 * the usage heartbeat and the trial clock to the new row, insert the versioned
 * row, sync the index, and ledger the before/after pairs. The caller commits
 * or rolls back. `review_log` is deliberately not carried: the new text starts
 * its own review lifecycle; the old verdicts stay with the archived text they
 * judged.
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
	const old = plan.oldRecord;
	archiveWithReason(db.database, ctx.workspaceId, plan.oldId, now, "merged-duplicate", newId);
	followCorrects(db, ctx.workspaceId, files, action, plan.oldId, newId);
	moveMemoryUsage(db.database, ctx.workspaceId, plan.oldId, newId);
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
	if (old.probationUntil !== null || old.originWorkspace !== null) {
		restoreTrial(db.database, ctx.workspaceId, newId, old.probationUntil, old.originWorkspace);
	}
	db.memories.syncFts(ctx.workspaceId, newId);
	const after = db.memories.getRow(ctx.workspaceId, newId);
	if (after === undefined) {
		throw new Error(`merge landed "${newId}" but cannot read it back`);
	}
	files.push({ id: newId, action, before: old, after: recordOf(after) });
	if (action === "create") {
		// A new arrival announces itself to its neighbours, like any create.
		db.events?.(
			createLinkages({ workspaceId: ctx.workspaceId, memories: db.memories }, newId, { type: fields.type, title: fields.title }, link),
		);
	} else {
		// A revision stays quiet, like any update: neighbours are not dragged
		// back into the review queue by a retouch.
		db.events?.(updateLinkages({ workspaceId: ctx.workspaceId, memories: db.memories }, newId, link));
	}
	return { id: newId, action, ok: true };
}

/**
 * Repoint live `corrects` links from the folded row to its successor, so the
 * correction graph follows the live truth instead of rotting on history.
 * Each repoint lands its own ledger pair: silent pointer surgery is how
 * untraceable graphs are made.
 */
function followCorrects(
	db: MergeDatabase,
	workspaceId: string,
	files: LedgerFile<MemoryProposal["action"], MemoryRecord>[],
	action: MemoryProposal["action"],
	oldId: string,
	newId: string,
): void {
	const pointers = db.memories.listRows(workspaceId).filter((row) => row.corrects === oldId);
	if (pointers.length === 0) {
		return;
	}
	const moved = repointCorrects(db.database, workspaceId, oldId, newId);
	for (const row of pointers.slice(0, moved)) {
		const before = recordOf(row);
		const after = recordOf({ ...row, corrects: newId });
		files.push({ id: row.id, action, before, after });
	}
}
