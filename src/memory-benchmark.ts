/**
 * Memory-specific extraction benchmark (P1): deterministic scoring of one
 * memory proposal against a labeled reference.
 *
 * Unlike the harness benchmark (which runs subagents against rubrics), this
 * module scores a proposal's SHAPE without any model call: precision and
 * recall over reference facts, duplicate creates (update-first violations),
 * stale operations (re-proposing outdated facts, or removing live ones), and
 * noise (unmatched or exclusion-list material). Suite authors hand-build
 * small references plus transcripts; the extraction loop under test produces
 * the proposal, this module grades it.
 *
 * Matching is phrase-substring based (case-insensitive): a reference fact
 * lists must-contain phrases, and a proposed edit matches when its title
 * plus content carry every phrase. Deliberately mechanical — the benchmark
 * measures extraction coverage, not paraphrase quality.
 */
import { CONFLICT_BLOCK_SCORE, mostSimilarEntry } from "./promotion.js";
import { isArchived } from "./types.js";
import type { HarnessEntry } from "./types.js";

/** One labeled fact the extractor should (or, when outdated, should not) produce. */
export interface MemoryBenchmarkFact {
	id: string;
	memoryType: string;
	/** Key phrases; an edit matches when its title+content carry every phrase. */
	mustContain: string[];
	/** Outdated facts must be avoided (create/update) or removed (archive/delete). */
	outdated?: boolean;
}

export interface MemoryBenchmarkReference {
	facts: MemoryBenchmarkFact[];
}

/** One proposed edit in the shape the memory loop emits. */
export interface MemoryBenchmarkEdit {
	action: "create" | "update" | "delete" | "archive";
	title?: string;
	content?: string;
	/** Target entry id for update/delete/archive. */
	id?: string;
}

export interface ScoredMemoryBenchmarkEdit {
	action: MemoryBenchmarkEdit["action"];
	matchedFactIds: string[];
	duplicateOf?: string;
	staleReason?: string;
	noisyReason?: string;
}

export interface MemoryBenchmarkScore {
	totalEdits: number;
	matchedFacts: number;
	precision: number;
	recall: number;
	duplicate: number;
	stale: number;
	noise: number;
	uncoveredFactIds: string[];
	edits: ScoredMemoryBenchmarkEdit[];
}

export interface MemoryGradeThresholds {
	minPrecision: number;
	minRecall: number;
	maxDuplicate: number;
	maxStale: number;
	maxNoise: number;
}

/** Strict-by-default gate: duplicates and stale operations never pass unnoticed. */
export const DEFAULT_MEMORY_GRADE_THRESHOLDS: MemoryGradeThresholds = {
	minPrecision: 0.7,
	minRecall: 0.7,
	maxDuplicate: 0,
	maxStale: 0,
	maxNoise: 0,
};

/**
 * v1 exclusion heuristics for noise ("不该记什么" in mechanical form):
 * git history, repo paths re-readable from disk, stack traces, and
 * explicitly temporary session state. Keep this list short and documented —
 * every pattern here is a precision/recall tradeoff, not ground truth.
 */
export const MEMORY_NOISE_PATTERNS: readonly RegExp[] = [
	/\bgit\s+(log|show|commit|diff)\b/i,
	/\bcommit\s+[0-9a-f]{5,40}\b/i,
	/\b[0-9a-f]{40}\b/,
	/(?:^|[\s("'])((?:src|lib|test|tests|docs|scripts)\/[A-Za-z0-9_./-]+\.[a-z]+)/,
	/\bat\s+[\w$.]+\s*\(.*:\d+:\d+\)/,
	/\b(temporary|one-off debugging|current task progress|in this session only)\b/i,
];

/** Content shorter than this is too thin to be a durable fact. */
export const MEMORY_MIN_FACT_CHARS = 30;

/**
 * Score one proposal against the reference and the pre-extraction manifest.
 *
 * @param reference Labeled facts (live + outdated).
 * @param edits The proposal's memory edits.
 * @param manifest Memory entries visible before extraction (duplicate source).
 * @returns Per-dimension counts plus a per-edit breakdown.
 */
export function scoreMemoryExtraction(
	reference: MemoryBenchmarkReference,
	edits: readonly MemoryBenchmarkEdit[],
	manifest: readonly HarnessEntry[],
): MemoryBenchmarkScore {
	const live = reference.facts.filter((fact) => !fact.outdated);
	const outdated = reference.facts.filter((fact) => fact.outdated);
	const liveMatched = new Set<string>();
	const outdatedHandled = new Set<string>();
	const scored: ScoredMemoryBenchmarkEdit[] = [];
	let duplicate = 0;
	let stale = 0;
	let noise = 0;

	for (const edit of edits) {
		const text = `${edit.title ?? ""}\n${edit.content ?? ""}`;
		const liveHits = live.filter((fact) => matchesFact(text, fact));
		const outdatedHits = outdated.filter((fact) => matchesFact(text, fact));
		const entry: ScoredMemoryBenchmarkEdit = { action: edit.action, matchedFactIds: [] };

		if (edit.action === "create" || edit.action === "update") {
			if (outdatedHits.length > 0) {
				stale += 1;
				entry.staleReason = `re-proposes outdated fact(s): ${outdatedHits.map((fact) => fact.id).join(",")}`;
			} else if (edit.action === "create") {
				const hit = mostSimilarEntry(
					manifest.filter((candidate) => candidate.kind === "memory"),
					edit.title ?? "",
					edit.content ?? "",
					CONFLICT_BLOCK_SCORE,
				);
				if (hit) {
					duplicate += 1;
					entry.duplicateOf = hit.id;
				} else if (liveHits.length > 0) {
					for (const fact of liveHits) {
						liveMatched.add(fact.id);
						entry.matchedFactIds.push(fact.id);
					}
				} else {
					noise += 1;
					entry.noisyReason = noiseReason(text);
				}
			} else if (liveHits.length > 0) {
				for (const fact of liveHits) {
					liveMatched.add(fact.id);
					entry.matchedFactIds.push(fact.id);
				}
			} else {
				noise += 1;
				entry.noisyReason = noiseReason(text);
			}
		} else {
			// delete/archive: correct only against outdated facts.
			const targetHits = [...liveHits, ...outdatedHits];
			const targetOutdated = outdatedHits.length > 0;
			const targetEntry = edit.id !== undefined ? manifest.find((candidate) => candidate.id === edit.id) : undefined;
			if (targetOutdated) {
				for (const fact of outdatedHits) {
					outdatedHandled.add(fact.id);
					entry.matchedFactIds.push(fact.id);
				}
			} else if (targetEntry !== undefined && isArchived(targetEntry)) {
				// Re-archiving an already archived entry is harmless housekeeping.
				entry.matchedFactIds.push(`archived:${targetEntry.id}`);
			} else if (targetHits.length > 0 || (targetEntry !== undefined && !isArchived(targetEntry))) {
				stale += 1;
				entry.staleReason = `removes live fact(s): ${targetHits.map((fact) => fact.id).join(",") || targetEntry?.id || "(unknown target)"}`;
			} else {
				noise += 1;
				entry.noisyReason = "removal matches no reference fact";
			}
		}
		scored.push(entry);
	}

	const total = edits.length;
	const preciseEdits = scored.filter((entry) => entry.matchedFactIds.length > 0).length;
	const precision = total === 0 ? 1 : preciseEdits / total;
	const recall = live.length === 0 ? 1 : liveMatched.size / live.length;
	return {
		totalEdits: total,
		matchedFacts: liveMatched.size + outdatedHandled.size,
		precision,
		recall,
		duplicate,
		stale,
		noise,
		uncoveredFactIds: live.filter((fact) => !liveMatched.has(fact.id)).map((fact) => fact.id),
		edits: scored,
	};
}

/**
 * Grade a score against explicit thresholds.
 *
 * @returns pass plus one failure line per violated dimension (empty when passing).
 */
export function gradeMemoryScore(score: MemoryBenchmarkScore, thresholds: MemoryGradeThresholds = DEFAULT_MEMORY_GRADE_THRESHOLDS): { pass: boolean; failures: string[] } {
	const failures: string[] = [];
	if (score.precision < thresholds.minPrecision) failures.push(`precision ${score.precision.toFixed(2)} < ${thresholds.minPrecision}`);
	if (score.recall < thresholds.minRecall) failures.push(`recall ${score.recall.toFixed(2)} < ${thresholds.minRecall}`);
	if (score.duplicate > thresholds.maxDuplicate) failures.push(`duplicate ${score.duplicate} > ${thresholds.maxDuplicate}`);
	if (score.stale > thresholds.maxStale) failures.push(`stale ${score.stale} > ${thresholds.maxStale}`);
	if (score.noise > thresholds.maxNoise) failures.push(`noise ${score.noise} > ${thresholds.maxNoise}`);
	return { pass: failures.length === 0, failures };
}

function matchesFact(text: string, fact: MemoryBenchmarkFact): boolean {
	const lowered = text.toLowerCase();
	return fact.mustContain.every((phrase) => lowered.includes(phrase.toLowerCase()));
}

function noiseReason(text: string): string {
	if (text.trim().length < MEMORY_MIN_FACT_CHARS) return `thin content (<${MEMORY_MIN_FACT_CHARS} chars)`;
	const hit = MEMORY_NOISE_PATTERNS.findIndex((pattern) => pattern.test(text));
	return hit >= 0 ? `matches exclusion pattern #${hit + 1}` : "matches no reference fact";
}
