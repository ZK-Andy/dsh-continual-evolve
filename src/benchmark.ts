/**
 * Benchmark store: file-backed case definitions and scoreboards under
 * `<baseDir>/evolve/benchmarks/<bid>/`.
 *
 * Layout:
 *   benchmark.json          title, runs (repeats per case), passThreshold
 *   cases/<cid>/statement.md   public task text
 *   cases/<cid>/rubric.json    encrypted scoring criteria (AES-256-GCM, see src/rubric.ts)
 *   scoreboard.json         code-owned aggregates + acceptance history
 *
 * Rubric isolation is code-enforced: rubric plaintext never reaches the
 * disk. Only the evaluation runner decrypts (into the child prompt); the
 * optimizer can read the file and sees ciphertext only. Legacy files that
 * predate encryption carry plaintext and are still readable.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encryptRubric, DEV_RUBRIC_KEY, deriveKey } from "./rubric.js";
import type { EvolutionEngine } from "./service.js";

export interface BenchmarkCase {
	id: string;
	title: string;
	statement: string;
	rubric: string;
}

export interface BenchmarkDefinition {
	id: string;
	title: string;
	description: string;
	runs: number;
	passThreshold: number;
	createdAt: string;
}

export interface CellScore {
	caseId: string;
	run: number;
	/**
	 * Failure-cell protocol (gap A2): "ok" = a real score; "failed" = the
	 * unit could not produce one (rubric decrypt error, child crash, protocol
	 * error). A failed cell is NOT a zero — aggregation excludes it and
	 * counts it, and the acceptance rule rejects a round with more failures
	 * than the threshold instead of silently averaging a 0 into the mean.
	 */
	status: "ok" | "failed";
	score: number;
	passed: boolean;
	notes: string;
	/**
	 * Trace evidence pointer (gap A4): the executor child's session id whose
	 * transcript produced this cell's evidence — the score can be drilled
	 * back to the exact session steps that earned it.
	 */
	sessionId?: string;
	/**
	 * Runtime evidence verification (gap A3): the actual provider and model
	 * used by the executor subagent — written from the host (not the model),
	 * so it reflects reality. A mismatch with the expected route flags the
	 * cell as failed (version_changed semantics).
	 */
	provider?: string;
	model?: string;
	/**
	 * Material hash: SHA-256 prefix of the case statement + rubric envelope,
	 * so a material change between reference and candidate runs is detectable.
	 * absence means pre-A3 cell (backward compatible).
	 */
	caseHash?: string;
}

export interface EvaluationEntry {
	label: string;
	refinementId?: string;
	createdAt: string;
	cells: CellScore[];
	/** Code-owned aggregates (model never writes these). */
	aggregate: Record<string, number | null>;
	overall: number | null;
}

export interface Scoreboard {
	reference?: EvaluationEntry;
	candidates: EvaluationEntry[];
	decisions: { candidateLabel: string; refinementId?: string; accepted: boolean; reasons: string[]; createdAt: string }[];
}

export interface AutoRollbackOutcome {
	rolledBack: boolean;
	message: string;
}

/**
 * Close the acceptance loop: when the code-owned decision rejects a
 * candidate refinement, revert it deterministically. The rollback is the
 * same engine path as `/evolve rollback` (inverse edits rebuilt from the
 * applied result — no LLM re-guessing), so it snapshots, versions, and
 * audits like any other mutation. Failures (e.g. the refinement belongs to
 * another session's history) are reported, never thrown: the command shows
 * the manual fallback instead.
 */
export function rollbackRejectedCandidate(
	engine: EvolutionEngine,
	sessionId: string | undefined,
	candidateId: string,
): AutoRollbackOutcome {
	try {
		const result = engine.rollback("local", sessionId, candidateId);
		const applied = result.appliedEdits.filter((edit) => edit.applied).length;
		return {
			rolledBack: true,
			message: `auto-rollback: reverted refinement ${candidateId} — ${applied} edits restored to the pre-refinement snapshot`,
		};
	} catch (cause) {
		return {
			rolledBack: false,
			message: `auto-rollback failed: ${cause instanceof Error ? cause.message : String(cause)} — roll back manually with /evolve rollback <${candidateId}>`,
		};
	}
}

export function benchmarkDir(baseDir: string, bid: string): string {
	return join(baseDir, "evolve", "benchmarks", bid);
}

export function sanitizeId(raw: string): string {
	const id = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
	if (!id) {
		throw new Error("benchmark id must be a non-empty slug");
	}
	return id;
}

export function createBenchmark(
	baseDir: string,
	opts: { title: string; description?: string; runs?: number; passThreshold?: number },
): BenchmarkDefinition {
	const id = sanitizeId(opts.title);
	const dir = benchmarkDir(baseDir, id);
	if (existsSync(dir)) {
		throw new Error(`benchmark ${id} already exists`);
	}
	const definition: BenchmarkDefinition = {
		id,
		title: opts.title.trim(),
		description: opts.description?.trim() ?? "",
		runs: opts.runs ?? 1,
		passThreshold: opts.passThreshold ?? 60,
		createdAt: new Date().toISOString(),
	};
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "benchmark.json"), `${JSON.stringify(definition, null, 2)}\n`, "utf8");
	writeFileSync(join(dir, "scoreboard.json"), `${JSON.stringify({ candidates: [], decisions: [] }, null, 2)}\n`, "utf8");
	return definition;
}

export function listBenchmarks(baseDir: string): BenchmarkDefinition[] {
	const root = join(baseDir, "evolve", "benchmarks");
	if (!existsSync(root)) return [];
	return readdirSafe(root)
		.map((id) => loadBenchmark(baseDir, id))
		.filter((b): b is BenchmarkDefinition => b !== undefined);
}

export function loadBenchmark(baseDir: string, bid: string): BenchmarkDefinition | undefined {
	const path = join(benchmarkDir(baseDir, bid), "benchmark.json");
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as BenchmarkDefinition;
	} catch {
		return undefined;
	}
}

export function addCase(baseDir: string, bid: string, title: string, statement: string, rubric: string, rubricKey?: Buffer): BenchmarkCase {
	const definition = loadBenchmark(baseDir, bid);
	if (!definition) {
		throw new Error(`benchmark ${bid} not found`);
	}
	const id = sanitizeId(title);
	const caseDir = join(benchmarkDir(baseDir, bid), "cases", id);
	if (existsSync(caseDir)) {
		throw new Error(`case ${id} already exists in ${bid}`);
	}
	mkdirSync(caseDir, { recursive: true });
	writeFileSync(join(caseDir, "statement.md"), statement, "utf8");
	// Rubric plaintext never touches the disk; callers pass a resolved key
	// (config → env → per-installation key file → dev fallback, see
	// resolveRubricKey) and the dev key here is only a defensive last resort.
	const stored = rubricKey ? encryptRubric(rubric, rubricKey) : encryptRubric(rubric, deriveKey(DEV_RUBRIC_KEY));
	writeFileSync(join(caseDir, "rubric.json"), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
	return { id, title: title.trim(), statement, rubric };
}

export function listCases(baseDir: string, bid: string): BenchmarkCase[] {
	const casesDir = join(benchmarkDir(baseDir, bid), "cases");
	if (!existsSync(casesDir)) return [];
	return readdirSafe(casesDir)
		.map((id) => {
			const statementPath = join(casesDir, id, "statement.md");
			const rubricPath = join(casesDir, id, "rubric.json");
			if (!existsSync(statementPath) || !existsSync(rubricPath)) return undefined;
			try {
				const statement = readFileSync(statementPath, "utf8");
				const rubric = JSON.parse(readFileSync(rubricPath, "utf8")) as string;
				return { id, title: id, statement, rubric } satisfies BenchmarkCase;
			} catch {
				return undefined;
			}
		})
		.filter((c): c is BenchmarkCase => c !== undefined);
}

export function loadScoreboard(baseDir: string, bid: string): Scoreboard {
	const path = join(benchmarkDir(baseDir, bid), "scoreboard.json");
	if (!existsSync(path)) {
		return { candidates: [], decisions: [] };
	}
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Scoreboard>;
		return {
			...(raw.reference ? { reference: raw.reference } : {}),
			candidates: raw.candidates ?? [],
			decisions: raw.decisions ?? [],
		};
	} catch {
		return { candidates: [], decisions: [] };
	}
}

export function saveScoreboard(baseDir: string, bid: string, board: Scoreboard): void {
	writeFileSync(join(benchmarkDir(baseDir, bid), "scoreboard.json"), `${JSON.stringify(board, null, 2)}\n`, "utf8");
}

export function removeBenchmark(baseDir: string, bid: string): void {
	const dir = benchmarkDir(baseDir, bid);
	if (existsSync(dir)) {
		rmSync(dir, { recursive: true, force: true });
	}
}

import { readdirSync } from "node:fs";
function readdirSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}
