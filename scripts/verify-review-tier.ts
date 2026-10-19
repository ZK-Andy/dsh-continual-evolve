#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify review tier (review-tier-escape-proofing, TS port).
 *
 * Mechanical FULL/LIGHT classification — no executor discretion. Ported from
 * dotnet-deepseek-harness-desktop `scripts/verify-review-tier.py`; trigger
 * paths are remapped to this repo (TS single-stack, see ADR
 * `proposed/process/2026-10-19-review-triple-ts-gates.md`).
 *
 * Tier classification (FULL = R1/R2/R3 required, evidence must travel):
 *   - compose-root: src/index.ts, src/assemble.ts, src/store.ts,
 *     src/store-types.ts
 *   - gate-criteria: scripts/verify-*.ts, scripts/layers.json,
 *     scripts/fn-shape-baseline.json, cordis.patch.yml, .githooks/**
 *   - adr-promises-full: proposed ADR whose body contains "三重审核"
 *   - behavior-surface: .github/workflows/**, templates/**, docs/**,
 *     client/**, evals/**, assets/** — except `evals/runs/**`: committed
 *     four-arm run data is machine output (`evolve_eval_run` → compare.md),
 *     not human design; its anti-fake property is owned mechanically by
 *     `verify-eval-freshness` (commit must cover HEAD), not by human review.
 *     Human-curated evals (`tasks/`, `baseline/`, README) stay FULL.
 *
 * Evidence = an implemented ADR in THIS change set whose header zone carries
 * a newly produced `Review: FULL/<date>[#N]/R1=ok R2=ok R3=ok` line (single
 * spaces, `#N` = same-day ordinal). Freshness: the line must be among the
 * added lines AND absent verbatim from the note at base AND not inherited
 * from a note this batch deletes/renames away. An undeterminable diff is a
 * violation, never an empty pass.
 *
 * Change source (first match wins):
 *   --changed-file PATH  newline-separated paths (fixture / CI list mode;
 *                        notes are read from --repo)
 *   --staged             index vs HEAD (pre-commit use)
 *   --base REF [--head]  REF..HEAD committed range (pre-push / CI use)
 *   (default)            worktree: HEAD + cached + worktree + untracked
 *
 * Usage: tsx scripts/verify-review-tier.ts [--repo ROOT] [--staged | --base REF [--head REF] | --changed-file PATH]
 * Exit code 0 = pass, 1 = violations.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const NOTES_DIR = ".agents/notes";

/** Canonical evidence line: R tokens separated by exactly one space. */
export const REVIEW_LINE_RE = /^Review: FULL\/(?<date>\d{4}-\d{2}-\d{2})(?:#(?<seq>[1-9]\d*))?\/R1=ok R2=ok R3=ok$/;

export const FULL_TIER_WORDS: readonly string[] = ["三重审核"];

const ROOT_FILES = new Set(["src/index.ts", "src/assemble.ts", "src/store.ts", "src/store-types.ts"]);

export interface TierMode {
	readonly stagedOnly: boolean;
	readonly since: string | undefined;
	readonly head: string;
	readonly changedFile: string | undefined;
}

function gitLines(repo: string, args: readonly string[]): string[] | undefined {
	try {
		const out = execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return out.length > 0 ? out.split("\n") : [];
	} catch {
		return undefined;
	}
}

function gitText(repo: string, args: readonly string[]): string | undefined {
	try {
		return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return undefined;
	}
}

/** Repo-relative posix normalisation (strip leading ./, dedupe, sort). */
export function normalizeChanged(paths: readonly string[]): string[] {
	const out = new Set<string>();
	for (const raw of paths) {
		const p = raw.replace(/\\/g, "/").trim().replace(/^\.\//, "");
		if (p.length > 0) out.add(p);
	}
	return [...out].sort();
}

export function isValidDate(s: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const [y, m, d] = s.split("-").map(Number) as [number, number, number];
	if (m < 1 || m > 12 || d < 1 || d > 31) return false;
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function baseName(p: string): string {
	return p.split("/").at(-1) ?? p;
}

function adrText(rel: string, repo: string, stagedOnly: boolean): string | undefined {
	if (stagedOnly) {
		const out = gitText(repo, ["show", `:${rel}`]);
		return out;
	}
	try {
		return readFileSync(join(repo, rel), "utf-8");
	} catch {
		return undefined;
	}
}

function adrCommitsFull(rel: string, repo: string, stagedOnly: boolean): boolean {
	if (!rel.endsWith(".md") || !rel.startsWith(`${NOTES_DIR}/`)) return false;
	if (!rel.includes("/")) return false;
	const text = adrText(rel, repo, stagedOnly);
	if (text === undefined) return false;
	return text.includes("Status: proposed") && FULL_TIER_WORDS.some((w) => text.includes(w));
}

/** Behavior-surface directories: any path segment match (git only yields files, so bare-dir equivalence is exact). */
const SURFACE_DIRS = ["templates", "docs", "client", "evals", "assets"] as const;

/**
 * Machine-output run data: committed four-arm reports under `evals/runs/`.
 * Exempt from behavior-surface FULL (see header comment): no human design
 * to review, anti-fake owned by `verify-eval-freshness`.
 */
const EVAL_RUNS_PREFIX = "evals/runs/";

/**
 * Pure tier classification (importable by tests). The adr-promises-full leg
 * reads proposed ADR bodies from repo (staged index in --staged mode, else
 * the worktree); everything else is path-only.
 */
export function classifyTier(
	paths: readonly string[],
	repo: string,
	opts?: { readonly stagedOnly?: boolean },
): { readonly full: boolean; readonly reasons: readonly string[] } {
	const stagedOnly = opts?.stagedOnly ?? false;
	const reasons: string[] = [];
	let full = false;
	for (const rel of paths) {
		const name = baseName(rel);
		const segs = rel.split("/");
		let hit: string | undefined;
		if (ROOT_FILES.has(rel)) {
			hit = `compose-root: ${rel}`;
		} else if (
			(name.startsWith("verify-") && (rel.startsWith("scripts/") || rel.includes("/scripts/")) && (name.endsWith(".ts") || name.endsWith(".py") || name.endsWith(".sh"))) ||
			rel === "scripts/layers.json" ||
			rel === "scripts/fn-shape-baseline.json" ||
			rel === "cordis.patch.yml" ||
			rel.startsWith(".githooks/") ||
			rel.includes("/.githooks/")
		) {
			hit = `gate-criteria: ${rel}`;
		} else if (
			!rel.startsWith(EVAL_RUNS_PREFIX) &&
			(rel.startsWith(".github/workflows/") || SURFACE_DIRS.some((d) => (segs as readonly string[]).includes(d)))
		) {
			hit = `behavior-surface: ${rel}`;
		} else if (adrCommitsFull(rel, repo, stagedOnly)) {
			hit = `adr-promises-full: ${rel}`;
		}
		if (hit !== undefined) {
			full = true;
			if (!reasons.includes(hit)) {
				reasons.push(hit);
			}
		}
	}
	return { full, reasons };
}

/** Header zone: everything above the first `## ` heading (capped at 60 lines). */
export function headerZone(text: string): string[] {
	const lines = text.split("\n").slice(0, 60);
	for (let i = 0; i < lines.length; i += 1) {
		if ((lines[i] ?? "").startsWith("## ")) return lines.slice(0, i);
	}
	return lines;
}

function noteTitle(head: string[]): string {
	for (const ln of head) {
		if (ln.trim().startsWith("# Agent Note:")) return ln.trim();
	}
	return "";
}

function changedPathsOrError(repo: string, mode: TierMode): { readonly paths: string[] | undefined; readonly error: string | undefined } {
	if (mode.changedFile !== undefined) {
		try {
			const text = readFileSync(mode.changedFile, "utf-8");
			return { paths: normalizeChanged(text.split("\n")), error: undefined };
		} catch {
			return { paths: undefined, error: `--changed-file 缺失或不可读：${mode.changedFile}` };
		}
	}
	if (mode.stagedOnly) {
		const lines = gitLines(repo, ["diff", "--cached", "--name-only"]);
		if (lines === undefined) return { paths: undefined, error: "`git diff --cached --name-only` failed" };
		return { paths: normalizeChanged(lines), error: undefined };
	}
	if (mode.since !== undefined) {
		const lines = gitLines(repo, ["diff", "--name-only", `${mode.since}..${mode.head}`]);
		if (lines === undefined) {
			return { paths: undefined, error: `cannot determine the change set: \`git diff --name-only ${mode.since}..${mode.head}\` failed (unreachable base?)` };
		}
		return { paths: normalizeChanged(lines), error: undefined };
	}
	const out = new Set<string>();
	const batches: Array<readonly string[]> = [
		gitLines(repo, ["diff", "--name-only", "HEAD"]) ?? [],
		gitLines(repo, ["diff", "--cached", "--name-only"]) ?? [],
		gitLines(repo, ["diff", "--name-only"]) ?? [],
	];
	// Any git failure in worktree mode degrades to whatever was collected;
	// an undeterminable committed range (above) is the one that fails loud.
	for (const lines of batches) for (const l of lines) if (l.trim().length > 0) out.add(l.trim());
	const untracked = gitLines(repo, ["ls-files", "--others", "--exclude-standard"]);
	if (untracked !== undefined) for (const l of untracked) if (l.trim().length > 0) out.add(l.trim());
	// Detect total git failure (not a worktree at all): all three collectors
	// returned undefined. gitLines maps failure to undefined, but the `?? []`
	// above already collapsed it — re-probe cheaply via rev-parse.
	if (out.size === 0) {
		const probe = gitText(repo, ["rev-parse", "--is-inside-work-tree"]);
		if (probe === undefined) return { paths: undefined, error: "cannot determine the change set: not inside a git worktree" };
	}
	return { paths: [...out].sort(), error: undefined };
}

function noteText(rel: string, repo: string, mode: TierMode): string | undefined {
	if (mode.stagedOnly) {
		const out = gitText(repo, ["show", `:${rel}`]);
		return out;
	}
	try {
		return readFileSync(join(repo, rel), "utf-8");
	} catch {
		return undefined;
	}
}

function baseNoteText(rel: string, repo: string, mode: TierMode): string | undefined {
	const base = mode.since ?? "HEAD";
	const out = gitText(repo, ["show", `${base}:${rel}`]);
	return out ?? undefined;
}

function addedLinesFor(rel: string, repo: string, mode: TierMode): Set<string> | undefined {
	const added = new Set<string>();
	const collect = (args: readonly string[]): boolean => {
		const out = gitText(repo, ["diff", ...args, "--", rel]);
		if (out === undefined) return false;
		for (const line of out.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) added.add(line.slice(1).trim());
		}
		return true;
	};
	if (mode.changedFile !== undefined) {
		// Fixture / list mode has no diff: treat the note's current lines as
		// added (lets a clean fixture with fresh evidence pass, while a batch
		// without any Review line still fails). Base comparison below still
		// applies when the repo is a git checkout.
		try {
			const text = readFileSync(join(repo, rel), "utf-8");
			for (const l of text.split("\n")) added.add(l.trim());
			return added;
		} catch {
			return undefined;
		}
	}
	if (mode.stagedOnly) {
		return collect(["--cached", "-U0"]) ? added : undefined;
	}
	if (mode.since !== undefined) {
		return collect(["-U0", `${mode.since}..${mode.head}`]) ? added : undefined;
	}
	if (!collect(["-U0", "HEAD"])) return undefined;
	const untracked = gitLines(repo, ["ls-files", "--others", "--exclude-standard", "--", rel]);
	if (untracked === undefined) return undefined;
	if (untracked.some((l) => l.trim().length > 0)) {
		try {
			const text = readFileSync(join(repo, rel), "utf-8");
			for (const l of text.split("\n")) added.add(l.trim());
		} catch {
			return undefined;
		}
	}
	return added;
}

function inheritedReviewLines(
	repo: string,
	mode: TierMode,
): { readonly byTitle: Set<string>; readonly byPath: Map<string, Set<string>> } | undefined {
	if (mode.changedFile !== undefined) return { byTitle: new Set(), byPath: new Map() };
	const base = mode.since ?? "HEAD";
	const args: readonly string[] = mode.stagedOnly
		? ["diff", "--cached", "--name-status", "-M"]
		: mode.since !== undefined
			? ["diff", "--name-status", "-M", `${mode.since}..${mode.head}`]
			: ["diff", "--name-status", "-M", "HEAD"];
	const out = gitText(repo, args);
	if (out === undefined) return undefined;
	const gone: Array<{ readonly old: string; readonly dest: string | undefined }> = [];
	for (const row of out.split("\n")) {
		if (row.trim().length === 0) continue;
		const fields = row.split("\t");
		const status = fields[0] ?? "";
		const old = fields[1] ?? "";
		if (!old.startsWith(NOTES_DIR) || !old.endsWith(".md")) continue;
		if (status.startsWith("D")) gone.push({ old, dest: undefined });
		else if (status.startsWith("R") && fields.length >= 3) gone.push({ old, dest: fields[2] });
	}
	const byTitle = new Set<string>();
	const byPath = new Map<string, Set<string>>();
	for (const { old, dest } of gone) {
		const pre = gitText(repo, ["show", `${base}:${old}`]);
		if (pre === undefined) continue;
		const lines = pre.split("\n");
		const title = lines.find((ln) => ln.trim().startsWith("# Agent Note:"))?.trim() ?? "";
		for (const ln of lines) {
			const stripped = ln.trim();
			const m = REVIEW_LINE_RE.exec(stripped);
			if (m?.groups === undefined || !isValidDate(m.groups["date"] ?? "")) continue;
			byTitle.add(`${title}<SEP>${stripped}`);
			if (dest !== undefined) {
				const set = byPath.get(dest) ?? new Set<string>();
				set.add(stripped);
				byPath.set(dest, set);
			}
		}
	}
	return { byTitle, byPath };
}

function evidenceViolation(paths: readonly string[], repo: string, mode: TierMode): string | undefined {
	for (const rel of paths) {
		if (!rel.startsWith(`${NOTES_DIR}/`) && rel !== NOTES_DIR) continue;
		if (!rel.endsWith(".md")) continue;
		const raw = noteText(rel, repo, mode);
		if (raw === undefined) continue;
		const head = headerZone(raw);
		if (!head.join("\n").includes("Status: implemented")) continue;
		const title = noteTitle(head);
		let added: Set<string> | undefined;
		let baseLines: string[] | undefined;
		let inherited: { readonly byTitle: Set<string>; readonly byPath: Map<string, Set<string>> } | undefined;
		for (const line of head) {
			const stripped = line.trim();
			const m = REVIEW_LINE_RE.exec(stripped);
			if (m?.groups === undefined || !isValidDate(m.groups["date"] ?? "")) continue;
			if (added === undefined) {
				const got = addedLinesFor(rel, repo, mode);
				if (got === undefined) {
					return `cannot read the diff of ${rel} (git failed) — the evidence gate fails loud instead of guessing`;
				}
				added = got;
			}
			if (!added.has(stripped)) continue;
			if (baseLines === undefined) {
				const baseRaw = baseNoteText(rel, repo, mode);
				baseLines = baseRaw !== undefined ? baseRaw.split("\n") : [];
			}
			if (baseLines.some((ln) => ln.trim() === stripped)) continue;
			if (inherited === undefined) {
				const got = inheritedReviewLines(repo, mode);
				if (got === undefined) {
					return "cannot determine which notes this change set removes (git failed) — the evidence gate fails loud instead of treating an unknown inherited set as empty";
				}
				inherited = got;
			}
			if (inherited.byTitle.has(`${title}<SEP>${stripped}`) || (inherited.byPath.get(rel)?.has(stripped) ?? false)) continue;
			return undefined;
		}
	}
	return "no implemented ADR in the change set carries a newly produced Review: FULL/<date>[#N]/R1=ok R2=ok R3=ok line (single spaces; evidence must be newly produced by the batch)";
}

/** Full scan returning violation strings (empty = pass). Exported for tests. */
export function scanTier(repo: string, mode: TierMode): string[] {
	const { paths, error } = changedPathsOrError(repo, mode);
	if (error !== undefined || paths === undefined) {
		return [`cannot determine the change set: ${error ?? "unknown git failure"} — an undeterminable diff must not pass the review-tier gate`];
	}
	if (paths.length === 0) return [];
	const { full, reasons } = classifyTier(paths, repo, { stagedOnly: mode.stagedOnly });
	if (!full) return [];
	const bad = evidenceViolation(paths, repo, mode);
	if (bad === undefined) return [];
	return [`FULL-tier change lacks review evidence (${reasons.length} trigger(s)): ${reasons.join("; ")} | ${bad}`];
}

function argValue(argv: readonly string[], flag: string): string | undefined {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
}

function parseMode(argv: readonly string[]): TierMode | { readonly parseError: string } {
	const changedFile = argValue(argv, "--changed-file");
	const stagedOnly = argv.includes("--staged");
	const since = argValue(argv, "--since") ?? argValue(argv, "--base");
	const head = argValue(argv, "--head") ?? "HEAD";
	if (stagedOnly && since !== undefined) return { parseError: "error: --staged and --since/--base are mutually exclusive" };
	if (changedFile !== undefined && (stagedOnly || since !== undefined)) {
		return { parseError: "error: --changed-file is mutually exclusive with --staged/--since" };
	}
	return { stagedOnly, since, head, changedFile };
}

function main(): number {
	const argv = process.argv.slice(2);
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log("Usage: tsx scripts/verify-review-tier.ts [--repo ROOT] [--staged | --since BASE [--head REF] | --changed-file PATH]");
		return 0;
	}
	const repoArg = argValue(argv, "--repo");
	const repo = repoArg !== undefined ? repoArg : process.cwd();
	const mode = parseMode(argv);
	if ("parseError" in mode) {
		console.error(mode.parseError);
		return 2;
	}
	const rows = scanTier(repo, mode);
	if (rows.length > 0) {
		console.log(`review-tier: ${rows.length} violation(s)`);
		for (const r of rows) console.log(r);
		return 1;
	}
	console.log("review-tier: OK");
	return 0;
}

/** Run main only under direct execution (tests import the helpers without side effects). */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main();
}
