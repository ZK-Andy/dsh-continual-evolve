/**
 * Auto-case capture (P1, 2026-08-28): failed evolution attempts become DRAFT
 * benchmark cases — regression assets for the benchmark loop instead of
 * discarded failure notes.
 *
 * Captures land in a dedicated container benchmark (auto-regression), NEVER
 * in a user benchmark: a benchmark run evaluates every case in its container
 * without a status filter, and an auto-case's rubric is a mechanical scaffold
 * that must never be scored. Humans promote a capture into a real benchmark
 * by re-authoring statement and rubric there, then casecheck → pilot →
 * freeze. The container benchmark keeps the staging area visible and
 * rollback-free (no engine involvement anywhere).
 *
 * No LLM call: the capture is deterministic. Callers own containment — a
 * failed capture must never break the trigger path (benchmark run, gate).
 */
import { addCase, createBenchmark, loadBenchmark } from "./benchmark.js";

/** The dedicated container benchmark every auto-case lands in (sanitizeId-safe). */
export const AUTO_CASE_BENCHMARK_ID = "auto_regression";

/** Which failed-evolution trigger produced the capture. */
export type AutoCaseSource = "benchmark_rejection" | "gate_no_consent";

export interface AutoCaseInput {
	baseDir: string;
	/**
	 * Resolved rubric key — captures must decrypt under the installation's
	 * real key. Omitting it silently encrypts with the dev fallback, making
	 * the scaffold unreadable to the real key; callers resolve once and pass.
	 */
	rubricKey?: Buffer | undefined;
	source: AutoCaseSource;
	sessionId?: string | undefined;
	/** One line for what was being attempted (candidate label / proposal summary). */
	summary: string;
	/** Machine-captured failure reasons (decision reasons / gate rationale). */
	reasons: readonly string[];
	/** Refinement id when the attempt produced one (e.g. a rolled-back candidate). */
	refinementId?: string | undefined;
	now?: number | undefined;
}

export interface AutoCaseCapture {
	bid: string;
	caseId: string;
}

/** Id-safe compact timestamp (20260828T131934000Z style), unique per capture. */
function idStamp(now: number): string {
	return new Date(now)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(".", "")
		.replace("Z", "Z");
}

/** The draft statement: a structured scaffold, not an evaluable task yet. */
export function renderAutoCaseStatement(input: AutoCaseInput, stamp: string): string {
	const lines = [
		"# Auto-generated regression scaffold",
		"",
		`- source: ${input.source}`,
		`- captured: ${stamp}`,
		`- session: ${input.sessionId ?? "(unknown)"}`,
		...(input.refinementId ? [`- refinement: ${input.refinementId}`] : []),
		`- attempted: ${input.summary}`,
		"- failure reasons:",
		...(input.reasons.length > 0 ? input.reasons.map((reason) => `  - ${reason}`) : ["  - (none captured)"]),
		"",
		"This case was captured mechanically from a failed evolution attempt.",
		"It lives in the auto-regression container and never enters a user",
		"benchmark automatically. To promote it: re-author the statement and",
		"rubric in a real benchmark, then casecheck → pilot → freeze.",
	];
	return `${lines.join("\n")}\n`;
}

/** The draft rubric: explicitly not scoreable until a human rewrites it. */
export function renderAutoCaseRubric(input: AutoCaseInput): string {
	return [
		"Draft scaffold — the real rubric is authored at calibration time.",
		`Scoring signal captured from the failure: ${input.reasons.join("; ") || "(none)"}.`,
		"Scoring against this scaffold is meaningless until a human rewrites it;",
		"the case stays in the auto-regression container and out of real runs.",
	].join("\n");
}

/**
 * Capture one failed evolution attempt as a draft case in the container
 * benchmark, creating the container on first use. Id uniqueness comes from
 * the millisecond stamp; two captures in the same millisecond throw (the
 * caller's containment turns that into a warning, never a lost trigger).
 */
export function captureAutoCase(input: AutoCaseInput): AutoCaseCapture {
	if (!loadBenchmark(input.baseDir, AUTO_CASE_BENCHMARK_ID)) {
		createBenchmark(input.baseDir, {
			title: AUTO_CASE_BENCHMARK_ID,
			description:
				"Draft regression scaffolds captured mechanically from failed evolution attempts. Not evaluated; promote captures into a real benchmark by hand (re-author statement/rubric, then casecheck → pilot → freeze).",
		});
	}
	const stamp = idStamp(input.now ?? Date.now());
	// Stamp first: sanitizeId truncates to 40 chars, and the stamp must
	// survive the truncation for per-millisecond capture uniqueness.
	const added = addCase(
		input.baseDir,
		AUTO_CASE_BENCHMARK_ID,
		`auto ${stamp} ${input.source}`,
		renderAutoCaseStatement(input, stamp),
		renderAutoCaseRubric(input),
		input.rubricKey,
	);
	return { bid: AUTO_CASE_BENCHMARK_ID, caseId: added.id };
}
