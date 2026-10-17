/**
 * The verdict-row helpers every landing path shares: the base columns, the
 * landed-rewrite count, and the declined-rewrite payload. They live in their
 * own module so the tiering exits and the ring can both use them without one
 * importing the other.
 */
import type { MemoryStore } from "../store.js";
import type { EvolveVerdict } from "./review-prompt.js";
import type { ReviewCandidate } from "./review.js";

/** The row fields every terminal path shares. */
export interface ReviewRowBase {
	runId: string;
	workspaceId: string;
	itemKind: "memory" | "skill";
	itemId: string;
	model: string;
}

/**
 * The base columns of one item's verdict row.
 * @param item - The item being landed.
 * @returns The shared row fields.
 */
export function rowBaseOf(item: { runId: string; route: { model: string }; candidate: ReviewCandidate }): ReviewRowBase {
	return {
		runId: item.runId,
		workspaceId: item.candidate.workspaceId,
		itemKind: item.candidate.kind,
		itemId: item.candidate.id,
		model: item.route.model,
	};
}

/**
 * How many rewrites have landed on one item so far.
 * @param store - The open store.
 * @param candidate - The item.
 * @returns The landed-rewrite count.
 */
export function evolveCountOf(store: MemoryStore, candidate: ReviewCandidate): number {
	return store.reviewStateOf(candidate.workspaceId, candidate.kind, candidate.id)?.evolveCount ?? 0;
}

/**
 * The rewrite payload a non-landing row keeps: exactly the fields the model
 * supplied, or `undefined` when it proposed no text at all.
 * @param evolved - The verdict.
 * @returns The payload, or `undefined`.
 */
export function proposedOf(evolved: EvolveVerdict): Record<string, string> | undefined {
	const payload: Record<string, string> = {};
	if (evolved.title !== undefined) {
		payload.title = evolved.title;
	}
	if (evolved.description !== undefined) {
		payload.description = evolved.description;
	}
	if (evolved.body !== undefined) {
		payload.body = evolved.body;
	}
	if (evolved.corrects !== undefined) {
		payload.corrects = evolved.corrects;
	}
	return Object.keys(payload).length === 0 ? undefined : payload;
}
