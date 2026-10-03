/**
 * Wrap-up proposal builders: turn assessed verdicts into deterministic,
 * evidence-carrying refinement proposals — whole promotes, split promotes,
 * archive reviews, and valence stamps. Pure logic over the candidate types
 * in `wrapup-candidates.ts`; the user approves, the engine applies.
 */
import type { HarnessState, RefinementKind, RefinementProposal } from "./types.js";
import { ARCHIVED_AT_KEY, PROMOTED_AT_KEY, PROMOTED_TO_KEY, SOURCE_SEQS_KEY, SOURCE_SESSION_KEY, SOURCED_FROM_KEY, VALENCE_NEGATIVE_KEY } from "./types.js";
import { MEMORY_TYPE_KEY, isMemoryType } from "./types.js";
import { DEFAULT_PROMOTION_POLICY, mostSimilarGlobalEntry, projectScopedReason, secretLeakReason, type PromotionPolicy } from "./promotion.js";
import { globalCoverageDetected } from "./wrapup-candidates.js";
import { candidateKey, type WrapupCandidate, type WrapupItem } from "./wrapup-candidates.js";
export interface PromotableSplit {
	/** Items that may be promoted: classified promote AND not covered globally. */
	promotable: WrapupItem[];
	/** Items classified promote but blocked by the deterministic guard, with why. */
	skipped: { key: string; reason: string }[];
}

/**
 * Apply-time deterministic guard: re-check every promote verdict against the
 * global store right before it lands. The LLM classification may be stale
 * (a gate ran while assessing) or wrong; this ensures a promote never writes
 * a duplicate, project-scoped, or too-thin global entry. Pure and unit-tested.
 *
 * Guards (2026-08-22 promotion policy):
 * - audited candidate list + title coverage (pre-existing),
 * - project-scoped content markers (absolute paths / session ids) — the
 *   global store is shared across projects and must stay portable,
 * - thin content below the policy floor (framing outweighs the fact),
 * - near-duplicate of an existing global entry by content overlap.
 */
export function filterPromotable(
	items: readonly WrapupItem[],
	globalState: HarnessState,
	candidates: readonly WrapupCandidate[],
	policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
): PromotableSplit {
	const byKey = new Map(candidates.map((candidate) => [candidateKey(candidate.kind, candidate.id), candidate]));
	const promotable: WrapupItem[] = [];
	const skipped: { key: string; reason: string }[] = [];
	for (const item of items) {
		if (item.verdict !== "promote") continue;
		const candidate = byKey.get(item.key);
		if (!candidate) {
			skipped.push({ key: item.key, reason: "not in the audited candidate list" });
			continue;
		}
		if (candidate.coveredGlobally || globalCoverageDetected(globalState, candidate.kind, candidate)) {
			skipped.push({ key: item.key, reason: "already covered globally" });
			continue;
		}
		if (candidate.kind === "memory" && !isMemoryType(candidate.metadata[MEMORY_TYPE_KEY])) {
			skipped.push({
				key: item.key,
				reason: `memory has no recall type (metadata.${MEMORY_TYPE_KEY} one of user|feedback|project|reference) — update the local entry to classify it first, then promote`,
			});
			continue;
		}
		const scoped = projectScopedReason(`${candidate.title}\n${candidate.content}`, policy);
		if (scoped) {
			skipped.push({ key: item.key, reason: scoped });
			continue;
		}
		// Metadata screens too: wholePromoteProposals copies candidate.metadata
		// verbatim into the global entry, so a credential planted in local
		// metadata must not ride the promotion path into the shared store
		// (review audit 2026-08-28 B2).
		const secret = secretLeakReason(
			[candidate.title, candidate.content, JSON.stringify(candidate.metadata ?? {})].join("\n"),
		);
		if (secret) {
			skipped.push({ key: item.key, reason: secret });
			continue;
		}
		if (candidate.content.length < policy.minPromoteChars) {
			skipped.push({
				key: item.key,
				reason: `too thin to promote (${candidate.content.length} < ${policy.minPromoteChars} chars) — keep local or merge`,
			});
			continue;
		}
		const similar = mostSimilarGlobalEntry(globalState, candidate.kind, candidate.title, candidate.content, policy);
		if (similar) {
			skipped.push({
				key: item.key,
				reason: `near-duplicate of global ${candidate.kind}:${similar.id} "${similar.title}" (overlap ${similar.score.toFixed(2)}) — update that entry instead`,
			});
			continue;
		}
		promotable.push(item);
	}
	return { promotable, skipped };
}

export interface ArchiveReviewSplit {
	/** Archives that may proceed silently: topic already covered, no real
	 * distillation source, or the archive half of an already-approved split. */
	silent: WrapupItem[];
	/**
	 * Archives that would bury possibly-reusable content: not covered
	 * globally AND distilled from real user messages (sourceSeqs present).
	 * These MAY NOT archive silently — the command must get user
	 * confirmation first (the symmetric guard to filterPromotable: it stops
	 * over-archiving, not just over-writing).
	 */
	review: WrapupItem[];
}

/**
 * The symmetric archive guard. `filterPromotable` is one-directional: it
 * stops the model from WRITING duplicate global entries, but nothing stopped
 * an unfounded ARCHIVE from hiding content that was actually only local.
 * Guard criteria: an archive needs user confirmation when it is NOT covered
 * globally AND the entry carries a real distillation source (sourceSeqs /
 * sourceSession — i.e. it was distilled from actual user messages, so it
 * may hold reusable value). Operational/empty entries archive silently as
 * before. Split archives (archive + promote sub-object) skip this check:
 * their promotion already crosses a human approval gate, so the archive is
 * the completion of an approved action, not a silent burial.
 */
export function needsArchiveReview(item: WrapupItem, candidate: WrapupCandidate): boolean {
	if (item.verdict !== "archive") return false;
	if (item.promote) return false;
	if (candidate.coveredGlobally) return false;
	const seqs = candidate.metadata[SOURCE_SEQS_KEY];
	const session = candidate.metadata[SOURCE_SESSION_KEY];
	return (Array.isArray(seqs) && seqs.length > 0) || (typeof session === "string" && session.length > 0);
}

/** Partition archive items into silent vs review-required (see needsArchiveReview). */
export function splitArchiveGuards(items: readonly WrapupItem[], candidates: readonly WrapupCandidate[]): ArchiveReviewSplit {
	const byKey = new Map(candidates.map((candidate) => [candidateKey(candidate.kind, candidate.id), candidate]));
	const silent: WrapupItem[] = [];
	const review: WrapupItem[] = [];
	for (const item of items) {
		if (item.verdict !== "archive") continue;
		const candidate = byKey.get(item.key);
		if (candidate && needsArchiveReview(item, candidate)) {
			review.push(item);
		} else {
			silent.push(item);
		}
	}
	return { silent, review };
}

/**
 * Apply-time guard for a split promotion (archive + promote sub-object):
 * the cleaned payload must pass the same promotion policy as a whole
 * promote — no global coverage duplicate, no project-scoped content, not
 * too thin, no near-duplicate global entry. A blocked split is dropped (the
 * entry still archives plain) rather than half-promoting a redundancy.
 */
export function splitPromoteBlocked(
	item: WrapupItem,
	globalState: HarnessState,
	kind: RefinementKind,
	policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
	candidateMetadata?: Record<string, unknown>,
): string | undefined {
	if (!item.promote) return "no split payload";
	if (kind === "memory" && !isMemoryType(candidateMetadata?.[MEMORY_TYPE_KEY])) {
		return `split promotion needs the source entry classified (metadata.${MEMORY_TYPE_KEY} one of user|feedback|project|reference) — update it first`;
	}
	if (globalCoverageDetected(globalState, kind, { id: "", title: item.promote.title })) {
		return "split promotion duplicates a globally covered topic";
	}
	const scoped = projectScopedReason(`${item.promote.title}\n${item.promote.content}`, policy);
	if (scoped) return `split promotion is ${scoped}`;
	const secret = secretLeakReason([item.promote.title, item.promote.content].join("\n"));
	if (secret) return `split promotion blocked: ${secret}`;
	if (item.promote.content.length < policy.minPromoteChars) {
		return `split promotion too thin (${item.promote.content.length} < ${policy.minPromoteChars} chars)`;
	}
	const similar = mostSimilarGlobalEntry(globalState, kind, item.promote.title, item.promote.content, policy);
	if (similar) {
		return `split promotion near-duplicates global ${kind}:${similar.id} "${similar.title}" (overlap ${similar.score.toFixed(2)})`;
	}
	return undefined;
}

/**
 * Shared proposal builders for a WHOLE promotion — used by both the
 * `/evolve wrapup` command and the gate's local-fate dimension so the two
 * paths apply IDENTICAL edits (global create + local retirement stamp).
 *
 * The local stamp is a factory: the `promotedTo` id is only known after the
 * global create lands (validation may slugify the id), so the caller applies
 * the global proposal first and stamps the local copy with the created id.
 */
export function wholePromoteProposals(
	item: WrapupItem,
	candidate: WrapupCandidate,
	sessionId: string,
): { global: RefinementProposal; localStamp: (createdId: string) => RefinementProposal } {
	const now = new Date().toISOString();
	return {
		global: {
			summary: `wrapup: promote local ${item.key} to the global store`,
			rationale: item.reason,
			expectedOutcome: `The entry is now visible to every session via the global store (sourcedFromLocal=${sessionId}:${candidate.id}).`,
			edits: [
				{
					action: "create",
					kind: candidate.kind,
					id: candidate.id,
					title: candidate.title,
					content: candidate.content,
					path: candidate.path,
					metadata: {
						...candidate.metadata,
						[SOURCED_FROM_KEY]: `${sessionId}:${candidate.id}`,
						[PROMOTED_AT_KEY]: now,
					},
				},
			],
		},
		localStamp: (createdId) => ({
			summary: `wrapup: stamp local ${item.key} as promoted to ${createdId} and retire it from injection`,
			rationale: item.reason,
			expectedOutcome: `The local copy keeps its data but stops being injected; the global copy is the live one.`,
			edits: [
				{
					action: "update",
					kind: candidate.kind,
					id: candidate.id,
					title: candidate.title,
					content: candidate.content,
					metadata: {
						...candidate.metadata,
						[PROMOTED_TO_KEY]: createdId,
						[PROMOTED_AT_KEY]: now,
						[ARCHIVED_AT_KEY]: now,
					},
				},
			],
		}),
	};
}

/**
 * Shared proposal builders for a SPLIT promotion (A-form): archive a mixed
 * local entry but promote ONLY the cleaned durable part the model extracted.
 * Same usage contract as {@link wholePromoteProposals}: apply the global
 * create, then stamp the original local entry with the created id.
 */
export function splitPromoteProposals(
	item: WrapupItem,
	candidate: WrapupCandidate,
	sessionId: string,
): { global: RefinementProposal; localStamp: (createdId: string) => RefinementProposal } {
	if (!item.promote) throw new Error("split promote proposals require a promote payload");
	const now = new Date().toISOString();
	return {
		global: {
			summary: `wrapup: split — promote cleaned part of ${item.key} to the global store`,
			rationale: item.reason,
			expectedOutcome: `Only the durable part becomes visible globally; the snapshot half stays archived with the original.`,
			edits: [
				{
					action: "create",
					kind: candidate.kind,
					id: candidate.id,
					title: item.promote.title,
					content: item.promote.content,
					path: candidate.path,
					metadata: {
						...candidate.metadata,
						[SOURCED_FROM_KEY]: `${sessionId}:${candidate.id}`,
						[PROMOTED_AT_KEY]: now,
					},
				},
			],
		},
		localStamp: (createdId) => ({
			summary: `wrapup: split — archive original ${item.key}, stamped as promoted to ${createdId}`,
			rationale: item.reason,
			expectedOutcome: `The original leaves injection (data kept, restorable); the cleaned global copy is the live one.`,
			edits: [
				{
					action: "update",
					kind: candidate.kind,
					id: candidate.id,
					title: candidate.title,
					content: candidate.content,
					metadata: {
						...candidate.metadata,
						[PROMOTED_TO_KEY]: createdId,
						[PROMOTED_AT_KEY]: now,
						[ARCHIVED_AT_KEY]: now,
					},
				},
			],
		}),
	};
}

/**
 * Valence stamp (P1 效价反馈): a keep-verdict item the assessor marked
 * contradicted gets its negative-valence counter bumped — the entry stays
 * live but sinks in injection ranking and the next assessment prefers
 * archiving it. Promotes pass untouched (the human-approved global copy is
 * the live truth); archives don't need the stamp (they already leave
 * injection). Undefined when nothing applies.
 */
export function valenceStampProposal(item: WrapupItem, candidate: WrapupCandidate): RefinementProposal | undefined {
	if (item.verdict !== "keep" || !item.contradicted) return undefined;
	return {
		summary: `wrapup: stamp contradicted valence on ${item.key} (${candidate.negativeCount + 1})`,
		rationale: item.reason,
		expectedOutcome:
			"The entry's negative-valence counter rises; injection downranks it and the next assessment prefers archiving it.",
		edits: [
			{
				action: "update",
				kind: candidate.kind,
				id: candidate.id,
				title: candidate.title,
				content: candidate.content,
				metadata: { ...candidate.metadata, [VALENCE_NEGATIVE_KEY]: candidate.negativeCount + 1 },
			},
		],
	};
}
