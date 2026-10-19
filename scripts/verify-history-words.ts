#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify history words (backlog G7): durable docs describe the current
 * state, never the change history.
 *
 * Scanned roots (fixed set): docs/, README.md, README.en.md,
 * .agents/notes/implemented/. Matches inside fenced code blocks and inline
 * code spans are metalanguage (talking about a term, a command, an
 * expression) and do not count — only prose counts. HANDOFF files, upstream
 * mirrors, release notes, and archives are outside the scanned roots, which
 * is their exemption.
 *
 * Matched words (case-insensitive latin): previously, now followed by
 * whitespace, no longer, renamed; plus 曾经 and 后来改成.
 *
 * Usage: tsx scripts/verify-history-words.ts [root]
 * Exit code 0 = pass (or SKIP when the root does not exist), 1 = history words found.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOTS = ["docs", "README.md", "README.en.md", ".agents/notes/implemented"];

const FENCED_RE = /```[\s\S]*?```/g;
const SPAN_RE = /`[^`\n]+`/g;
/** Spec-literal pattern (AGENTS.md durable-docs rule); prose only, code stripped first. */
const HISTORY_RE = /\bpreviously\b|\bnow\s|\bno longer\b|\brenamed\b|曾经|后来改成/i;

export interface HistoryHit {
	readonly file: string;
	readonly line: number;
	readonly snippet: string;
}

/** Strip fenced blocks and inline code spans (metalanguage does not count). */
export function stripCode(text: string): string {
	return text.replace(FENCED_RE, "").replace(SPAN_RE, "");
}

/** All prose hits in one document (line numbers are 1-based, snippets capped). */
export function findHistoryHits(file: string, text: string): HistoryHit[] {
	const hits: HistoryHit[] = [];
	const lines = stripCode(text).split("\n");
	lines.forEach((line, index) => {
		if (HISTORY_RE.test(line)) {
			const snippet = line.trim().slice(0, 80);
			hits.push({ file, line: index + 1, snippet });
		}
	});
	return hits;
}

function collectMd(root: string, out: string[] = []): string[] {
	let st;
	try {
		st = statSync(root);
	} catch {
		return out;
	}
	if (st.isFile()) {
		if (root.endsWith(".md")) out.push(root);
		return out;
	}
	for (const name of readdirSync(root)) {
		const full = join(root, name);
		if (full.includes("/archived/") || full.includes("docs/upstream/")) continue;
		if (statSync(full).isDirectory()) collectMd(full, out);
		else if (name.endsWith(".md") && !name.endsWith(".zh.md")) out.push(full);
	}
	return out;
}

function main(): number {
	const roots = process.argv[2] !== undefined ? [process.argv[2] as string] : DEFAULT_ROOTS;
	const hits: HistoryHit[] = [];
	let checked = 0;
	for (const root of roots) {
		for (const file of collectMd(root).sort()) {
			checked += 1;
			const rel = relative(".", file).replace(/\\/g, "/");
			hits.push(...findHistoryHits(rel, readFileSync(file, "utf-8")));
		}
	}
	if (checked === 0) {
		console.log(`SKIP: no markdown under ${roots.join(", ")}`);
		return 0;
	}
	console.log(`Checked ${checked} docs`);
	const shown = hits.slice(0, 20);
	for (const hit of shown) console.log(`FAIL: ${hit.file}:${hit.line}: ${hit.snippet}`);
	if (hits.length > shown.length) {
		console.log(`FAIL: … and ${hits.length - shown.length} more hits`);
	}
	if (hits.length > 0) {
		console.log("durable 文档写当前状态：删历史词，改写为现在的样子（术语讨论请放进代码 span）");
		return 1;
	}
	console.log("OK（无历史词：previously / now / no longer / renamed / 曾经 / 后来改成）");
	return 0;
}

/** Run main only under direct execution (tests import the helpers without side effects). */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main();
}
