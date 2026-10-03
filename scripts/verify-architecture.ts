#!/usr/bin/env -S ../node_modules/.bin/tsx
/**
 * Architecture gate (docs/architecture-standard.md §6):
 *   1. layer direction (LAYER table is the single source of truth) + import cycles (SCC)
 *   2. host-API single-point boundaries (docs/architecture-standard.md §2)
 *   3. L0/L1 package purity (no @deepseek-ai imports below L2)
 *   4. L4 facade bypass (no direct state/store imports in the interface layer)
 *   5. size budgets: file lines and out-degree (docs/architecture-standard.md §4)
 *
 * Whitelists carry the refactor phase that clears each entry
 * (plan: workspace refactor-review-20261003/06-refactor-plan.md). Empty them as
 * phases land — a stale entry that no longer matches reality must be deleted.
 *
 * Exit 0 = pass, 1 = violations.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";

/** 0=types/constants 1=pure engine 2=host adapter 3=domain flow 4=interface. */
const LAYER: Record<string, number> = {
	// L0
	types: 0, plan: 0, "memory-guide": 0, project: 0,
	// L1 pure engine
	state: 1, validate: 1, apply: 1, rollback: 1, store: 1, service: 1,
	projection: 1, promotion: 1, search: 1, render: 1, usage: 1,
	consolidate: 1, recall: 1, "evolve-event": 1, runtime: 1, failures: 1,
	declines: 1, pool: 1, "memory-benchmark": 1, "skill-render": 1, skillquality: 1,
	// L2 host adapters
	"llm-text": 2, "message-source": 2, "token-usage": 2, "turn-snapshot": 2,
	"prefix-cache": 2, inject: 2, "memory-index": 2, source: 2, skill: 2,
	mount: 2, logfile: 2, approval: 2, notify: 2, rubric: 2,
	"record-language": 2, copy: 2,
	// L3 domain flows
	"memory-agent": 3, review: 3, planner: 3, wrapup: 3, fate: 3,
	benchmark: 3, evaluate: 3, autocase: 3, goal: 3, score: 3,
	"review-scheduler": 3,
	// L4 interface
	tool: 4, command: 4, "wrapup-command": 4, "benchmark-command": 4,
	"mount-command": 4, "goal-command": 4, index: 4, auto: 4,
};

const LAYER_NAME = ["L0", "L1", "L2", "L3", "L4"];
const COMPOSITION_ROOT = "index";
const MAX_LINES = 400;
const MAX_OUT_DEGREE = 12;
const MAX_OUT_DEGREE_ROOT = 14;

/** Known violations, each cleared by a named refactor phase. */
const WHITELIST = {
	/** Phase 1 deletes fate (auto⇄fate cycle dissolves). */
	cycles: ["auto,fate", "benchmark-command,command,mount-command"],
	/** Phase 1 deletes fate. */
	upward: ["fate->auto"],
	/** Phase 2: interface modules receive engine reads via the service facade. */
	bypass: ["auto->state", "auto->store", "command->state", "command->store", "tool->store"],
	/** Phase 1 shrinks auto+fate; Phase 2 splits command/auto; Phase 3 splits inject/wrapup/memory-agent. */
	overlines: ["auto", "command", "fate", "inject", "memory-agent", "wrapup"],
	/** Phase 1 shrinks memory-agent; Phase 2 turns command into a pure router and splits auto. */
	overdegree: ["auto", "command", "memory-agent"],
};

/** host-API single-point boundaries (docs/architecture-standard.md §2). */
const HOST_API_BOUNDARY: { pattern: RegExp; allowed: string[] }[] = [
	{ pattern: /\bctx\.llm\b/, allowed: ["llm-text", "planner", "skillquality"] },
	{ pattern: /\bctx\.systemPrompt\b/, allowed: ["index"] },
	{ pattern: /\bctx\.subagents\b/, allowed: [] },
	{ pattern: /\bctx\.tools\b/, allowed: ["mount", "tool"] },
	{ pattern: /\bctx\.commands\b/, allowed: ["command"] },
	{ pattern: /\buserQuestions\b/, allowed: ["approval", "auto", "fate", "index", "wrapup-command"] },
	{ pattern: /\bsessionQuery\b/, allowed: ["index", "turn-snapshot"] },
];

const IMPORT_FROM_RE = /from\s+"\.\/([a-z0-9-]+?)(?:\.js)?"/g;

interface Module {
	name: string;
	layer: number;
	lines: number;
	deps: string[];
	text: string;
}

function loadModules(): Map<string, Module> {
	const mods = new Map<string, Module>();
	for (const entry of readdirSync(SRC)) {
		if (!entry.endsWith(".ts")) continue;
		const name = entry.replace(/\.ts$/, "");
		const text = readFileSync(join(SRC, entry), "utf-8");
		const deps = new Set<string>();
		for (const m of text.matchAll(IMPORT_FROM_RE)) {
			const dep = m[1];
			if (dep) deps.add(dep);
		}
		mods.set(name, {
			name,
			layer: LAYER[name] ?? Number.NaN,
			lines: text.split("\n").length,
			deps: [...deps].sort(),
			text,
		});
	}
	return mods;
}

/** Tarjan SCC over the internal import graph. */
function stronglyConnected(mods: Map<string, Module>): string[][] {
	let index = 0;
	const stack: string[] = [];
	const onStack = new Set<string>();
	const indices = new Map<string, number>();
	const low = new Map<string, number>();
	const out: string[][] = [];

	const visit = (v: string): void => {
		indices.set(v, index);
		low.set(v, index);
		index += 1;
		stack.push(v);
		onStack.add(v);
		for (const w of mods.get(v)?.deps ?? []) {
			if (!mods.has(w)) continue;
			if (!indices.has(w)) {
				visit(w);
				low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
			} else if (onStack.has(w)) {
				low.set(v, Math.min(low.get(v) ?? 0, indices.get(w) ?? 0));
			}
		}
		if (low.get(v) === indices.get(v)) {
			const component: string[] = [];
			let w: string;
			do {
				w = stack.pop() ?? "";
				onStack.delete(w);
				component.push(w);
			} while (w !== v);
			if (component.length > 1) out.push(component.sort());
		}
	};

	for (const name of mods.keys()) {
		if (!indices.has(name)) visit(name);
	}
	return out;
}

function main(): number {
	const mods = loadModules();
	const errors: string[] = [];

	// 0. classification completeness
	for (const name of mods.keys()) {
		if (Number.isNaN(LAYER[name])) errors.push(`${name}.ts: unclassified module (add it to the LAYER table)`);
	}
	for (const name of Object.keys(LAYER)) {
		if (!mods.has(name)) errors.push(`LAYER table lists '${name}' but src/${name}.ts is missing (stale table?)`);
	}
	if (errors.length > 0) {
		for (const e of errors) console.log(`FAIL: ${e}`);
		return 1;
	}

	// 1a. layer direction
	const upward: string[] = [];
	for (const mod of mods.values()) {
		for (const dep of mod.deps) {
			const depLayer = LAYER[dep];
			if (depLayer === undefined) continue;
			if (depLayer > mod.layer) upward.push(`${mod.name}->${dep}`);
		}
	}
	const strayUpward = upward.filter((e) => !WHITELIST.upward.includes(e));
	for (const e of strayUpward) {
		const [from, to] = e.split(">");
		if (!from || !to) continue;
		const fromLayer = LAYER_NAME[LAYER[from] ?? 0];
		const toLayer = LAYER_NAME[LAYER[to] ?? 0];
		errors.push(`layer violation: ${e} (${fromLayer} -> ${toLayer})`);
	}
	for (const e of WHITELIST.upward) {
		if (!upward.includes(e)) errors.push(`stale whitelist entry 'upward: ${e}' — remove it`);
	}

	// 1b. cycles
	const sccs = stronglyConnected(mods).map((c) => c.join(","));
	const strayCycles = sccs.filter((c) => !WHITELIST.cycles.includes(c));
	for (const c of strayCycles) errors.push(`import cycle: ${c}`);
	for (const c of WHITELIST.cycles) {
		if (!sccs.includes(c)) errors.push(`stale whitelist entry 'cycles: ${c}' — remove it`);
	}

	// 2. host-API single-point boundaries
	for (const mod of mods.values()) {
		for (const { pattern, allowed } of HOST_API_BOUNDARY) {
			if (pattern.test(mod.text) && !allowed.includes(mod.name)) {
				errors.push(`host boundary: ${mod.name}.ts uses ${String(pattern)} outside its allowed set (${allowed.join(", ") || "none"})`);
			}
		}
	}

	// 3. L0/L1 package purity
	for (const mod of mods.values()) {
		if (mod.layer <= 1 && /from\s+"@deepseek-ai\//.test(mod.text)) {
			errors.push(`purity: ${mod.name}.ts (L${mod.layer}) imports @deepseek-ai/*`);
		}
	}

	// 4. L4 facade bypass
	for (const mod of mods.values()) {
		if (mod.layer !== 4) continue;
		for (const dep of mod.deps) {
			if (dep === "state" || dep === "store") {
				const entry = `${mod.name}->${dep}`;
				if (!WHITELIST.bypass.includes(entry)) errors.push(`facade bypass: ${entry} (L4 must read the engine via service.ts)`);
			}
		}
	}
	for (const e of WHITELIST.bypass) {
		const [from, dep] = e.split("->");
		if (!from || !dep) continue;
		const still = mods.get(from)?.deps.includes(dep) ?? false;
		if (!still) errors.push(`stale whitelist entry 'bypass: ${e}' — remove it`);
	}

	// 5. size budgets
	const overlines: string[] = [];
	const overdegree: string[] = [];
	for (const mod of mods.values()) {
		if (mod.lines > MAX_LINES) overlines.push(`${mod.name} (${mod.lines})`);
		const limit = mod.name === COMPOSITION_ROOT ? MAX_OUT_DEGREE_ROOT : MAX_OUT_DEGREE;
		if (mod.deps.length > limit) overdegree.push(`${mod.name} (${mod.deps.length})`);
	}
	for (const entry of overlines) {
		const name = entry.split(" ")[0];
		if (name && !WHITELIST.overlines.includes(name)) errors.push(`file over ${MAX_LINES} lines: ${entry}`);
	}
	for (const entry of overdegree) {
		const name = entry.split(" ")[0];
		if (name && !WHITELIST.overdegree.includes(name)) errors.push(`out-degree over limit: ${entry}`);
	}
	for (const name of WHITELIST.overlines) {
		const mod = mods.get(name);
		if (!mod) errors.push(`stale whitelist entry 'overlines: ${name}' — remove it`);
		else if (mod.lines <= MAX_LINES) errors.push(`stale whitelist entry 'overlines: ${name}' — now ${mod.lines} lines, remove it`);
	}
	for (const name of WHITELIST.overdegree) {
		const mod = mods.get(name);
		const limit = name === COMPOSITION_ROOT ? MAX_OUT_DEGREE_ROOT : MAX_OUT_DEGREE;
		if (!mod) errors.push(`stale whitelist entry 'overdegree: ${name}' — remove it`);
		else if (mod.deps.length <= limit) errors.push(`stale whitelist entry 'overdegree: ${name}' — now ${mod.deps.length}, remove it`);
	}

	if (errors.length > 0) {
		for (const e of errors) console.log(`FAIL: ${e}`);
		return 1;
	}
	console.log(`OK   layers: ${mods.size} modules classified, direction + SCC clean (whitelist: ${WHITELIST.upward.length + WHITELIST.cycles.length} entries)`);
	console.log(`OK   boundaries: host-API single point, L0/L1 purity, facade bypass (whitelist: ${WHITELIST.bypass.length} entries)`);
	console.log(`OK   budgets: lines/degree (whitelist: ${WHITELIST.overlines.length + WHITELIST.overdegree.length} entries)`);
	return 0;
}

process.exit(main());
