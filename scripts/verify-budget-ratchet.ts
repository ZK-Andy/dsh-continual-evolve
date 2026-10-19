#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify budget ratchet (backlog G4): per-module lines and out-degree only
 * move down. `snapshot/budget-baseline.json` (landed with G-batch1, covering
 * the P1/P2 additions) is the ratchet anchor: any module whose line count or
 * distinct relative-import count grows fails until the author explains it in
 * an ADR and re-anchors with `--update`. Shrinks stay green (the file goes
 * stale until the next `--update`, which is expected).
 *
 * Out-degree counts distinct relative (./ or ../) specifiers in static and
 * dynamic imports — the same semantics as `verify-src-budgets.ts` (type-only
 * edges count: they still declare a layer direction).
 *
 * Usage: tsx scripts/verify-budget-ratchet.ts [src_root] [--baseline PATH] [--update]
 * Exit code 0 = pass (or SKIP when the tree does not exist), 1 = ratchet violations.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { lineCount, outDegree } from "./budget-measure.js";

export interface ModuleBudget {
	readonly lines: number;
	readonly outDegree: number;
}

export interface BudgetBaseline {
	readonly version: 1;
	readonly modules: Record<string, ModuleBudget>;
}

export interface RatchetResult {
	readonly ok: boolean;
	readonly messages: readonly string[];
}

/** wc -l semantics (single home: `./budget-measure.js`). */
export { lineCount } from "./budget-measure.js";

/** Distinct relative module specifiers (same semantics as verify-src-budgets). */
export function outDegreeOf(text: string): number {
	return outDegree(text).length;
}

function collectTs(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) collectTs(full, out);
		else if (name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** Snapshot the current tree (importable by tests and --update). */
export function snapshotTree(root: string): BudgetBaseline {
	const modules: Record<string, ModuleBudget> = {};
	for (const file of collectTs(root).sort()) {
		const key = relative(root, file).replace(/\\/g, "/");
		const text = readFileSync(file, "utf-8");
		modules[key] = { lines: lineCount(text), outDegree: outDegreeOf(text) };
	}
	return { version: 1, modules };
}

/**
 * Pure ratchet check: new modules and any growth fail; shrinks and
 * disappeared modules (pruned) pass — the baseline goes stale until --update.
 */
export function checkRatchet(current: BudgetBaseline, baseline: BudgetBaseline): RatchetResult {
	const messages: string[] = [];
	const failures: string[] = [];
	for (const [mod, cur] of Object.entries(current.modules).sort(([a], [b]) => (a < b ? -1 : 1))) {
		const base = baseline.modules[mod];
		if (base === undefined) {
			failures.push(`${mod}: new module not in baseline — run with --update (同 PR 给出 ADR 说明)`);
			continue;
		}
		if (cur.lines > base.lines) {
			failures.push(`${mod}: lines ${base.lines} → ${cur.lines} (+${cur.lines - base.lines}) — 只许持平或下降`);
		}
		if (cur.outDegree > base.outDegree) {
			failures.push(`${mod}: out-degree ${base.outDegree} → ${cur.outDegree} (+${cur.outDegree - base.outDegree}) — 只许持平或下降`);
		}
	}
	const pruned = Object.keys(baseline.modules).filter((mod) => current.modules[mod] === undefined);
	for (const mod of pruned.sort()) {
		messages.push(`PRUNED (stale until --update): ${mod}`);
	}
	return { ok: failures.length === 0, messages: [...failures.map((f) => `FAIL: ${f}`), ...messages] };
}

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
	const positionals = process.argv.slice(2).filter((a) => !a.startsWith("--") && process.argv[process.argv.indexOf(a) - 1] !== "--baseline");
	const root = positionals[0] ?? "src";
	const baselinePath = argValue("--baseline") ?? join(new URL("..", import.meta.url).pathname.replace(/\/$/, ""), "snapshot/budget-baseline.json");
	const update = process.argv.includes("--update");
	try {
		if (!statSync(root).isDirectory()) {
			console.log(`SKIP: ${root} does not exist (no src tree)`);
			return 0;
		}
	} catch {
		console.log(`SKIP: ${root} does not exist (no src tree)`);
		return 0;
	}
	if (update) {
		mkdirSync(dirname(baselinePath), { recursive: true });
		writeFileSync(baselinePath, `${JSON.stringify(snapshotTree(root), null, 2)}\n`);
		console.log(`UPDATED ${baselinePath}`);
		return 0;
	}
	if (!existsSync(baselinePath)) {
		console.log(`FAIL: baseline 缺失：${baselinePath}（跑 \`tsx scripts/verify-budget-ratchet.ts --update\` 生成并同 PR 说明）`);
		return 1;
	}
	let baseline: BudgetBaseline;
	try {
		baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as BudgetBaseline;
	} catch {
		console.log(`FAIL: baseline 无法解析：${baselinePath}`);
		return 1;
	}
	const result = checkRatchet(snapshotTree(root), baseline);
	console.log(`Checked ${Object.keys(snapshotTree(root).modules).length} src modules against ${relative(".", baselinePath)}`);
	for (const m of result.messages) console.log(m);
	if (result.ok) {
		console.log("OK（行数/出度只降不升）");
		return 0;
	}
	console.log("说明增长原因（ADR）后跑 `tsx scripts/verify-budget-ratchet.ts --update` 重定基线");
	return 1;
}

/** Run main only under direct execution (tests import the helpers without side effects). */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main();
}
