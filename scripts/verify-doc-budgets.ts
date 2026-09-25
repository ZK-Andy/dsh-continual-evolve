#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify word budgets for standing docs, driven by a manifest JSON.
 *
 * Manifest format (scripts/doc-budgets.manifest.json by default or passed via --manifest):
 * {
 *   "budgets": [
 *     {"path": "AGENTS.md", "max_words": 800}
 *   ]
 * }
 * Entry paths are relative to the repo root where you run the check.
 *
 * Missing file = violation. Over-limit = violation with word count.
 *
 * Usage:
 *   tsx scripts/verify-doc-budgets.ts                 # manifest at ./scripts/doc-budgets.manifest.json
 *   tsx scripts/verify-doc-budgets.ts --manifest <p>  # explicit manifest path
 * Exit code 0 = pass, 1 = violations.
 */
import { existsSync, readFileSync } from "node:fs";

const WORD_RE = /[\w\u4e00-\u9fff]+/gu;

function countWords(text: string): number {
	const body = text
		.replace(/```.*?```/gs, "")
		.replace(/^\s*\|.*\|\s*$/gm, "");
	return body.match(WORD_RE)?.length ?? 0;
}

function main(): number {
	const flagAt = process.argv.indexOf("--manifest");
	const manifestPath = flagAt >= 0 ? (process.argv[flagAt + 1] ?? "scripts/doc-budgets.manifest.json") : "scripts/doc-budgets.manifest.json";
	if (!existsSync(manifestPath)) {
		console.log(`SKIP: manifest ${manifestPath} not found`);
		return 0;
	}
	const data = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
		budgets: { path: string; max_words: number }[];
	};

	const errors: string[] = [];
	for (const entry of data.budgets) {
		const limit = Number(entry.max_words);
		if (!existsSync(entry.path)) {
			errors.push(`${entry.path}: budget entry but file missing (stale manifest?)`);
			continue;
		}
		const words = countWords(readFileSync(entry.path, "utf-8"));
		if (words > limit) {
			errors.push(`${entry.path}: ${words} words > budget ${limit} (relocate, condense, or raise ceiling with justification)`);
		} else {
			console.log(`OK   ${entry.path}: ${words}/${limit}`);
		}
	}

	if (errors.length > 0) {
		for (const e of errors) console.log(`FAIL: ${e}`);
		return 1;
	}
	console.log("OK");
	return 0;
}

process.exitCode = main();
