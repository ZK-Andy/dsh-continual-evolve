#!/usr/bin/env -S ../node_modules/.bin/tsx
/**
 * change-scope — print the change scope (the minimum-evidence preamble for
 * review / push, replacing the original change-scope shell script).
 *
 * Three sections:
 *   base / head —— the two anchors of this range
 *   commits      —— the commit list of base..head
 *   changed      —— involved paths: committed diff + unstaged diff + untracked
 *                  files (deduped)
 *
 * Usage:
 *   tsx scripts/change-scope.ts [<base-ref> [<head-ref>]]   # explicit positionals
 *   tsx scripts/change-scope.ts --base <ref> [--head <ref>] # flag form (what the dsh-* skill docs call)
 *
 * The rule (from dsh-pre-push-checks' minimum evidence): never guess the
 * base — an explicit ref wins whenever one is given; automatic derivation is
 * a convenience only and its result needs human confirmation.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export interface ScopeArgs {
	base: string | undefined;
	head: string;
}

/** Parse positional and --base/--head forms (flags win over positionals). */
export function parseScopeArgs(argv: string[]): ScopeArgs {
	let base: string | undefined;
	let head = "HEAD";
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] as string;
		if (arg === "--base") {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new Error("change-scope: --base needs a value");
			}
			base = value;
			i += 1;
		} else if (arg === "--head") {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new Error("change-scope: --head needs a value");
			}
			head = value;
			i += 1;
		} else if (arg.startsWith("--")) {
			throw new Error(`change-scope: unknown flag ${JSON.stringify(arg)}`);
		} else {
			positionals.push(arg);
		}
	}
	if (base === undefined && positionals.length >= 1) {
		base = positionals[0];
	}
	if (positionals.length >= 2 && !argv.includes("--head")) {
		head = positionals[1] as string;
	}
	return { base, head };
}

/** Run git and return trimmed stdout ("" when git itself reports nothing). */
function git(...args: string[]): string {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** Short SHA of a ref ("?" when unresolvable, mirroring the shell version). */
export function shortRev(ref: string): string {
	try {
		return git("rev-parse", "--short", ref);
	} catch {
		return "?";
	}
}

/** Derive the base when none was given: fork-point, else the root commit. */
export function deriveBase(): string {
	const forkPoint = (() => {
		try {
			return git("merge-base", "--fork-point", "HEAD");
		} catch {
			return "";
		}
	})();
	if (forkPoint.length > 0) {
		return forkPoint;
	}
	const roots = (() => {
		try {
			return git("rev-list", "--max-parents=0", "HEAD");
		} catch {
			return "";
		}
	})();
	const root = roots.split("\n").filter((line) => line.length > 0).at(-1) ?? "";
	if (root.length === 0) {
		throw new Error("change-scope: cannot determine base (no history?)");
	}
	return root;
}

/** Committed + unstaged + untracked paths, deduped and sorted. */
export function changedPaths(base: string, head: string): string[] {
	const collected: string[] = [];
	const take = (text: string): void => {
		for (const line of text.split("\n")) {
			const path = line.trim();
			if (path.length > 0) {
				collected.push(path);
			}
		}
	};
	try {
		take(git("diff", "--name-only", `${base}...${head}`));
	} catch {
		// Unresolvable range (missing objects / exotic refs): fall through to
		// the worktree diffs below rather than failing silently empty.
	}
	try {
		take(git("diff", "--name-only"));
	} catch {
		// Outside a worktree read: ignore, untracked listing still runs.
	}
	try {
		take(git("ls-files", "--others", "--exclude-standard"));
	} catch {
		// Ignore: committed/unstaged diffs above already reported.
	}
	return [...new Set(collected)].sort();
}

/** One-line-per-commit log of the range ("" when the range is unreadable). */
export function rangeCommits(base: string, head: string): string {
	try {
		return git("log", "--oneline", `${base}..${head}`);
	} catch {
		return "";
	}
}

/** Render the three-section report exactly like the retired shell script. */
export function formatScope(base: string, head: string, explicitBase: boolean, explicitHead: boolean): string {
	const lines = [
		`== base:  ${base}  (${shortRev(base)}${explicitBase ? " from arg" : ""})`,
		`== head:  ${head}  (${shortRev(head)}${explicitHead ? " from arg" : ""})`,
		"",
		`== commits (${base}..${head}):`,
		rangeCommits(base, head),
		"",
		"== changed paths:",
		...changedPaths(base, head),
	];
	return `${lines.join("\n")}\n`;
}

function main(): void {
	let args: ScopeArgs;
	try {
		args = parseScopeArgs(process.argv.slice(2));
	} catch (error) {
		console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	let base: string;
	try {
		base = args.base ?? deriveBase();
	} catch (error) {
		console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	const argv = process.argv.slice(2);
	process.stdout.write(formatScope(base, args.head, args.base !== undefined, argv.includes("--head") || argv.length >= 2));
}

/** Run main only under direct execution (tests import the helpers without side effects). */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
