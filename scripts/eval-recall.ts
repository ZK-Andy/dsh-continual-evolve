#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Offline recall evaluation over `evals/tasks/*.json`: seed a throwaway store
 * from every task's `seed_memories`, run each task's `recall` query through
 * the store's own keyword search, and report recall@1 / recall@3, per-memory
 * coverage, and negative false-hits (P5a; ADR `proposed/testing/2026-10-19-p5a-eval-infra.md`).
 *
 * The committed baseline `evals/baseline/recall.json` is the CI anchor: any
 * mismatch (regression or improvement) exits 2 until re-anchored with
 * `--update-baseline` (same PR must explain why). It never touches the real
 * database: the store lives under a temporary directory and is removed after.
 *
 * Usage:
 *   npm run eval:recall                    # evals/tasks + baseline compare
 *   npm run eval:recall -- <dir|file>      # another task set (skips baseline)
 *   npm run eval:recall -- --update-baseline
 *
 * Exit codes: 0 = pass, 2 = mismatch with the baseline, 1 = unusable fixture.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openMemoryStore } from "../src/store.js";

interface SeedMemory {
	id: string;
	type: "user" | "feedback" | "reference";
	title: string;
	description: string;
	body: string;
	notWhen?: string;
}

interface RecallSegment {
	query?: string;
	expect_ids: string[];
	negative?: boolean;
}

interface EvalTask {
	id: string;
	prompt: string;
	recall?: RecallSegment;
	seed_memories?: SeedMemory[];
}

interface QueryResult {
	task: string;
	query: string;
	negative: boolean;
	top3: string[];
}

const TASKS_DIR = join(import.meta.dirname, "..", "evals", "tasks");
const BASELINE_PATH = join(import.meta.dirname, "..", "evals", "baseline", "recall.json");
const WORKSPACE = "/tmp/evolve-recall-eval";

/** Read task files from a directory or a single file; throws with a readable reason. */
function loadTasks(source: string): EvalTask[] {
	let files: string[];
	try {
		const stat = statSync(source);
		files = stat.isDirectory() ? readdirSync(source).filter((name) => name.endsWith(".json")).map((name) => join(source, name)) : [source];
	} catch (error) {
		throw new Error(`cannot read task source ${source}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (files.length === 0) {
		throw new Error(`task source ${source} has no task files — an empty set measures nothing`);
	}
	return files.map((file) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		} catch (error) {
			throw new Error(`cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const task = parsed as Partial<EvalTask>;
		if (typeof task.id !== "string" || task.id.length === 0 || typeof task.prompt !== "string") {
			throw new Error(`${file} is not an eval task (needs id + prompt)`);
		}
		return task as EvalTask;
	});
}

/** Merge every task's seed memories (dedup by id, conflicting bodies fail); needs ≥1 memory and ≥1 recall query. */
function collectFixture(tasks: EvalTask[]): { memories: SeedMemory[]; queries: { task: string; query: string; expectIds: string[]; negative: boolean }[] } {
	const memories = new Map<string, SeedMemory>();
	for (const task of tasks) {
		for (const memory of task.seed_memories ?? []) {
			const prior = memories.get(memory.id);
			if (prior !== undefined && (prior.body !== memory.body || prior.title !== memory.title)) {
				throw new Error(`memory "${memory.id}" is seeded with conflicting bodies by several tasks`);
			}
			memories.set(memory.id, memory);
		}
	}
	if (memories.size === 0) {
		throw new Error("no task seeds memories — an empty store measures nothing");
	}
	const known = new Set(memories.keys());
	const queries = [];
	for (const task of tasks) {
		if (task.recall === undefined) {
			continue;
		}
		const expectIds = task.recall.expect_ids ?? [];
		for (const id of expectIds) {
			if (!known.has(id)) {
				throw new Error(`task "${task.id}" expects unknown memory "${id}"`);
			}
		}
		if (task.recall.negative === true && expectIds.length > 0) {
			throw new Error(`task "${task.id}" is negative but names expect_ids — negatives assert zero hits`);
		}
		queries.push({ task: task.id, query: task.recall.query ?? task.prompt, expectIds, negative: task.recall.negative === true });
	}
	if (queries.length === 0) {
		throw new Error("no task carries a recall segment — nothing to measure");
	}
	return { memories: [...memories.values()], queries };
}

interface RecallReport {
	recall1: number;
	recall3: number;
	falseHits: number;
	perQuery: QueryResult[];
	uncovered: string[];
}

/** Seed the throwaway store and run every query; returns the aggregate report. */
async function run(memories: SeedMemory[], queries: { task: string; query: string; expectIds: string[]; negative: boolean }[]): Promise<RecallReport> {
	const dir = mkdtempSync(join(tmpdir(), "evolve-recall-"));
	const store = await openMemoryStore(join(dir, "memory.db"));
	try {
		const outcomes = store.applyProposals(
			{ workspaceId: WORKSPACE, trigger: "explicit" },
			memories.map((memory) => ({
				action: "create" as const,
				id: memory.id,
				type: memory.type,
				title: memory.title,
				description: memory.description,
				body: memory.body,
				notWhen: memory.notWhen,
			})),
		);
		const rejected = outcomes.filter((outcome) => !outcome.ok);
		if (rejected.length > 0) {
			throw new Error(`seed memory rejected by the write gate: ${rejected[0]?.reason ?? "unknown"}`);
		}
		const perQuery: QueryResult[] = [];
		const seen = new Set<string>();
		let hit1 = 0;
		let hit3 = 0;
		let falseHits = 0;
		let positives = 0;
		let negatives = 0;
		for (const { task, query, expectIds, negative } of queries) {
			const results = store.search(WORKSPACE, query, 10);
			const ids = results.map((record) => record.id);
			for (const id of ids) {
				seen.add(id);
			}
			const top3 = ids.slice(0, 3);
			perQuery.push({ task, query, negative, top3 });
			if (negative) {
				negatives += 1;
				if (ids.length > 0) {
					falseHits += 1;
				}
				continue;
			}
			positives += 1;
			if (top3[0] !== undefined && expectIds.includes(top3[0])) {
				hit1 += 1;
			}
			if (top3.some((id) => expectIds.includes(id))) {
				hit3 += 1;
			}
		}
		const uncovered = [...memories.map((memory) => memory.id).filter((id) => !seen.has(id))].sort();
		return {
			recall1: positives === 0 ? 1 : hit1 / positives,
			recall3: positives === 0 ? 1 : hit3 / positives,
			falseHits: negatives === 0 ? 0 : falseHits,
			perQuery,
			uncovered,
		};
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

interface Baseline {
	recall1: number;
	recall3: number;
	falseHits: number;
	perQuery: QueryResult[];
}

/** The baseline mismatches that fail the run (empty when anchored). */
function diffBaseline(report: RecallReport, baseline: Baseline): string[] {
	const problems: string[] = [];
	const sameQueries =
		report.perQuery.length === baseline.perQuery.length &&
		report.perQuery.every(
			(entry, index) =>
				baseline.perQuery[index]?.task === entry.task &&
				baseline.perQuery[index]?.query === entry.query &&
				JSON.stringify(baseline.perQuery[index]?.top3) === JSON.stringify(entry.top3),
		);
	if (report.recall1 < baseline.recall1 || report.recall3 < baseline.recall3 || report.falseHits > baseline.falseHits) {
		problems.push(`regressed: recall@1 ${baseline.recall1}→${report.recall1}, recall@3 ${baseline.recall3}→${report.recall3}, false-hits ${baseline.falseHits}→${report.falseHits}`);
	} else if (!sameQueries || report.recall1 !== baseline.recall1 || report.recall3 !== baseline.recall3) {
		problems.push("improved or shifted: re-anchor with --update-baseline (same PR explains why)");
	}
	return problems;
}

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const update = args.includes("--update-baseline");
	const source = args.find((arg) => !arg.startsWith("--")) ?? TASKS_DIR;
	const useBaseline = !update && source === TASKS_DIR;
	let tasks: EvalTask[];
	try {
		tasks = loadTasks(source);
	} catch (error) {
		console.error(`eval:recall failed: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	let fixture: { memories: SeedMemory[]; queries: { task: string; query: string; expectIds: string[]; negative: boolean }[] };
	try {
		fixture = collectFixture(tasks);
	} catch (error) {
		console.error(`eval:recall failed: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	let report: RecallReport;
	try {
		report = await run(fixture.memories, fixture.queries);
	} catch (error) {
		console.error(`eval:recall failed: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	for (const entry of report.perQuery) {
		const top = entry.top3[0] ?? "(none)";
		console.log(`${entry.negative ? "neg" : "q"}  task=${entry.task}  query=${entry.query}  top=${top}`);
	}
	if (report.uncovered.length > 0) {
		console.log(`uncovered (never in any top-10): ${report.uncovered.join(", ")}`);
	}
	console.log(`\nqueries=${String(report.perQuery.length)}  memories=${String(fixture.memories.length)}`);
	console.log(`recall@1=${(report.recall1 * 100).toFixed(1)}%  recall@3=${(report.recall3 * 100).toFixed(1)}%  false-hits=${String(report.falseHits)}`);
	if (update) {
		if (source !== TASKS_DIR) {
			console.error("eval:recall failed: --update-baseline only anchors the default task set");
			return 1;
		}
		const baseline: Baseline = { recall1: report.recall1, recall3: report.recall3, falseHits: report.falseHits, perQuery: report.perQuery };
		mkdirSync(dirname(BASELINE_PATH), { recursive: true });
		writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, "\t")}\n`);
		console.log(`baseline written to ${BASELINE_PATH}`);
		return 0;
	}
	if (useBaseline) {
		let baseline: Baseline;
		try {
			baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
		} catch {
			console.log("no baseline yet — run with --update-baseline to anchor one");
			return 0;
		}
		const problems = diffBaseline(report, baseline);
		for (const problem of problems) {
			console.error(`eval:recall mismatch: ${problem}`);
		}
		return problems.length > 0 ? 2 : 0;
	}
	return 0;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(`eval:recall failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	},
);
