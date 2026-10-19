#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify module budgets (docs/architecture-standard.md §2): src
 * single-file lines ≤ 400, internal-module out-degree ≤ 12 (assembly root
 * index.ts ≤ 14). Single-function lines ≤ 80 is soft in src: reported as
 * warnings, never fails; hard in client/*.js (god functions banned, while
 * the bundle file itself carries no line budget).
 *
 * Line counts use wc -l semantics (newline characters). Out-degree counts
 * distinct relative (./ or ../) module specifiers in static and dynamic
 * imports. Function spans are a brace-matching heuristic over candidate
 * starts — good enough for a warning channel, not a proof.
 *
 * Usage: tsx scripts/verify-src-budgets.ts [src_root]
 * Exit code 0 = pass (warnings allowed), 1 = hard-budget violations found.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { lineCount, outDegree } from "./budget-measure.js";

const MAX_FILE_LINES = 400;
const MAX_OUT_DEGREE = 12;
const MAX_OUT_DEGREE_ROOT = 14;
const ASSEMBLY_ROOT = "index.ts";
const SOFT_MAX_FUNCTION_LINES = 80;
const MAX_WARNS_PER_FILE = 3;

function collectTs(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) collectTs(full, out);
		else if (name.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** client/ is one hand-written bundle: collect its .js sources for the function gate. */
function collectJs(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) collectJs(full, out);
		else if (name.endsWith(".js")) out.push(full);
	}
	return out;
}

/** Out-degree counts and function spans live in their single homes:
 * specifiers in `./budget-measure.js`, spans below (warning channel only). */

const FN_START_RES = [
	/^\t{0,2}(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/,
	/^\t{1,2}(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^;{}]*\)\s*\{/,
	/^\t(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\([^;{}]*\)\s*=>\s*\{/,
];
const KEYWORD_START_RE = /^\s*(?:if|for|while|switch|catch|with|return)\b/;

interface FnSpan {
	readonly name: string;
	readonly lines: number;
}

function fnNameOf(line: string): string {
	const m = /(?:function\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(line);
	const name = m?.[1];
	return name ?? "<anonymous>";
}

/**
 * Heuristic function spans: from each candidate start line, walk braces
 * while skipping line/block comments and string/template literals.
 */
function functionSpans(text: string): FnSpan[] {
	const lines = text.split("\n");
	const spans: FnSpan[] = [];
	for (let start = 0; start < lines.length; start += 1) {
		const raw = lines[start];
		if (raw === undefined) continue;
		const line = raw.replace(/\r$/, "");
		if (KEYWORD_START_RE.test(line)) continue;
		if (!FN_START_RES.some((re) => re.test(line))) continue;
		let depth = 0;
		let inStr: string | null = null;
		let inBlock = false;
		let end = -1;
		for (let i = start; i < lines.length && end < 0; i += 1) {
			const cur = lines[i];
			if (cur === undefined) break;
			let j = i === start ? cur.indexOf("{") : 0;
			if (j < 0) continue;
			for (; j < cur.length; j += 1) {
				const ch = cur[j];
				const next = cur[j + 1] ?? "";
				if (inStr !== null) {
					if (ch === "\\") j += 1;
					else if (ch === inStr) inStr = null;
				} else if (inBlock) {
					if (ch === "*" && next === "/") {
						inBlock = false;
						j += 1;
					}
				} else if (ch === "/" && next === "/") {
					break;
				} else if (ch === "/" && next === "*") {
					inBlock = true;
					j += 1;
				} else if (ch === "'" || ch === '"' || ch === "`") {
					inStr = ch;
				} else if (ch === "{") {
					depth += 1;
				} else if (ch === "}") {
					depth -= 1;
					if (depth === 0) {
						end = i;
						break;
					}
				}
			}
		}
		if (end >= start) spans.push({ name: fnNameOf(line), lines: end - start + 1 });
	}
	return spans;
}

function main(): number {
	const root = process.argv[2] ?? "src";
	let files: string[];
	try {
		if (!statSync(root).isDirectory()) {
			console.log(`SKIP: ${root} does not exist (no src tree)`);
			return 0;
		}
		files = collectTs(root).sort();
	} catch {
		console.log(`SKIP: ${root} does not exist (no src tree)`);
		return 0;
	}
	const errors: string[] = [];
	const warns: string[] = [];
	for (const file of files) {
		const rel = relative(".", file);
		const text = readFileSync(file, "utf-8");
		const lines = lineCount(text);
		if (lines > MAX_FILE_LINES) {
			errors.push(`${rel}: ${lines} lines exceeds budget ${MAX_FILE_LINES}`);
		}
		const degree = outDegree(text);
		const cap = file.endsWith(`/${ASSEMBLY_ROOT}`) || rel === ASSEMBLY_ROOT ? MAX_OUT_DEGREE_ROOT : MAX_OUT_DEGREE;
		if (degree.length > cap) {
			errors.push(`${rel}: out-degree ${degree.length} exceeds budget ${cap} (${degree.join(", ")})`);
		}
		const long = functionSpans(text)
			.filter((s) => s.lines > SOFT_MAX_FUNCTION_LINES)
			.sort((a, b) => b.lines - a.lines);
		long.slice(0, MAX_WARNS_PER_FILE).forEach((s) => {
			warns.push(`${rel}: function ${s.name} ~${s.lines} lines exceeds soft budget ${SOFT_MAX_FUNCTION_LINES}`);
		});
		if (long.length > MAX_WARNS_PER_FILE) {
			warns.push(`${rel}: … and ${long.length - MAX_WARNS_PER_FILE} more long functions`);
		}
	}
	console.log(`Checked ${files.length} src modules`);
	for (const e of errors) console.log(`FAIL: ${e}`);
	for (const w of warns) console.log(`WARN: ${w}`);
	// §2: the client bundle has no file-line budget, but god functions are
	// banned — over-long client functions fail the gate, not warn.
	try {
		if (statSync("client").isDirectory()) {
			const jsFiles = collectJs("client").sort();
			console.log(`Checked ${jsFiles.length} client bundles`);
			for (const file of jsFiles) {
				const rel = relative(".", file);
				const text = readFileSync(file, "utf-8");
				for (const span of functionSpans(text).filter((s) => s.lines > SOFT_MAX_FUNCTION_LINES)) {
					errors.push(`${rel}: function ${span.name} ~${span.lines} lines exceeds hard budget ${SOFT_MAX_FUNCTION_LINES}`);
				}
			}
		}
	} catch {
		console.log("SKIP: client does not exist (no client tree)");
	}
	for (const e of errors) {
		if (!e.startsWith("client/")) continue;
		console.log(`FAIL: ${e}`);
	}
	return errors.length > 0 ? 1 : 0;
}

process.exitCode = main();
