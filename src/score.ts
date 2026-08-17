/**
 * Code-owned scoring: aggregation and acceptance decisions. The model only
 * produces per-cell raw scores; every average and every accept/reject call
 * happens here, in deterministic code.
 */
import type { CellScore, EvaluationEntry } from "./benchmark.js";

export interface AggregateOptions {
	/** A cell is "passed" if its raw score is at least this threshold. */
	passThreshold: number;
	/** Per-case regression tolerance: candidate may drop below reference by at most this much. */
	regressionTolerance: number;
	/**
	 * Failure-cell protocol (gap A2): a round with more failed cells than
	 * this is rejected outright — failed cells are NEVER averaged in as
	 * zeros. Default 0 (any failure rejects the round).
	 */
	maxFailedCells: number;
}

export const DEFAULT_AGGREGATE: AggregateOptions = {
	passThreshold: 60,
	regressionTolerance: 0,
	maxFailedCells: 0,
};

export interface AggregateResult extends Record<string, number | null> {
	overall: number | null;
	/** Count of failed cells (excluded from every mean). */
	failed: number;
	/** Total cells considered (ok + failed). */
	total: number;
}

/**
 * Aggregate raw cells into code-owned per-case means + overall mean.
 * Failure-cell protocol (gap A2): failed cells are EXCLUDED from means and
 * counted separately — a crashed unit can never silently drag the mean down
 * like a zero. A case whose cells all failed reports null (no mean).
 */
export function aggregate(cells: readonly CellScore[]): AggregateResult {
	const byCase = new Map<string, number[]>();
	let failed = 0;
	for (const cell of cells) {
		if (cell.status === "failed") {
			failed += 1;
			continue;
		}
		const list = byCase.get(cell.caseId) ?? [];
		list.push(clampScore(cell.score));
		byCase.set(cell.caseId, list);
	}
	const perCase: Record<string, number> = {};
	for (const [caseId, scores] of byCase) {
		perCase[caseId] = mean(scores);
	}
	const all = [...byCase.values()].flat();
	return {
		...perCase,
		overall: all.length > 0 ? mean(all) : null,
		failed,
		total: cells.length,
	};
}

export function entryFromCells(label: string, cells: readonly CellScore[], refinementId?: string): EvaluationEntry {
	const aggr = aggregate(cells);
	return {
		label,
		...(refinementId ? { refinementId } : {}),
		createdAt: new Date().toISOString(),
		cells: [...cells],
		aggregate: aggr,
		overall: aggr.overall,
	};
}

export interface Decision {
	accepted: boolean;
	reasons: string[];
}

/** Human-readable decision report with per-case before → after deltas. */
export function decisionReport(reference: EvaluationEntry, candidate: EvaluationEntry, decision: Decision): string[] {
	const lines: string[] = [`overall: ${reference.overall ?? "?"} → ${candidate.overall ?? "?"}`];
	for (const [caseId, refScore] of Object.entries(reference.aggregate)) {
		if (caseId === "overall" || caseId === "failed" || caseId === "total" || refScore === null) continue;
		const candScore = candidate.aggregate[caseId];
		const failedMark = isCaseFailed(reference, caseId) || isCaseFailed(candidate, caseId) ? " (failed)" : "";
		lines.push(`  ${caseId}: ${refScore} → ${candScore ?? "?"}${failedMark}`);
	}
	const refFailed = reference.aggregate.failed ?? 0;
	const candFailed = candidate.aggregate.failed ?? 0;
	if (refFailed > 0 || candFailed > 0) {
		lines.push(`failed cells: reference ${refFailed}/${reference.aggregate.total ?? 0} · candidate ${candFailed}/${candidate.aggregate.total ?? 0}`);
	}
	lines.push(
		decision.accepted
			? "DECISION: ACCEPTED — overall improved, no regression"
			: `DECISION: REJECTED — ${decision.reasons.join("; ")}`,
	);
	return lines;
}

function isCaseFailed(entry: EvaluationEntry, caseId: string): boolean {
	return entry.cells.some((cell) => cell.caseId === caseId && cell.status === "failed");
}

/**
 * Non-regressive acceptance rule (Self-Harness style):
 * the candidate is accepted iff its overall mean is STRICTLY higher than the
 * reference, no case regresses by more than `regressionTolerance` points,
 * and neither side has more failed cells than `maxFailedCells` (failure-cell
 * protocol, gap A2 — a partial/invalid round is never accepted).
 */
export function decide(reference: EvaluationEntry, candidate: EvaluationEntry, opts: AggregateOptions): Decision {
	const reasons: string[] = [];
	if (reference.overall === null || candidate.overall === null) {
		return { accepted: false, reasons: ["reference or candidate evaluation is incomplete"] };
	}
	const refFailed = reference.aggregate.failed ?? 0;
	const candFailed = candidate.aggregate.failed ?? 0;
	if (refFailed > opts.maxFailedCells) {
		reasons.push(`reference has ${refFailed} failed cells (max ${opts.maxFailedCells})`);
	}
	if (candFailed > opts.maxFailedCells) {
		reasons.push(`candidate has ${candFailed} failed cells (max ${opts.maxFailedCells})`);
	}
	if (reasons.length > 0) {
		return { accepted: false, reasons };
	}
	if (candidate.overall <= reference.overall) {
		reasons.push(`overall not improved: ${candidate.overall} <= ${reference.overall}`);
	}
	for (const [caseId, refScore] of Object.entries(reference.aggregate)) {
		if (caseId === "overall" || caseId === "failed" || caseId === "total" || refScore === null) continue;
		const candScore = candidate.aggregate[caseId];
		if (candScore === null || candScore === undefined) {
			reasons.push(`candidate missing case ${caseId}`);
			continue;
		}
		if (candScore < refScore - opts.regressionTolerance) {
			reasons.push(`case ${caseId} regressed: ${candScore} < ${refScore} - ${opts.regressionTolerance}`);
		}
	}
	return { accepted: reasons.length === 0, reasons };
}

function mean(values: number[]): number {
	const sum = values.reduce((acc, value) => acc + value, 0);
	return round2(sum / values.length);
}

function clampScore(score: number): number {
	if (!Number.isFinite(score)) return 0;
	return Math.min(100, Math.max(0, score));
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}
