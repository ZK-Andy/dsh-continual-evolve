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
}

export const DEFAULT_AGGREGATE: AggregateOptions = { passThreshold: 60, regressionTolerance: 0 };

/** Aggregate raw cells into code-owned per-case means + overall mean. */
export function aggregate(cells: readonly CellScore[]): Record<string, number | null> & { overall: number | null } {
	const byCase = new Map<string, number[]>();
	for (const cell of cells) {
		const list = byCase.get(cell.caseId) ?? [];
		list.push(clampScore(cell.score));
		byCase.set(cell.caseId, list);
	}
	const perCase: Record<string, number> = {};
	for (const [caseId, scores] of byCase) {
		perCase[caseId] = mean(scores);
	}
	const all = [...byCase.values()].flat();
	return { ...perCase, overall: all.length > 0 ? mean(all) : null };
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

/**
 * Non-regressive acceptance rule (Self-Harness style):
 * the candidate is accepted iff its overall mean is STRICTLY higher than the
 * reference AND no case regresses by more than `regressionTolerance` points.
 */
export function decide(reference: EvaluationEntry, candidate: EvaluationEntry, opts: AggregateOptions): Decision {
	const reasons: string[] = [];
	if (reference.overall === null || candidate.overall === null) {
		return { accepted: false, reasons: ["reference or candidate evaluation is incomplete"] };
	}
	if (candidate.overall <= reference.overall) {
		reasons.push(`overall not improved: ${candidate.overall} <= ${reference.overall}`);
	}
	for (const [caseId, refScore] of Object.entries(reference.aggregate)) {
		if (caseId === "overall" || refScore === null) continue;
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
