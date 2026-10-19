#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Release-time eval freshness gate (P5a, blocking): since the last release
 * tag, any change to the memory/skill/injection surfaces requires a fresh
 * `compare.md` covering HEAD. Pure doc/version changes are exempt.
 *
 * `compare.md` (committed under `evals/runs/`) carries its own header:
 * `commit:` / `date:` / `arms:` on the first lines — `report.json` lives in
 * gitignored `runs/` detail and is unreadable on a clean checkout.
 *
 * Release-flow step 2 runs this; CI per-push and `run-gates all` do NOT
 * (freshness is a release-window property, not a per-commit one).
 *
 * Usage: tsx scripts/verify-eval-freshness.ts [--runs DIR] [--tag TAG] [--head SHA] [--changed a,b]
 * (--changed injects the changed-file list for fixture runs; otherwise git diff is used.)
 * Exit code 0 = pass, 1 = stale or missing compare.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Source faces whose change since the last tag demands a fresh four-arm run. */
export const TOUCH_PREFIXES = [
	"src/surfaces/",
	"src/services/memory",
	"src/services/skill",
	"src/services/prompt",
	"src/services/injection",
	"src/services/extraction",
	"src/services/review",
	"src/data/",
];

/** One committed compare report, reduced to its header. */
export interface CompareHeader {
	readonly file: string;
	readonly commit: string;
}

/** Parse a compare.md header (`commit:` line in the first 10 lines, bare or markdown-list form). */
export function parseCompareHeader(file: string, text: string): CompareHeader | undefined {
	for (const line of text.split("\n").slice(0, 10)) {
		const match = /^(?:-\s+)?commit:\s*([0-9a-f]{7,40})\s*$/.exec(line.trim());
		if (match?.[1]) {
			return { file, commit: match[1] };
		}
	}
	return undefined;
}

/** Collect every committed compare.md header under a runs directory. */
export function collectCompares(runsDir: string): CompareHeader[] {
	const found: CompareHeader[] = [];
	const walk = (dir: string): void => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			const full = join(dir, name);
			try {
				if (statSync(full).isDirectory()) {
					walk(full);
				} else if (name === "compare.md") {
					const header = parseCompareHeader(full, readFileSync(full, "utf8"));
					if (header !== undefined) {
						found.push(header);
					}
				}
			} catch {
				// Unreadable files are not evidence; skip them.
			}
		}
	};
	walk(runsDir);
	return found;
}

export interface FreshnessCheck {
	readonly ok: boolean;
	readonly reason: string;
}

/**
 * Pure check (importable by tests): touching changes since the tag need a
 * compare covering head; anything else passes.
 */
export function checkFreshness(args: { tag: string | undefined; head: string; changedFiles: readonly string[]; compares: readonly CompareHeader[] }): FreshnessCheck {
	const { tag, head, changedFiles, compares } = args;
	const touching = changedFiles.filter((file) => TOUCH_PREFIXES.some((prefix) => file.startsWith(prefix)));
	if (touching.length === 0) {
		return { ok: true, reason: "exempt: no memory/skill/injection surface changed" };
	}
	if (tag === undefined) {
		return { ok: false, reason: "no release tag yet and eval surfaces changed — run the four arms once to anchor" };
	}
	const covers = compares.some((compare) => head.startsWith(compare.commit) || compare.commit.startsWith(head));
	if (covers) {
		return { ok: true, reason: `fresh: a compare covers ${head.slice(0, 12)}` };
	}
	return {
		ok: false,
		reason: `stale: ${String(touching.length)} eval-surface file(s) changed since ${tag} with no compare covering ${head.slice(0, 12)} — run the four arms before release`,
	};
}

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function git(args: string[]): string {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

async function main(): Promise<number> {
	const root = join(import.meta.dirname, "..");
	const runsDir = argValue("--runs") ?? join(root, "evals", "runs");
	let tag = argValue("--tag");
	if (tag === undefined) {
		try {
			tag = git(["describe", "--tags", "--abbrev=0"]);
		} catch {
			tag = undefined;
		}
	}
	const head = argValue("--head") ?? git(["rev-parse", "HEAD"]);
	const changedArg = argValue("--changed");
	let changed: string[];
	if (changedArg !== undefined) {
		changed = changedArg.split(",").map((line) => line.trim()).filter((line) => line.length > 0);
	} else {
		try {
			changed = tag === undefined ? [] : git(["diff", "--name-only", `${tag}..HEAD`]).split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
		} catch (error) {
			console.log(`FAIL: cannot diff against ${tag ?? "(no tag)"}: ${error instanceof Error ? error.message : String(error)}`);
			return 1;
		}
	}
	const check = checkFreshness({ tag, head, changedFiles: changed, compares: existsSync(runsDir) ? collectCompares(runsDir) : [] });
	console.log(`${check.ok ? "OK" : "FAIL"}: ${check.reason}`);
	return check.ok ? 0 : 1;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	},
);
