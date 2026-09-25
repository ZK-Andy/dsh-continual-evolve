#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify Agent Note (ADR) format: header block, skeleton, status-directory consistency.
 *
 * Checks, for every .md under .agents/notes/ (excluding archived/ and .zh.md files):
 *  1. Line 1 is "# Agent Note: <title>"; the "Status: <status>" line follows the
 *     title, and a blank line between title and Status is allowed.
 *  2. Status value matches the lifecycle folder (proposed/implemented/rejected)
 *  3. Required skeleton sections exist (## Problem, ## Alternatives considered,
 *     plus lifecycle-specific: ## Decision/## Consequences for implemented,
 *     ## Proposal for proposed)
 *  4. implemented notes must NOT contain spec-speak headings
 *     (## Proposal / ## Plan / ## Migration plan / ## Acceptance criteria)
 *
 * Usage: tsx scripts/verify-adr-format.ts [notes_root]
 * Exit code 0 = pass, 1 = violations found.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const HEADER_RE = /^# Agent Note: .+$/;
const STATUS_RE = /^Status: (proposed|implemented|rejected(?: — .+)?)$/;
const STATUS_BY_DIR: Record<string, string> = {
	proposed: "proposed",
	implemented: "implemented",
	rejected: "rejected",
};
const BANNED_IN_IMPLEMENTED = ["## Proposal", "## Plan", "## Migration plan", "## Acceptance criteria"];
const REQUIRED_ALL = ["## Problem", "## Alternatives considered"];
const REQUIRED_IMPLEMENTED = ["## Decision", "## Consequences"];
const REQUIRED_PROPOSED = ["## Proposal"];

function collectMd(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) collectMd(full, out);
		else if (name.endsWith(".md")) out.push(full);
	}
	return out;
}

function main(): number {
	const root = process.argv[2] ?? ".agents/notes";
	try {
		if (!statSync(root).isDirectory()) {
			console.log(`SKIP: ${root} does not exist (no Agent Notes tree)`);
			return 0;
		}
	} catch {
		console.log(`SKIP: ${root} does not exist (no Agent Notes tree)`);
		return 0;
	}

	const errors: string[] = [];
	let checked = 0;
	for (const note of collectMd(root).sort()) {
		const rel = relative(root, note);
		const parts = rel.split("/");
		if (parts.includes("archived") || note.endsWith(".zh.md")) continue;
		const lifecycle = parts[0] ?? "";
		if (!(lifecycle in STATUS_BY_DIR)) continue;
		checked += 1;
		const text = readFileSync(note, "utf-8");
		const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));

		if (lines.length === 0 || !HEADER_RE.test(lines[0]!)) {
			errors.push(`${rel}: line 1 must be '# Agent Note: <title>'`);
		}
		const statusLine = lines.slice(1).find((l) => l.trim() !== "") ?? "";
		const statusM = STATUS_RE.exec(statusLine);
		if (statusM === null) {
			errors.push(`${rel}: must contain 'Status: <proposed|implemented|rejected>' after the title`);
		} else if (statusM[1] !== lifecycle) {
			errors.push(`${rel}: Status '${statusM[1]}' mismatches folder '${lifecycle}'`);
		}

		const stripped = new Set(lines.map((l) => l.trim()));
		for (const sec of REQUIRED_ALL) {
			if (!stripped.has(sec)) errors.push(`${rel}: missing required section '${sec}'`);
		}
		if (lifecycle === "implemented") {
			for (const sec of REQUIRED_IMPLEMENTED) {
				if (!stripped.has(sec)) errors.push(`${rel}: missing required section '${sec}'`);
			}
			for (const banned of BANNED_IN_IMPLEMENTED) {
				if (stripped.has(banned)) errors.push(`${rel}: implemented note must not contain '${banned}'`);
			}
		} else if (lifecycle === "proposed") {
			for (const sec of REQUIRED_PROPOSED) {
				if (!stripped.has(sec)) errors.push(`${rel}: missing required section '${sec}'`);
			}
		}
	}

	console.log(`Checked ${checked} Agent Notes`);
	if (errors.length > 0) {
		for (const e of errors) console.log(`FAIL: ${e}`);
		return 1;
	}
	console.log("OK");
	return 0;
}

process.exitCode = main();
