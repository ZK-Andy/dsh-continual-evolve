/**
 * Failure-signature aggregation (gap R/D1 — observation stage): turn the
 * free-text failure records the system already produces (review-gate failures
 * in reviews.jsonl, failed cells in benchmark scoreboards) into a structured
 * count by failure CLASS. This is deliberately NOT the full failure-signature
 * Refiner from gap D1 — no routing, no policy — it is the data layer that
 * lets a later patch decide whether a given failure class recurs often enough
 * to deserve one.
 *
 * Classes are extracted with pure prefix rules (see classifyFailure), so the
 * aggregation is deterministic and unit-testable: the same failure text
 * always lands in the same class.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface FailureRecord {
	/** When the failure was recorded (ISO). Unknown for aggregated benchmark cells without timestamps. */
	timestamp?: string;
	/** Where the failure came from: "review-gate" | "benchmark:<bid>:<caseId>". */
	source: string;
	/** Failure class (see classifyFailure). */
	kind: string;
	/** The original failure text (notes or rationale). */
	message: string;
}

export interface FailureSummary {
	total: number;
	/** Count per failure class, sorted descending (most frequent first). */
	byKind: Record<string, number>;
	/** Count per source (gate vs benchmark:bid). */
	bySource: Record<string, number>;
}

/**
 * Classify a failure message by prefix rules. Deterministic and additive:
 * unknown text falls into "other" so the summary never drops a failure.
 */
export function classifyFailure(message: string): string {
	const text = (message ?? "").trim();
	const lower = text.toLowerCase();
	if (lower.includes("rubric decrypt failed")) return "rubric-decrypt";
	if (lower.includes("materials changed")) return "material-drift";
	if (lower.includes("executor failed") || lower.includes("executor stopped")) return "executor";
	if (lower.includes("reviewer failed") || lower.includes("reviewer stopped")) return "reviewer";
	if (lower.includes("fate assessment error")) return "fate-assessor";
	if (lower.includes("trajectory unavailable")) return "trajectory";
	if (lower.includes("output budget exhausted") || lower.includes("max-tokens")) return "max-tokens";
	if (lower.includes("llm call aborted") || lower.includes("aborted")) return "aborted";
	if (lower.includes("llm call failed")) return "llm";
	if (lower.includes("gate error")) return "gate";
	if (lower.includes("casecheck") || lower.includes("case check")) return "casecheck";
	return "other";
}

/** Aggregate a record list into counts. Empty input yields an all-zero summary. */
export function summarizeFailures(records: readonly FailureRecord[]): FailureSummary {
	const byKind: Record<string, number> = {};
	const bySource: Record<string, number> = {};
	for (const record of records) {
		byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
		bySource[record.source] = (bySource[record.source] ?? 0) + 1;
	}
	return {
		total: records.length,
		byKind: Object.fromEntries(Object.entries(byKind).sort((a, b) => b[1] - a[1])),
		bySource: Object.fromEntries(Object.entries(bySource).sort((a, b) => b[1] - a[1])),
	};
}

/**
 * Read failed review-gate records from `<baseDir>/evolve/reviews.jsonl`
 * (outcome === "failed"). Tolerant of a missing/corrupt file.
 */
export function readReviewFailures(baseDir: string): FailureRecord[] {
	const path = join(baseDir, "evolve", "reviews.jsonl");
	if (!existsSync(path)) return [];
	const records: FailureRecord[] = [];
	try {
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				const raw = JSON.parse(line) as { timestamp?: string; sessionId?: string; reason?: string; outcome?: string; rationale?: string };
				if (raw.outcome !== "failed" || !raw.rationale) continue;
				records.push({
					...(raw.timestamp ? { timestamp: raw.timestamp } : {}),
					source: `review-gate${raw.reason ? `:${raw.reason}` : ""}`,
					kind: classifyFailure(raw.rationale),
					message: raw.rationale,
				});
			} catch {
				// skip malformed lines — the audit file must never break reporting
			}
		}
	} catch {
		return [];
	}
	return records;
}

/**
 * Read failed cells from every benchmark scoreboard under
 * `<baseDir>/evolve/benchmarks/<bid>/`. Tolerant of missing/corrupt data.
 */
export function readBenchmarkFailures(baseDir: string): FailureRecord[] {
	const root = join(baseDir, "evolve", "benchmarks");
	if (!existsSync(root)) return [];
	const records: FailureRecord[] = [];
	let bids: string[];
	try {
		bids = readdirSync(root);
	} catch {
		return [];
	}
	for (const bid of bids) {
		const boardPath = join(root, bid, "scoreboard.json");
		if (!existsSync(boardPath)) continue;
		let board: { reference?: { cells?: unknown[] }; candidates?: { label?: string; cells?: unknown[] }[] };
		try {
			board = JSON.parse(readFileSync(boardPath, "utf8")) as typeof board;
		} catch {
			continue;
		}
		const cellLists: { label: string; cells: unknown[] }[] = [];
		if (board.reference?.cells) cellLists.push({ label: "reference", cells: board.reference.cells });
		for (const entry of board.candidates ?? []) {
			if (entry.cells) cellLists.push({ label: entry.label ?? "candidate", cells: entry.cells });
		}
		for (const list of cellLists) {
			for (const cell of list.cells) {
				const c = cell as { caseId?: string; status?: string; notes?: string };
				if (c.status !== "failed" || !c.notes) continue;
				records.push({
					source: `benchmark:${bid}:${c.caseId ?? "?"}`,
					kind: classifyFailure(c.notes),
					message: c.notes,
				});
			}
		}
	}
	return records;
}

/** Combine both sources into one summary. */
export function collectFailureSummary(baseDir: string): { summary: FailureSummary; records: FailureRecord[] } {
	const records = [...readReviewFailures(baseDir), ...readBenchmarkFailures(baseDir)];
	return { summary: summarizeFailures(records), records };
}

/** Human-readable report for the command line. */
export function formatFailureSummary(summary: FailureSummary): string {
	const lines = [`failure summary: ${summary.total} total`];
	const kinds = Object.entries(summary.byKind);
	if (kinds.length > 0) {
		lines.push("by class:");
		for (const [kind, count] of kinds) {
			lines.push(`  ${kind}: ${count}`);
		}
	} else {
		lines.push("by class: (none)");
	}
	const sources = Object.entries(summary.bySource);
	if (sources.length > 0) {
		lines.push("by source:");
		for (const [source, count] of sources) {
			lines.push(`  ${source}: ${count}`);
		}
	}
	return lines.join("\n");
}