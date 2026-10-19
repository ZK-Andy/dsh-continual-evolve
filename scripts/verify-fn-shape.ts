#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify function shape (backlog G11): no fat signatures, no explicit any
 * returns, no silent catch blocks, no console.log in src.
 *
 * The engine is the TypeScript compiler API over each file's syntax tree —
 * the same four syntactic rules the backlog assigns to ast-grep, without a
 * system binary clean CI would not have. Only explicit shapes count: an
 * explicit any return annotation (inferred any is out of scope), a catch
 * block with zero statements (comments do not count as handling).
 *
 * The tree carries 36 legacy shapes, so the gate is a ratchet like G4:
 * scripts/fn-shape-baseline.json pins per-file per-rule counts, growth fails
 * until re-anchored with --update (same PR, ADR explains why), shrinkage
 * stays green. New files start at zero.
 *
 * Usage: tsx scripts/verify-fn-shape.ts [src_root] [--baseline PATH] [--update]
 * Exit code 0 = pass (or SKIP when the tree does not exist), 1 = new shape violations.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const RULES = ["params", "return-any", "empty-catch", "console-log"] as const;
export type FnRule = (typeof RULES)[number];

export interface FnViolation {
	readonly line: number;
	readonly name: string;
	readonly rule: FnRule;
}

export type FnCounts = Record<FnRule, number>;

export interface FnShapeBaseline {
	readonly version: 1;
	readonly rules: Record<string, FnCounts>;
}

export interface FnShapeCheck {
	readonly ok: boolean;
	readonly messages: readonly string[];
}

function zeroCounts(): FnCounts {
	return { params: 0, "return-any": 0, "empty-catch": 0, "console-log": 0 };
}

/** All shape violations in one file (syntactic only, no type checker). */
export function collectViolations(sourceText: string): FnViolation[] {
	const sf = ts.createSourceFile("probe.ts", sourceText, ts.ScriptTarget.ESNext, true);
	const violations: FnViolation[] = [];
	function lineOf(node: ts.Node): number {
		return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
	}
	function nameOf(node: ts.Node): string {
		if (!("name" in node)) return "<anonymous>";
		const holder: unknown = node;
		if (typeof holder !== "object" || holder === null || !("name" in holder)) return "<anonymous>";
		const name: unknown = holder.name;
		if (typeof name !== "object" || name === null || !("text" in name)) return "<anonymous>";
		const text: unknown = name.text;
		return typeof text === "string" ? text : "<anonymous>";
	}
	function visit(node: ts.Node): void {
		if (ts.isFunctionLike(node) && "body" in node && node.body !== undefined) {
			if (node.parameters.length > 4) {
				violations.push({ line: lineOf(node), name: nameOf(node), rule: "params" });
			}
			if (node.type !== undefined && node.type.getText(sf).trim() === "any") {
				violations.push({ line: lineOf(node), name: nameOf(node), rule: "return-any" });
			}
		}
		if (ts.isCatchClause(node) && node.block.statements.length === 0) {
			violations.push({ line: lineOf(node), name: "<catch>", rule: "empty-catch" });
		}
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.getText(sf) === "log" &&
			node.expression.expression.getText(sf) === "console"
		) {
			violations.push({ line: lineOf(node), name: "console.log", rule: "console-log" });
		}
		ts.forEachChild(node, visit);
	}
	visit(sf);
	return violations;
}

/** Summarize violations into per-rule counts. */
export function countViolations(violations: readonly FnViolation[]): FnCounts {
	const counts = zeroCounts();
	for (const violation of violations) counts[violation.rule] += 1;
	return counts;
}

/**
 * Pure ratchet check: new files and any per-rule growth fail; shrinkage and
 * deletions pass (the baseline goes stale until --update).
 */
export function compareFnShape(current: Record<string, FnCounts>, baseline: FnShapeBaseline): FnShapeCheck {
	const messages: string[] = [];
	const failures: string[] = [];
	for (const file of Object.keys(current).sort()) {
		const base = baseline.rules[file];
		const cur = current[file] as FnCounts;
		if (base === undefined) {
			failures.push(`FAIL: ${file}: 新文件不在形状基线内 — 跑 --update（同 PR 给出 ADR 说明）`);
			continue;
		}
		for (const rule of RULES) {
			if (cur[rule] > base[rule]) {
				failures.push(`FAIL: ${file}: ${rule} ${base[rule]} → ${cur[rule]} — 只许持平或下降`);
			}
		}
	}
	for (const file of Object.keys(baseline.rules).sort()) {
		if (current[file] === undefined) {
			messages.push(`PRUNED (stale until --update): ${file}`);
		}
	}
	return { ok: failures.length === 0, messages: [...failures, ...messages] };
}

function collectTs(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) collectTs(full, out);
		else if (name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** Snapshot the current tree: per-file per-rule counts keyed by src-relative path. */
export function snapshotTree(root: string): Record<string, FnCounts> {
	const snapshot: Record<string, FnCounts> = {};
	for (const file of collectTs(root).sort()) {
		const key = `src/${relative(root, file).replace(/\\/g, "/")}`;
		snapshot[key] = countViolations(collectViolations(readFileSync(file, "utf-8")));
	}
	return snapshot;
}

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
	const positional = process.argv.slice(2).filter((a) => !a.startsWith("--") && process.argv[process.argv.indexOf(a) - 1] !== "--baseline");
	const root = positional[0] ?? "src";
	const baselinePath = argValue("--baseline") ?? new URL("fn-shape-baseline.json", import.meta.url).pathname;
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
		const baseline: FnShapeBaseline = { version: 1, rules: snapshotTree(root) };
		mkdirSync(dirname(baselinePath), { recursive: true });
		writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
		console.log(`UPDATED ${baselinePath}`);
		return 0;
	}
	if (!existsSync(baselinePath)) {
		console.log(`FAIL: 形状基线缺失：${baselinePath}（跑 tsx scripts/verify-fn-shape.ts --update 生成并同 PR 说明）`);
		return 1;
	}
	let baseline: FnShapeBaseline;
	try {
		baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as FnShapeBaseline;
	} catch {
		console.log(`FAIL: 形状基线无法解析：${baselinePath}`);
		return 1;
	}
	const current = snapshotTree(root);
	const result = compareFnShape(current, baseline);
	const total = Object.values(current).reduce((sum, counts) => sum + counts.params + counts["return-any"] + counts["empty-catch"] + counts["console-log"], 0);
	console.log(`Checked ${Object.keys(current).length} src modules (${total} pinned shapes) against ${relative(".", baselinePath)}`);
	for (const m of result.messages) console.log(m);
	if (result.ok) {
		console.log("OK（函数形状只收敛不发散：参数≤4 / 无显式 any 返回 / catch 非空 / 无 console.log）");
		return 0;
	}
	console.log("说明形状增长原因（ADR）后跑 tsx scripts/verify-fn-shape.ts --update 重定基线");
	return 1;
}

/** Run main only under direct execution (tests import the helpers without side effects). */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main();
}
