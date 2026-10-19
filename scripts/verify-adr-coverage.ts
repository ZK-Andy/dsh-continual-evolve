#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify ADR coverage (backlog G1): a diff that touches src/ must carry
 * an Agent Note under .agents/notes/.
 *
 * Rule: when the changed paths contain src/, the same diff must contain
 * at least one .agents/notes/proposed-or-implemented note (archived and
 * .zh.md files do not count). Pure docs/test/scripts diffs — i.e. diffs
 * without src/ — pass untouched. A PR labelled no-adr (human approval
 * point) passes --allow-no-adr explicitly instead of silently.
 *
 * Change source (first match wins):
 *   --changed-file PATH  read newline-separated paths (fixture / CI list mode)
 *   --base REF [--head]  git diff --name-only BASE...HEAD
 *   (default)            worktree diff: HEAD + staged + untracked
 *
 * Usage: tsx scripts/verify-adr-coverage.ts [--base REF [--head REF]] [--changed-file PATH] [--allow-no-adr]
 * Exit code 0 = pass (or SKIP outside a git repo), 1 = src changed without an ADR.
 *
 * Note: block comments here avoid backticks on purpose — a backticked glob
 * like star-star-slash ends the comment early and breaks tsc (TS1005).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface CoverageResult {
	readonly ok: boolean;
	readonly message: string;
}

/** Repo-relative posix normalisation (strip leading dot-slash, dedupe, sort). */
export function normalizeChanged(paths: readonly string[]): string[] {
	const out = new Set<string>();
	for (const raw of paths) {
		const posix = raw.replace(/\\/g, "/").trim().replace(/^\.\//, "");
		if (posix.length > 0) out.add(posix);
	}
	return [...out].sort();
}

/**
 * Pure check (importable by tests): src/ changed without a
 * proposed/implemented note fails; everything else passes.
 */
export function checkAdrCoverage(changedRaw: readonly string[], allowNoAdr = false): CoverageResult {
	const changed = normalizeChanged(changedRaw);
	const srcChanged = changed.filter((p) => p === "src" || p.startsWith("src/"));
	if (srcChanged.length === 0) {
		return { ok: true, message: "OK（无 src 改动，不要求 ADR）" };
	}
	if (allowNoAdr) {
		return { ok: true, message: "OK（no-adr 豁免：人工批准点已确认）" };
	}
	const notes = changed.filter((p) => {
		if (!p.startsWith(".agents/notes/") || !p.endsWith(".md")) return false;
		if (p.includes("/archived/") || p.endsWith(".zh.md")) return false;
		const lifecycle = p.split("/")[2];
		return lifecycle === "proposed" || lifecycle === "implemented";
	});
	if (notes.length > 0) {
		return { ok: true, message: `OK（${srcChanged.length} src 文件 + ${notes.length} ADR）` };
	}
	return {
		ok: false,
		message: `FAIL: ${srcChanged.length} src 文件改动未带 ADR（.agents/notes/proposed|implemented/**/*.md）：${srcChanged.slice(0, 5).join(", ")}${srcChanged.length > 5 ? ` 等 ${srcChanged.length} 个` : ""}`,
	};
}

function gitLines(...args: string[]): string[] {
	try {
		const out = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return out.length > 0 ? out.split("\n") : [];
	} catch {
		return [];
	}
}

function inRepo(): boolean {
	try {
		execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "ignore"] });
		return true;
	} catch {
		return false;
	}
}

/** Worktree changed paths: committed-vs-HEAD + staged + untracked (mirrors change-scope). */
function worktreeChanged(): string[] {
	const collected: string[] = [];
	for (const lines of [gitLines("diff", "--name-only", "HEAD"), gitLines("diff", "--cached", "--name-only"), gitLines("ls-files", "--others", "--exclude-standard")]) {
		collected.push(...lines);
	}
	return [...new Set(collected)].sort();
}

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
	const changedFile = argValue("--changed-file");
	const allowNoAdr = process.argv.includes("--allow-no-adr");
	let changed: string[];
	if (changedFile !== undefined) {
		if (!existsSync(changedFile)) {
			console.log(`FAIL: --changed-file 缺失：${changedFile}`);
			return 1;
		}
		changed = readFileSync(changedFile, "utf-8").split("\n");
	} else if (process.argv.includes("--base")) {
		const base = argValue("--base") ?? "";
		const head = argValue("--head") ?? "HEAD";
		if (base.length === 0) {
			console.log("FAIL: --base 需要一个值");
			return 1;
		}
		changed = gitLines("diff", "--name-only", `${base}...${head}`);
	} else {
		if (!inRepo()) {
			console.log("SKIP: not inside a git worktree (no change scope to check)");
			return 0;
		}
		changed = worktreeChanged();
	}
	const result = checkAdrCoverage(changed, allowNoAdr);
	console.log(result.message);
	if (!result.ok) {
		console.log("改行为须同变更携带 ADR；纯机械改动确无行为变化时，用 --allow-no-adr（PR 标签 no-adr，人工批准）显式豁免");
	}
	return result.ok ? 0 : 1;
}

/** Run main only under direct execution (tests import the helpers without side effects). */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	if (!process.argv.includes("--self-import")) {
		try {
			if (statSync(".agents/notes").isDirectory()) void 0;
		} catch {
			// Notes tree absence is fine: checkAdrCoverage decides by paths, not by tree presence.
		}
	}
	process.exitCode = main();
}
