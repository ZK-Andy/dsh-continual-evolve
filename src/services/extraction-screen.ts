/**
 * The extraction pre-screen bridge: reads the workspace's active memories and
 * screens the model's proposals against them
 * (ADR `2026-10-18-absorb-memory-plugin-strengths`, item F6).
 *
 * It lives apart from the chain so the ring keeps one edge for screening and
 * `services/pre-screen.ts` stays a pure function module.
 */
import type { MemoryStore } from "../store-types.js";
import type { MemoryProposal } from "./memory-rules.js";
import { screenProposals, screenSkipReason } from "./pre-screen.js";

/** What screening produced for one answer. */
export interface ScreenedBatch {
	/** Proposals worth applying. */
	kept: MemoryProposal[];
	/** Ledger reason when nothing survived; undefined when something did. */
	skipReason: string | undefined;
	/** Per-item drop warnings (P2 ledger input, empty when nothing dropped). */
	warnings: { id: string; reason: string }[];
}

/**
 * Screen one answer's proposals against the workspace's active memories.
 * @param store - The open store (its `list` reads the active rows).
 * @param workspaceId - The partition the proposals target.
 * @param proposals - The model's proposals.
 * @returns The kept proposals and, when all were dropped, the ledger reason.
 */
export function screenExtractionBatch(
	store: MemoryStore,
	workspaceId: string,
	proposals: readonly MemoryProposal[],
): ScreenedBatch {
	const existing = store.list(workspaceId).map((record) => ({
		id: record.id,
		title: record.title,
		description: record.description,
		body: record.body,
		notWhen: record.notWhen,
	}));
	const screened = screenProposals(proposals, existing);
	return {
		kept: screened.kept as MemoryProposal[],
		skipReason: screened.kept.length === 0 ? (screenSkipReason(screened.dropped) ?? "pre-screen: no proposals") : undefined,
		warnings: screened.warnings,
	};
}
