/**
 * Promotion policy: mechanical, code-enforced gates that decide whether a
 * local entry MAY be promoted to the cross-session global store ("模型提议，
 * 代码保证"). The LLM classification proposes; these guards dispose.
 *
 * Rationale (2026-08-22 store audit): the global store is shared by every
 * project on one profile, so promoting project-scoped knowledge taxes every
 * future session in every project. Measured failure modes:
 * - absolute paths / session ids in promoted content (project-scoped),
 * - near-duplicates of existing global entries re-promoted from later
 *   sessions (title matching alone missed them),
 * - one-line facts whose framing costs more than their content.
 *
 * Pure functions only — the callers (wrapup command, gate local-fate phase)
 * supply the resolved {@link PromotionPolicy}.
 */
import type { HarnessEntry, HarnessState, RefinementKind } from "./types.js";
import { isArchived } from "./types.js";

/** Regex sources that mark content as project-scoped (never global). */
const DEFAULT_BLOCK_PATTERNS: readonly string[] = [
	String.raw`\/(?:mnt|home|Users)\/`, // absolute POSIX paths: "/home/…", "/mnt/…", "/Users/…"
	String.raw`\bsession-[0-9a-f]{8}\b`, // session-scoped identifiers
	String.raw`~/\.dsh\b`, // user harness home references
];

export interface PromotionPolicy {
	/** Content matching any pattern is project-scoped and stays local. */
	blockPatterns: RegExp[];
	/** Whole promotions below this content length stay local (chars). */
	minPromoteChars: number;
	/** Content overlap above this against a global entry = duplicate. */
	maxContentOverlap: number;
}

export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = {
	blockPatterns: DEFAULT_BLOCK_PATTERNS.map((source) => new RegExp(source, "i")),
	minPromoteChars: 100,
	maxContentOverlap: 0.6,
};

/**
 * Write-time conflict guard (R2): a global create whose similarity against an
 * existing same-kind entry reaches this score is rejected outright — a
 * near-duplicate adds zero information and the model should evolve_update
 * the existing entry instead.
 */
export const CONFLICT_BLOCK_SCORE = 0.8;

/** Similarity at/above this stamps {@link CONFLICT_HINT_KEY} but lets the write proceed. */
export const CONFLICT_WARN_SCORE = 0.5;

/**
 * Build a policy from config values (schemastery strings compiled here so
 * the config layer never touches RegExp). Invalid patterns are skipped —
 * a broken user pattern must not disable the remaining guards.
 */
export function resolvePromotionPolicy(options: {
	blockPatterns?: readonly string[] | undefined;
	minPromoteChars?: number | undefined;
	maxContentOverlap?: number | undefined;
}): PromotionPolicy {
	const patterns = [...(options.blockPatterns ?? [])]
		.map((source) => {
			try {
				return new RegExp(source, "i");
			} catch {
				return undefined;
			}
		})
		.filter((pattern): pattern is RegExp => pattern !== undefined);
	return {
		blockPatterns: patterns.length > 0 ? patterns : DEFAULT_PROMOTION_POLICY.blockPatterns,
		minPromoteChars: options.minPromoteChars ?? DEFAULT_PROMOTION_POLICY.minPromoteChars,
		maxContentOverlap: options.maxContentOverlap ?? DEFAULT_PROMOTION_POLICY.maxContentOverlap,
	};
}

/**
 * First reason the content reads as project-scoped, or undefined when it
 * looks portable. Returns the matched pattern source so skip reports stay
 * explainable in reviews.jsonl rationales.
 */
export function projectScopedReason(content: string, policy: PromotionPolicy): string | undefined {
	for (const pattern of policy.blockPatterns) {
		if (pattern.test(content)) {
			return `project-scoped content (matches /${pattern.source}/)`;
		}
	}
	return undefined;
}

/**
 * Tokenize for cheap similarity: ASCII words plus CJK character bigrams
 * (single CJK chars are too ambiguous; bigrams survive segmentation-free
 * Chinese text). Lowercased; single-char ASCII tokens dropped as noise.
 */
export function normalizedTokens(text: string): Set<string> {
	const lowered = text.toLowerCase();
	const tokens = new Set<string>();
	for (const match of lowered.matchAll(/[a-z0-9_]{2,}/g)) {
		tokens.add(match[0] ?? "");
	}
	let previous: string | undefined;
	for (const match of lowered.matchAll(/[\u3400-\u9fff]/g)) {
		const char = match[0] ?? "";
		if (previous !== undefined) {
			tokens.add(`${previous}${char}`);
		}
		previous = char;
	}
	tokens.delete("");
	return tokens;
}

/** Jaccard similarity of two texts' normalized token sets (0..1). */
export function contentOverlap(a: string, b: string): number {
	const left = normalizedTokens(a);
	const right = normalizedTokens(b);
	if (left.size === 0 || right.size === 0) {
		return 0;
	}
	let intersection = 0;
	for (const token of left) {
		if (right.has(token)) {
			intersection += 1;
		}
	}
	return intersection / (left.size + right.size - intersection);
}

export interface SimilarEntryHit {
	id: string;
	title: string;
	score: number;
}

/**
 * Human/LLM-readable description of a similarity hit, shared by the block
 * error and the approval-question suffix so both surfaces explain the same
 * way.
 */
export function buildConflictNotice(hit: SimilarEntryHit): string {
	return `near-duplicate of ${hit.id} 「${hit.title}」 (similarity ${Math.round(hit.score * 100)}%)`;
}

/**
 * The most similar entry of the list, above `minScore`. Title and content
 * both feed the comparison (titles are short; content carries the real
 * signal). Generic form of {@link mostSimilarGlobalEntry} — callers decide
 * which corpus (global store, merged view) the candidates come from.
 */
export function mostSimilarEntry(
	entries: readonly HarnessEntry[],
	title: string,
	content: string,
	minScore: number,
): SimilarEntryHit | undefined {
	let best: SimilarEntryHit | undefined;
	for (const other of entries) {
		if (isArchived(other)) continue;
		const score = Math.max(contentOverlap(title, other.title), contentOverlap(content, other.content));
		if (score >= minScore && (best === undefined || score > best.score)) {
			best = { id: other.id, title: other.title, score };
		}
	}
	return best;
}

/**
 * The most similar non-archived global entry of the same kind, above the
 * policy threshold.
 */
export function mostSimilarGlobalEntry(
	globalState: HarnessState,
	kind: RefinementKind,
	title: string,
	content: string,
	policy: PromotionPolicy,
): SimilarEntryHit | undefined {
	return mostSimilarEntry(Object.values(globalState.entries[kind]), title, content, policy.maxContentOverlap);
}
