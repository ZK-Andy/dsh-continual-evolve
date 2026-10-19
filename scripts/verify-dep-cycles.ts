#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify dependency cycles (backlog G2): the `src/` value-import graph is acyclic.
 *
 * Only value imports count — `import type …` and `export type …` lines are
 * erased at compile time and cannot form a runtime cycle (the current tree
 * carries 13 type-only cycles, e.g. store-types ↔ memory-apply, that are
 * harmless for exactly this reason). `verify-layering.ts` still counts
 * type-only edges for layer direction (R1); this gate owns the runtime
 * question "can module evaluation deadlock".
 *
 * Usage: tsx scripts/verify-dep-cycles.ts [src_root]
 * Exit code 0 = acyclic (or SKIP when the root does not exist), 1 = cycles found.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const STATIC_IMPORT_RE = /^[ \t]*import\s+(?:[^;"']*?\sfrom\s+)?["'](\.[^"']+)["']/gm;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*["'](\.[^"']+)["']\s*\)/g;
const REEXPORT_RE = /^[ \t]*export\s+[^;]*?\sfrom\s+["'](\.[^"']+)["']/gm;
const TYPE_ONLY_RE = /^\s*(import|export)\s+type\b/;

export interface CycleCheck {
	readonly ok: boolean;
	readonly modules: number;
	readonly cycles: readonly (readonly string[])[];
}

/** Value-import specifiers of one file (type-only lines excluded). */
export function valueSpecifiers(text: string): string[] {
	const seen = new Set<string>();
	const lines = text
		.split("\n")
		.filter((line) => !TYPE_ONLY_RE.test(line))
		.join("\n");
	for (const re of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE, REEXPORT_RE]) {
		re.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(lines)) !== null) {
			if (m[1] !== undefined) seen.add(m[1]);
		}
	}
	return [...seen];
}

/** Resolve a relative specifier to a root-relative module path without extension. */
export function resolveEdge(root: string, importerRel: string, spec: string): string {
	const base = spec.replace(/\.js$/, "");
	return relative(root, join(root, dirname(importerRel), base)).replace(/\\/g, "/");
}

function collectTs(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) collectTs(full, out);
		else if (name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** Build the value-import adjacency (dangling targets dropped — R1 owns them). */
export function buildValueGraph(root: string): Map<string, readonly string[]> {
	const files = collectTs(root).sort();
	const keys = new Set(files.map((f) => relative(root, f).replace(/\\/g, "/")));
	const graph = new Map<string, readonly string[]>();
	for (const file of files) {
		const key = relative(root, file).replace(/\\/g, "/");
		const text = readFileSync(file, "utf-8");
		const targets = valueSpecifiers(text).map((spec) => resolveEdge(root, key, spec));
		const existing = targets
			.map((target) => (keys.has(target) ? target : keys.has(`${target}.ts`) ? `${target}.ts` : undefined))
			.filter((target): target is string => target !== undefined);
		graph.set(key, [...new Set(existing)].sort());
	}
	return graph;
}

/** Depth-first cycle search; each cycle is reported as a closed node path. */
export function findCycles(graph: ReadonlyMap<string, readonly string[]>): (readonly string[])[] {
	const state = new Map<string, 1 | 2>();
	const stack: string[] = [];
	const cycles: (readonly string[])[] = [];
	function visit(node: string): void {
		state.set(node, 1);
		stack.push(node);
		for (const next of graph.get(node) ?? []) {
			if (!graph.has(next)) continue;
			if (state.get(next) === 1) {
				cycles.push([...stack.slice(stack.indexOf(next)), next]);
			} else if (state.get(next) === undefined) {
				visit(next);
			}
		}
		stack.pop();
		state.set(node, 2);
	}
	for (const node of [...graph.keys()].sort()) {
		if (state.get(node) === undefined) visit(node);
	}
	return cycles;
}

/** Pure check over one root directory (importable by tests). */
export function checkDepCycles(root: string): CycleCheck {
	const graph = buildValueGraph(root);
	const cycles = findCycles(graph);
	return { ok: cycles.length === 0, modules: graph.size, cycles };
}

function main(): number {
	const root = process.argv[2] ?? "src";
	try {
		if (!statSync(root).isDirectory()) {
			console.log(`SKIP: ${root} does not exist (no src tree)`);
			return 0;
		}
	} catch {
		console.log(`SKIP: ${root} does not exist (no src tree)`);
		return 0;
	}
	const result = checkDepCycles(root);
	console.log(`Checked ${result.modules} src modules (value imports only)`);
	if (result.ok) {
		console.log("OK（值导入图无环；type-only 边不计入运行时环）");
		return 0;
	}
	for (const cycle of result.cycles) console.log(`FAIL: cycle ${cycle.join(" -> ")}`);
	return 1;
}

/** Run main only under direct execution (tests import the helpers without side effects). */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main();
}
