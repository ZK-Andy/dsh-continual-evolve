/**
 * Benchmark store: file-backed case definitions and scoreboards under
 * `<baseDir>/evolve/benchmarks/<bid>/`.
 *
 * Layout:
 *   benchmark.json          title, runs (repeats per case), passThreshold
 *   cases/<cid>/statement.md   public task text
 *   cases/<cid>/rubric.json    private scoring criteria (JSON)
 *   scoreboard.json         code-owned aggregates + acceptance history
 *
 * Rubric isolation is by construction: only the evaluation runner reads
 * rubric files; the planner's prompts never include them.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
	score: number;
	passed: boolean;
	notes: string;
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

export function addCase(baseDir: string, bid: string, title: string, statement: string, rubric: string): BenchmarkCase {
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
	writeFileSync(join(caseDir, "rubric.json"), `${JSON.stringify(rubric, null, 2)}\n`, "utf8");
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
