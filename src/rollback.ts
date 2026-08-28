/**
 * Deterministic rollback: rebuild the inverse edit list from the applied
 * result, in reverse order. Rollback is pure data transformation — no LLM
 * is asked to "guess" the previous state.
 */
import type { AppliedRefinementEdit, RefinementEdit, RefinementProposal, RefinementResult } from "./types.js";

/** Build the inverse proposal for an applied refinement. */
export function rollbackProposal(target: RefinementResult): RefinementProposal {
	const edits: RefinementEdit[] = [];
	for (const edit of [...target.appliedEdits].reverse()) {
		if (!edit.applied) continue;
		const inverse = inverseEdit(edit, target.id);
		if (inverse) {
			edits.push(inverse);
		}
	}
	return {
		summary: `Rollback refinement ${target.id}`,
		rationale: `Restores harness state to the snapshot recorded before refinement ${target.id}.`,
		expectedOutcome: "Faulty refinement edits are reverted.",
		edits,
	};
}

function inverseEdit(edit: AppliedRefinementEdit, refinementId: string): RefinementEdit | undefined {
	if (edit.before && edit.after) {
		// Forward action was an update: restore the before snapshot.
		// skill_kind rides along (review audit 2026-08-28 B4): without it a
		// rollback could flip the skill form or fail validation on re-apply.
		return {
			action: "update",
			kind: edit.kind,
			id: edit.id,
			title: edit.before.title,
			content: edit.before.content,
			path: edit.before.path,
			reference: edit.before.reference,
			arguments: edit.before.arguments,
			...(edit.before.skill_kind !== undefined ? { skill_kind: edit.before.skill_kind } : {}),
			metadata: edit.before.metadata,
			reason: `Rollback ${refinementId}`,
		};
	}
	if (edit.before) {
		// Forward action was a delete: re-create the entry from the snapshot.
		// skill_kind is required for the re-created skill to pass the same
		// contract validation as the original create (B4: a deleted guidance
		// skill was previously unrecoverable via rollback).
		return {
			action: "create",
			kind: edit.kind,
			id: edit.id,
			title: edit.before.title,
			content: edit.before.content,
			path: edit.before.path,
			reference: edit.before.reference,
			arguments: edit.before.arguments,
			...(edit.before.skill_kind !== undefined ? { skill_kind: edit.before.skill_kind } : {}),
			metadata: edit.before.metadata,
			reason: `Rollback ${refinementId}`,
		};
	}
	if (edit.after) {
		// Forward action was a create: delete the created entry.
		return {
			action: "delete",
			kind: edit.kind,
			id: edit.id,
			reason: `Rollback ${refinementId}`,
		};
	}
	return undefined;
}
