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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encryptRubric, DEV_RUBRIC_KEY, deriveKey } from "./rubric.js";
import type { EvolutionEngine } from "./service.js";

export interface BenchmarkCase {
	id: string;
	title: string;
	statement: string;
	rubric: string;
	/**
	 * Case lifecycle state (gap A5): draft → calibrating → frozen.
	 * - draft: newly added, not yet quality-checked or calibrated
	 * - calibrating: pilot run in progress (case may be edited)
	 * - frozen: calibrated, locked as a formal baseline (immutable)
	 */
	status?: "draft" | "calibrating" | "frozen";
}

/**
 * Persistent per-case metadata (stored in `cases/<cid>/meta.json`).
 * Carries quality-gate annotations and calibration history.
 */
export interface CaseMeta {
	status: "draft" | "calibrating" | "frozen";
	/** What this case tests — the capability contract. */
	capability: string;
	/** What distinguishes a pass from a fail. */
	distinguisher: string;
	/** Known shortcuts the agent might use to game the rubric. */
	shortcuts: string;
	/** Calibration run history (appended on each pilot run). */
	calibrationHistory: CalibrationRecord[];
}

/** One pilot-run record in the calibration history. */
export interface CalibrationRecord {
	runAt: string;
	score: number;
	passed: boolean;
	notes: string;
	/** Whether the case was modified after this run. */
	modified: boolean;
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
	 * used by the evaluation units — written from the host (not the model),
	 * so it reflects reality. Combined with `caseHash`, these make material
	 * and route drift between reference and candidate runs detectable:
	 * `score.flagMaterialDrift` re-marks a candidate cell failed when its
	 * case hash no longer matches the reference (version_changed semantics).
	 */
	provider?: string;
	model?: string;
	/**
	 * Material hash: SHA-256 prefix of the case statement + rubric envelope,
	 * so a material change between reference and candidate runs is detectable.
	 * absence means pre-A3 cell (backward compatible).
	 */
	caseHash?: string;
	/**
	 * Gap C3: wall-clock duration of this cell's evaluation (both executor +
	 * reviewer subagents) in milliseconds. Absent means pre-C3 cell.
	 */
	durationMs?: number;
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
	// A5: initialize case metadata for quality gate.
	saveCaseMeta(baseDir, bid, id, defaultCaseMeta());
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
				const meta = loadCaseMeta(baseDir, bid, id);
				return { id, title: id, statement, rubric, ...(meta ? { status: meta.status } : {}) } satisfies BenchmarkCase;
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

// ── Case meta (gap A5: quality gate + calibration history) ────────────

export function loadCaseMeta(baseDir: string, bid: string, cid: string): CaseMeta | undefined {
	const path = join(benchmarkDir(baseDir, bid), "cases", cid, "meta.json");
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as CaseMeta;
	} catch {
		return undefined;
	}
}

export function saveCaseMeta(baseDir: string, bid: string, cid: string, meta: CaseMeta): void {
	const metaDir = join(benchmarkDir(baseDir, bid), "cases", cid);
	mkdirSync(metaDir, { recursive: true });
	writeFileSync(join(metaDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

/**
 * Transition a case's lifecycle state. Throws on illegal transitions.
 *   draft → calibrating (start pilot)
 *   calibrating → draft (abandon calibration)
 *   calibrating → frozen (lock baseline)
 */
export function transitionCaseStatus(
	baseDir: string,
	bid: string,
	cid: string,
	to: "draft" | "calibrating" | "frozen",
): CaseMeta {
	const meta = loadCaseMeta(baseDir, bid, cid) ?? defaultCaseMeta();
	const from = meta.status;
	const valid =
		(from === "draft" && to === "calibrating") ||
		(from === "calibrating" && to === "draft") ||
		(from === "calibrating" && to === "frozen");
	if (!valid) {
		throw new Error(`illegal case status transition: ${from} → ${to}`);
	}
	meta.status = to;
	saveCaseMeta(baseDir, bid, cid, meta);
	return meta;
}

function defaultCaseMeta(): CaseMeta {
	return {
		status: "draft",
		capability: "",
		distinguisher: "",
		shortcuts: "",
		calibrationHistory: [],
	};
}

/**
 * Quality-check a case: mechanical validation without LLM calls.
 * Returns human-readable problems; empty array means the case passes.
 */
export function caseCheckProblems(
	baseDir: string,
	bid: string,
	cid: string,
): string[] {
	const problems: string[] = [];
	const statementPath = join(benchmarkDir(baseDir, bid), "cases", cid, "statement.md");
	if (!existsSync(statementPath)) {
		problems.push("statement.md missing");
		return problems;
	}
	const statement = readFileSync(statementPath, "utf8").trim();
	if (statement.length < 20) {
		problems.push(`statement too short (${statement.length} chars, minimum 20)`);
	}
	const rubricPath = join(benchmarkDir(baseDir, bid), "cases", cid, "rubric.json");
	if (!existsSync(rubricPath)) {
		problems.push("rubric.json missing");
		return problems;
	}
	try {
		const raw = readFileSync(rubricPath, "utf8");
		JSON.parse(raw);
	} catch {
		problems.push("rubric.json is not valid JSON");
	}
	const meta = loadCaseMeta(baseDir, bid, cid);
	if (!meta) {
		problems.push("meta.json missing (run /evolve benchmark casecheck to initialize)");
	} else {
		if (!meta.capability) problems.push("capability contract is empty");
		if (!meta.distinguisher) problems.push("distinguisher is empty");
		if (!meta.shortcuts) problems.push("shortcuts annotation is empty");
	}
	return problems;
}

import { readdirSync } from "node:fs";
function readdirSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}
