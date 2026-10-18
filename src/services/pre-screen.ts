/**
 * Deterministic pre-screen for extraction proposals
 * (ADR `2026-10-18-absorb-memory-plugin-strengths`, item F6).
 *
 * The cheap gate already filters at the input side, but the model can still
 * answer with proposals that are mechanically worthless: a body identical to a
 * memory that already exists, or an update that changes nothing. Those used to
 * reach the store, bump `updated_at`, move the review queue, and show up as
 * "applied" in the ledger. This module rejects them with a named reason before
 * the write — pure functions, no store access.
 *
 * A "too short to be a rule" rule was considered and dropped: short prohibitions
 * ("别用 rm") are legitimate memories, and the extraction fixtures proved the
 * threshold misfires on real content.
 *
 * Scope, stated plainly: this saves writes and ledger noise, not model tokens
 * (the proposal only exists after the model answered). Token savings stay with
 * the cheap gate.
 */
/** The proposal fields the screen reads; everything else passes through. */
export interface ScreenedProposal {
	action: "create" | "update" | "delete";
	id?: string | undefined;
	type?: string | undefined;
	title?: string | undefined;
	description?: string | undefined;
	body?: string | undefined;
	notWhen?: string | undefined;
}

/** One memory row the screen compares against (active rows of the workspace). */
export interface ScreenedExisting {
	id: string;
	title: string;
	description: string;
	body: string;
	notWhen?: string | undefined;
}

/** Why a proposal was rejected. */
export type ScreenReason = "duplicate" | "no-change";

/** The decision for one proposal. */
export type ScreenVerdict = { keep: true } | { keep: false; reason: ScreenReason };

/** Normalize text for comparison: collapse whitespace, trim. */
function normalize(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Whether an update proposal changes any of the fields it carries. */
function changesNothing(proposal: ScreenedProposal, existing: ScreenedExisting): boolean {
	const same = (next: string | undefined, current: string): boolean =>
		next === undefined || normalize(next) === normalize(current);
	return (
		same(proposal.title, existing.title) &&
		same(proposal.description, existing.description) &&
		same(proposal.body, existing.body) &&
		same(proposal.notWhen, existing.notWhen ?? "")
	);
}

/**
 * Screen one proposal against the workspace's active memories.
 *
 * @param proposal - The model's proposal.
 * @param existing - Active memories of the same workspace.
 * @returns Keep, or the named reason to skip.
 */
export function screenProposal(proposal: ScreenedProposal, existing: readonly ScreenedExisting[]): ScreenVerdict {
	if (proposal.action === "delete") {
		return { keep: true };
	}
	const body = typeof proposal.body === "string" ? proposal.body : "";
	if (proposal.action === "create") {
		const normalized = normalize(body);
		if (normalized.length > 0 && existing.some((row) => normalize(row.body) === normalized)) {
			return { keep: false, reason: "duplicate" };
		}
		return { keep: true };
	}
	// update: needs the row it targets
	const target =
		typeof proposal.id === "string" ? existing.find((row) => row.id === proposal.id) : undefined;
	if (target !== undefined && changesNothing(proposal, target)) {
		return { keep: false, reason: "no-change" };
	}
	return { keep: true };
}

/** What screening a whole batch produced. */
export interface ScreenBatchResult {
	/** Proposals worth applying. */
	kept: ScreenedProposal[];
	/** One reason per dropped proposal, in batch order. */
	dropped: ScreenReason[];
}

/**
 * Screen a whole batch.
 * @param proposals - The model's proposals.
 * @param existing - Active memories of the same workspace.
 * @returns The kept proposals and the drop reasons.
 */
export function screenProposals(
	proposals: readonly ScreenedProposal[],
	existing: readonly ScreenedExisting[],
): ScreenBatchResult {
	const kept: ScreenedProposal[] = [];
	const dropped: ScreenReason[] = [];
	for (const proposal of proposals) {
		const verdict = screenProposal(proposal, existing);
		if (verdict.keep) {
			kept.push(proposal);
		} else {
			dropped.push(verdict.reason);
		}
	}
	return { kept, dropped };
}

/**
 * One ledger reason for a batch that was fully dropped.
 * @param reasons - The drop reasons in batch order.
 * @returns A `pre-screen: …` reason, or undefined when nothing was dropped.
 */
export function screenSkipReason(reasons: readonly ScreenReason[]): string | undefined {
	if (reasons.length === 0) {
		return undefined;
	}
	const counts = new Map<ScreenReason, number>();
	for (const reason of reasons) {
		counts.set(reason, (counts.get(reason) ?? 0) + 1);
	}
	const parts = [...counts.entries()].map(([reason, count]) => `${reason}×${String(count)}`);
	return `pre-screen: ${parts.join(", ")}`;
}
