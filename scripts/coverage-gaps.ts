#!/usr/bin/env node
/**
 * Coverage gap locator: runs the suite once with v8 JSON coverage and prints
 * every file's uncovered statements (merged line ranges with source excerpts),
 * uncovered branches, and uncovered functions — worst files first.
 *
 * The per-file waterline tells you THAT a file is low; this tells you WHERE.
 * It is a read-only locator, never a gate (exit 0 on success even with gaps).
 *
 * Usage:
 *   tsx scripts/coverage-gaps.ts [substring ...] [--top N] [--keep]
 *   tsx scripts/coverage-gaps.ts --self-test
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP_DIR = join(REPO_ROOT, ".tmp-coverage-gaps");

interface FileCoverage {
	s: Record<string, number>;
	f: Record<string, number>;
	b: Record<string, number[]>;
	statementMap: Record<string, { start: { line: number; column: number }; end: { line: number; column: number } }>;
	fnMap: Record<string, { name: string; loc: { start: { line: number } } }>;
	branchMap: Record<string, { type: string; loc: { start: { line: number } }; locations: Array<{ start: { line: number; column: number } }> }>;
}

interface FileGaps {
	path: string;
	stmtTotal: number;
	stmtCovered: number;
	stmtRanges: Array<{ start: number; end: number; excerpt: string }>;
	branchTotal: number;
	branchCovered: number;
	branchNotes: Array<{ line: number; kind: string; excerpt: string }>;
	funcTotal: number;
	funcCovered: number;
	funcNotes: string[];
}

function pct(covered: number, total: number): string {
	if (total === 0) return "100.0";
	return ((covered / total) * 100).toFixed(1);
}

function excerptOf(lines: string[], line: number): string {
	const raw = lines[line - 1] ?? "";
	const trimmed = raw.trim();
	return trimmed.length > 110 ? `${trimmed.slice(0, 107)}...` : trimmed;
}

function mergeLines(sorted: number[]): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	for (const line of sorted) {
		const last = ranges[ranges.length - 1];
		if (last && line === last.end + 1) last.end = line;
		else ranges.push({ start: line, end: line });
	}
	return ranges;
}

function gapsOf(absPath: string, coverage: FileCoverage): FileGaps {
	const rel = relative(REPO_ROOT, absPath);
	let sourceLines: string[] = [];
	try {
		sourceLines = readFileSync(absPath, "utf8").split("\n");
	} catch {
		sourceLines = [];
	}
	const stmtEntries = Object.entries(coverage.s);
	const stmtCovered = stmtEntries.filter(([, count]) => count > 0).length;
	const uncoveredLines = [...new Set(stmtEntries.filter(([, count]) => count === 0).map(([id]) => coverage.statementMap[id]?.start.line ?? 0))].sort(
		(a, b) => a - b,
	);
	const stmtRanges = mergeLines(uncoveredLines).map((range) => ({
		...range,
		excerpt: excerptOf(sourceLines, range.start),
	}));
	let branchTotal = 0;
	let branchCovered = 0;
	const branchNotes: FileGaps["branchNotes"] = [];
	for (const [id, counts] of Object.entries(coverage.b)) {
		const meta = coverage.branchMap[id];
		counts.forEach((count, index) => {
			branchTotal += 1;
			if (count > 0) {
				branchCovered += 1;
				return;
			}
			const line = meta?.locations[index]?.start.line ?? meta?.loc.start.line ?? 0;
			branchNotes.push({ line, kind: meta?.type ?? "branch", excerpt: excerptOf(sourceLines, line) });
		});
	}
	branchNotes.sort((a, b) => a.line - b.line);
	const funcEntries = Object.entries(coverage.f);
	const funcCovered = funcEntries.filter(([, count]) => count > 0).length;
	const funcNotes = funcEntries
		.filter(([, count]) => count === 0)
		.map(([id]) => {
			const meta = coverage.fnMap[id];
			return `${meta?.name || "(anonymous)"} L${meta?.loc.start.line ?? 0}`;
		});
	return {
		path: rel,
		stmtTotal: stmtEntries.length,
		stmtCovered,
		stmtRanges,
		branchTotal,
		branchCovered,
		branchNotes,
		funcTotal: funcEntries.length,
		funcCovered,
		funcNotes,
	};
}

/** Pure formatter: file gaps plus repo totals → human-readable report. */
export function formatGapsReport(files: FileGaps[], top: number): string {
	const sorted = [...files].sort(
		(a, b) => b.stmtRanges.length - a.stmtRanges.length || b.branchNotes.length - a.branchNotes.length,
	);
	const shown = sorted.slice(0, top);
	const out: string[] = [];
	for (const file of shown) {
		out.push(
			`${file.path} — stmts ${file.stmtCovered}/${file.stmtTotal} (${pct(file.stmtCovered, file.stmtTotal)}%) · branch ${file.branchCovered}/${file.branchTotal} (${pct(file.branchCovered, file.branchTotal)}%) · funcs ${file.funcCovered}/${file.funcTotal} (${pct(file.funcCovered, file.funcTotal)}%)`,
		);
		for (const range of file.stmtRanges.slice(0, 25)) {
			const label = range.start === range.end ? `L${range.start}` : `L${range.start}-${range.end}`;
			out.push(`  stmt ${label}: ${fileStmtExcerpt(range.excerpt)}`);
		}
		if (file.stmtRanges.length > 25) out.push(`  ... and ${file.stmtRanges.length - 25} more stmt ranges`);
		for (const note of file.branchNotes.slice(0, 15)) {
			out.push(`  branch ${note.kind} L${note.line}: ${fileStmtExcerpt(note.excerpt)}`);
		}
		if (file.branchNotes.length > 15) out.push(`  ... and ${file.branchNotes.length - 15} more branches`);
		for (const note of file.funcNotes) out.push(`  func ${note}`);
	}
	if (sorted.length > shown.length) out.push(`... and ${sorted.length - shown.length} more files with gaps (use --top N)`);
	if (out.length === 0) out.push("no coverage gaps: every file is at 100% statements, branches, and functions");
	return out.join("\n");
}

function fileStmtExcerpt(excerpt: string): string {
	return excerpt.length > 0 ? excerpt : "(source unavailable)";
}

function runCoverageJson(): Record<string, FileCoverage> {
	rmSync(TMP_DIR, { recursive: true, force: true });
	mkdirSync(TMP_DIR, { recursive: true });
	const run = spawnSync(
		"./node_modules/.bin/vitest",
		[
			"run",
			"--coverage",
			"--coverage.reporter=json",
			`--coverage.reportsDirectory=${TMP_DIR}`,
			"--coverage.thresholds.perFile=false",
			"--coverage.thresholds.lines=0",
			"--coverage.thresholds.functions=0",
			"--coverage.thresholds.statements=0",
			"--coverage.thresholds.branches=0",
		],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
	if (run.status !== 0) {
		const tail = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.trim().split("\n").slice(-15).join("\n");
		throw new Error(`vitest coverage run failed:\n${tail}`);
	}
	const raw = readFileSync(join(TMP_DIR, "coverage-final.json"), "utf8");
	return JSON.parse(raw) as Record<string, FileCoverage>;
}

function selfTest(): number {
	const fixture: FileGaps[] = [
		{
			path: "src/low.ts",
			stmtTotal: 10,
			stmtCovered: 8,
			stmtRanges: [
				{ start: 106, end: 108, excerpt: "pending.length = 0;" },
				{ start: 144, end: 144, excerpt: "return;" },
			],
			branchTotal: 4,
			branchCovered: 3,
			branchNotes: [{ line: 100, kind: "if", excerpt: "if (bestIndex < 0) {" }],
			funcTotal: 2,
			funcCovered: 1,
			funcNotes: ["onAbort L214"],
		},
		{
			path: "src/full.ts",
			stmtTotal: 5,
			stmtCovered: 5,
			stmtRanges: [],
			branchTotal: 2,
			branchCovered: 2,
			branchNotes: [],
			funcTotal: 1,
			funcCovered: 1,
			funcNotes: [],
		},
	];
	const report = formatGapsReport(fixture, 10);
	const expected = [
		"src/low.ts — stmts 8/10 (80.0%)",
		"stmt L106-108: pending.length = 0;",
		"stmt L144: return;",
		"branch if L100: if (bestIndex < 0) {",
		"func onAbort L214",
		"src/full.ts — stmts 5/5 (100.0%)",
	];
	for (const line of expected) {
		if (!report.includes(line)) {
			console.error(`self-test missing: ${line}\n${report}`);
			return 1;
		}
	}
	// mergeLines is exercised through gapsOf only on real runs; pin the
	// merging rule directly here.
	const merged = mergeLines([3, 4, 5, 9]);
	if (merged.length !== 2 || merged[0]?.start !== 3 || merged[0]?.end !== 5 || merged[1]?.start !== 9) {
		console.error(`self-test merge failed: ${JSON.stringify(merged)}`);
		return 1;
	}
	console.log("coverage-gaps --self-test OK (format + range merge)");
	return 0;
}

function main(): number {
	const args = process.argv.slice(2);
	if (args.includes("--self-test")) return selfTest();
	let top = Number.MAX_SAFE_INTEGER;
	const keep = args.includes("--keep");
	const topIndex = args.indexOf("--top");
	if (topIndex >= 0) {
		const parsed = Number(args[topIndex + 1]);
		if (!Number.isInteger(parsed) || parsed <= 0) {
			console.error("usage: tsx scripts/coverage-gaps.ts [substring ...] [--top N] [--keep]");
			return 1;
		}
		top = parsed;
	}
	const topValue = topIndex >= 0 ? args[topIndex + 1] : undefined;
	const filters = args.filter((arg) => !arg.startsWith("--") && arg !== topValue);
	let coverage: Record<string, FileCoverage>;
	try {
		coverage = runCoverageJson();
	} catch (cause) {
		console.error(cause instanceof Error ? cause.message : String(cause));
		return 1;
	} finally {
		if (!keep) rmSync(TMP_DIR, { recursive: true, force: true });
	}
	const withGaps: FileGaps[] = [];
	for (const [absPath, file] of Object.entries(coverage)) {
		if (filters.length > 0 && !filters.some((part) => absPath.includes(part))) continue;
		const gaps = gapsOf(absPath, file);
		const clean =
			gaps.stmtRanges.length === 0 && gaps.branchNotes.length === 0 && gaps.funcNotes.length === 0;
		if (!clean) withGaps.push(gaps);
	}
	const totals = {
		stmts: { covered: 0, total: 0 },
		branch: { covered: 0, total: 0 },
		funcs: { covered: 0, total: 0 },
	};
	for (const file of Object.values(coverage)) {
		for (const count of Object.values(file.s)) {
			totals.stmts.total += 1;
			if (count > 0) totals.stmts.covered += 1;
		}
		for (const counts of Object.values(file.b)) {
			for (const count of counts) {
				totals.branch.total += 1;
				if (count > 0) totals.branch.covered += 1;
			}
		}
		for (const count of Object.values(file.f)) {
			totals.funcs.total += 1;
			if (count > 0) totals.funcs.covered += 1;
		}
	}
	console.log(
		`coverage gaps: ${withGaps.length} files (${totals.stmts.covered}/${totals.stmts.total} stmts ${pct(totals.stmts.covered, totals.stmts.total)}% · ${totals.branch.covered}/${totals.branch.total} branch ${pct(totals.branch.covered, totals.branch.total)}% · ${totals.funcs.covered}/${totals.funcs.total} funcs ${pct(totals.funcs.covered, totals.funcs.total)}%)`,
	);
	console.log(formatGapsReport(withGaps, top === Number.MAX_SAFE_INTEGER ? 12 : top));
	return 0;
}

process.exit(main());
