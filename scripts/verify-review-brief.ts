#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify review briefs (review-scope-narrowing §4.1, TS port).
 *
 * Every review lane (R1/R2/R3) must be launched from a brief written by the
 * main session BEFORE the review agent starts. Ported from
 * dotnet-deepseek-harness-desktop `scripts/verify-review-brief.py`; template
 * and field rules are identical (see ADR
 * `proposed/process/2026-10-19-review-triple-ts-gates.md`).
 *
 * Brief shape: `<repo>/.review-briefs/R<N>-<topic>.md` (local work doc,
 * gitignored):
 *   `# R<N> 评审简报` + `## Scope` (base:/head:/需深审面/陪跑文件/门禁自证/
 *   相邻件) + `## Directed checks` (1–5 `- [ ]`) +
 *   `## Explicitly out of scope` (≥1 item) + `## Report contract`
 *   (Blocker[]/Suggestion[] sentence). Rounds: filename `-r<K>` suffix
 *   (no suffix = round 1); K≥2 needs `## 上一轮结论的处置` with items,
 *   tree `base:`, live delta; K>3 needs a line-start `轮次授权：` reason.
 *
 * Lanes default to the review tier of the staged set (FULL → R1+R2+R3,
 * LIGHT → R2), reusing verify-review-tier's classification. Outside a git
 * worktree the freeze/delta checks are skipped (fixture mode); shape checks
 * always run.
 *
 * Usage: tsx scripts/verify-review-brief.ts [--repo ROOT] [--lane R1] [--lane R2]
 * Exit code 0 = pass, 1 = violations.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classifyTier } from "./verify-review-tier.js";

export const BRIEFS_DIR = ".review-briefs";
export const LANES = ["R1", "R2", "R3"] as const;
export type Lane = (typeof LANES)[number];
export const ROUND_CAP = 3;

const TITLE_RE = /#\s*(R[123])\s*评审简报/;
const SCOPE_HEADING = "## Scope";
const CHECKS_HEADING = "## Directed checks";
const OUTSCOPE_HEADING = "## Explicitly out of scope";
const REPORT_HEADING = "## Report contract";
const REPORT_SENTENCE = "Blocker[]/Suggestion[]";
const CHECK_ITEM_RE = /^\s*-\s*\[ \]\s+.+/;
const BASE_RE = /base:\s*\S+/;
const HEAD_RE = /head:\s*\S+/;
const DEEP_RE = /需深审面[^\n]*?[:：]/;
const COMPANION_RE = /陪跑文件[^\n]*?[:：]/;
const SELFASSERT_RE = /门禁自证[^\n]*?[:：]/;
const SELFASSERT_ITEM_RE = /([A-Za-z0-9._-]+)[:：](\d+)\b/g;
const ROUND_RE = /-r(?<round>\d+)\.md$/;
const ROUND_DECLARED_RE = /^#\s.*?第\s*(?<round>\d+)\s*轮/m;
const DISPOSITIONS_RE = /^##\s*上一轮结论的处置/m;
const DISPOSITIONS_HEADING = "## 上一轮结论的处置";
const AUTHORIZATION_RE = /^[-*]?\s*轮次授权[:：]\s*\S/m;

/** Round number of a brief: the `-r<K>` filename suffix, else round 1. */
export function roundOf(name: string): number {
	const m = ROUND_RE.exec(name);
	return m?.groups !== undefined ? Number.parseInt(m.groups["round"] ?? "1", 10) : 1;
}

function zone(text: string, start: string, end: string): string {
	const s = text.indexOf(start);
	if (s < 0) return "";
	const e = text.indexOf(end, s + start.length);
	return text.slice(s + start.length, e >= 0 ? e : text.length);
}

function sectionHasItems(text: string, headingRe: RegExp): boolean {
	const m = headingRe.exec(text);
	if (m === null || m.index === undefined) return false;
	const lineEnd = text.indexOf("\n", m.index);
	const rest = lineEnd >= 0 ? text.slice(lineEnd + 1) : "";
	for (const ln of rest.split("\n")) {
		if (ln.startsWith("## ")) break;
		const stripped = ln.trim();
		if ((stripped.startsWith("-") || stripped.startsWith("*")) && stripped.length > 1) return true;
	}
	return false;
}

function listContentNonempty(text: string, keyRe: RegExp): boolean {
	const key = keyLine(text, keyRe);
	if (key === undefined) return false;
	// keyRe consumes through the colon; inline is the remainder of that line.
	if (key.inline !== "" && key.inline !== "无" && !key.inline.startsWith("无。")) return true;
	for (const ln of key.rest.split("\n")) {
		if (ln.trim() === "") continue;
		if (ln.startsWith("- ") || ln.startsWith("* ") || ln.startsWith("## ") || (ln.length > 0 && !/^\s/.test(ln))) break;
		const stripped = ln.trim().replace(/^[-*]\s*/, "").trim();
		if (stripped !== "" && stripped !== "无" && !stripped.startsWith("无。")) return true;
	}
	return false;
}

/**
 * The matched key line, split into the remainder of its line (inline) and
 * everything after it (rest). Shared by the three Scope key readers so the
 * "locate key → cut line" shape lives in one place (R1-S3).
 */
function keyLine(text: string, keyRe: RegExp): { readonly inline: string; readonly rest: string } | undefined {
	const m = keyRe.exec(text);
	if (m === null || m.index === undefined) return undefined;
	const lineEnd = text.indexOf("\n", m.index);
	const inline = (lineEnd >= 0 ? text.slice(m.index + m[0].length, lineEnd) : text.slice(m.index + m[0].length)).trim();
	const rest = lineEnd >= 0 ? text.slice(lineEnd) : "";
	return { inline, rest };
}

function companionIsNone(text: string): boolean {
	const key = keyLine(text, COMPANION_RE);
	if (key === undefined) return true;
	return key.inline === "无" || key.inline.startsWith("无。");
}

function selfassertText(text: string): string {
	return keyLine(text, SELFASSERT_RE)?.inline ?? "";
}

/** Violation strings for one brief file (empty when well-formed). */
export function violationsForLane(file: string, lane: Lane): string[] {
	const v: string[] = [];
	let text: string;
	try {
		text = readFileSync(file, "utf-8");
	} catch {
		return [`${lane}: missing brief ${BRIEFS_DIR}/R${lane.slice(1)}-*.md (must write brief before launching review)`];
	}
	const name = file.split("/").at(-1) ?? file;

	const title = TITLE_RE.exec(text);
	if (title === null) {
		v.push(`${lane}: ${name} lacks '# R${lane.slice(1)} 评审简报' title`);
	} else if (title[1] !== lane) {
		v.push(`${lane}: ${name} title lane '${title[1] ?? "?"}' != ${lane}`);
	}
	for (const heading of [SCOPE_HEADING, CHECKS_HEADING, OUTSCOPE_HEADING, REPORT_HEADING]) {
		if (!text.includes(heading)) v.push(`${lane}: ${name} missing '${heading}' section`);
	}
	// Scope keys are judged inside the Scope zone only: a `base:`/`需深审面:`
	// mention in body chatter (e.g. `rebase:`) must not satisfy the shape.
	// Without a Scope section the missing-section violation above stands alone.
	const scopeZone = zone(text, SCOPE_HEADING, CHECKS_HEADING);
	const hasScope = text.includes(SCOPE_HEADING);
	if (hasScope && (BASE_RE.exec(scopeZone) === null || HEAD_RE.exec(scopeZone) === null)) {
		v.push(`${lane}: ${name} Scope must carry both 'base: <ref>' and 'head: <ref>'`);
	}
	if (hasScope && DEEP_RE.exec(scopeZone) === null) {
		v.push(`${lane}: ${name} Scope must list 需深审面 (files this lane reads line-by-line; empty = unbounded)`);
	} else if (hasScope && !listContentNonempty(scopeZone, DEEP_RE)) {
		v.push(`${lane}: ${name} 需深审面 must name ≥1 file (write 无 only under 陪跑文件)`);
	}
	if (hasScope && COMPANION_RE.exec(scopeZone) === null) {
		v.push(`${lane}: ${name} Scope must list 陪跑文件 (machine-gated files scanned only; write 无 when none)`);
	}
	if (hasScope && !companionIsNone(scopeZone)) {
		if (SELFASSERT_RE.exec(scopeZone) === null) {
			v.push(`${lane}: ${name} 陪跑文件声明机器门禁已盖，但缺「门禁自证」行——主会话须实跑门禁并随行 exit 码`);
		} else {
			const items = [...selfassertText(scopeZone).matchAll(SELFASSERT_ITEM_RE)];
			if (items.length === 0) {
				v.push(`${lane}: ${name} 「门禁自证」行无可解析的 <门禁>:<exit> 条目——空泛的"已确认"不是背书`);
			} else {
				const bad = items.filter((m) => (m[2] ?? "0") !== "0").map((m) => m[1] ?? "?");
				if (bad.length > 0) {
					v.push(`${lane}: ${name} 门禁自证含非 0 exit（${bad.join(", ")}）——红门禁文件不得列陪跑`);
				}
			}
		}
	}
	const checks = zone(text, CHECKS_HEADING, OUTSCOPE_HEADING).split("\n").filter((ln) => CHECK_ITEM_RE.test(ln));
	if (checks.length === 0) {
		v.push(`${lane}: ${name} Directed checks must have 1–5 '- [ ]' items (empty = unbounded review)`);
	} else if (checks.length > 5) {
		v.push(`${lane}: ${name} Directed checks has ${checks.length} items (>5 — too broad to focus)`);
	}
	const outscope = zone(text, OUTSCOPE_HEADING, REPORT_HEADING).split("\n").filter((ln) => ln.trim().startsWith("-") || ln.trim().startsWith("*"));
	if (outscope.length === 0) {
		v.push(`${lane}: ${name} Explicitly out of scope must list ≥1 item (none = unbounded task)`);
	}
	if (!text.replaceAll("`", "").includes(REPORT_SENTENCE)) {
		v.push(`${lane}: ${name} Report contract must carry '${REPORT_SENTENCE}'`);
	}
	const rnd = roundOf(name);
	const declared = ROUND_DECLARED_RE.exec(text);
	if (declared?.groups !== undefined && Number.parseInt(declared.groups["round"] ?? "1", 10) !== rnd) {
		v.push(`${lane}: ${name} 标题声明的第 ${declared.groups["round"] ?? "?"} 轮与文件名 \`-r${rnd}\` 不一致——轮次只由文件名取值`);
	}
	const hasDispositions = DISPOSITIONS_RE.exec(text) !== null;
	if (rnd >= 2 && !hasDispositions) {
		v.push(`${lane}: ${name} 是第 ${rnd} 轮但缺 '${DISPOSITIONS_HEADING}' 段——验轮只核上一轮结论的处置闭合、不做复扫`);
	} else if (rnd >= 2 && !sectionHasItems(text, DISPOSITIONS_RE)) {
		v.push(`${lane}: ${name} 的 '${DISPOSITIONS_HEADING}' 段无条目——空段等于没写处置`);
	}
	if (hasDispositions && rnd < 2) {
		v.push(`${lane}: ${name} 带 '${DISPOSITIONS_HEADING}' 段却是第 1 轮——处置段本身即验轮声明`);
	}
	if (rnd > ROUND_CAP && AUTHORIZATION_RE.exec(text) === null) {
		v.push(`${lane}: ${name} 是第 ${rnd} 轮，超出上限 ${ROUND_CAP} 轮——须用户显式授权：简报写出非空「轮次授权：<理由>」行才可开`);
	}
	return v;
}

export function briefPaths(repo: string): { readonly found: Readonly<Record<Lane, string | undefined>>; readonly duplicates: readonly string[] } {
	const dir = join(repo, BRIEFS_DIR);
	const found: Record<Lane, string | undefined> = { R1: undefined, R2: undefined, R3: undefined };
	const duplicates: string[] = [];
	let names: string[];
	try {
		if (!statSync(dir).isDirectory()) return { found, duplicates };
		names = readdirSync(dir).sort();
	} catch {
		return { found, duplicates };
	}
	for (const name of names) {
		if (!/^R[123]-.*\.md$/.test(name)) continue;
		const lane = name.slice(0, 2) as Lane;
		if (found[lane] !== undefined) {
			duplicates.push(`${lane}: multiple briefs for one lane: ${(found[lane] ?? "").split("/").at(-1) ?? "?"} and ${name}（一路恰一份：开验轮前归档或改名上一轮简报）`);
		} else {
			found[lane] = join(dir, name);
		}
	}
	return { found, duplicates };
}

/**
 * True only when repo IS the worktree top level. Fixture dirs live inside
 * the real repo, so `git -C <fixture>` would otherwise float up to the
 * parent worktree and judge the wrong staged set — the freeze/delta checks
 * must skip unless the brief repo owns its git root.
 */
export function isSelfRoot(repo: string): boolean {
	try {
		const top = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const real = (p: string): string => {
			try {
				return realpathSync(p);
			} catch {
				return resolve(p);
			}
		};
		return real(top) === real(resolve(repo));
	} catch {
		return false;
	}
}

/** Worktree must be frozen onto the staged set. Skipped unless repo owns its git root (fixture mode). */
export function freezeViolations(repo: string): string[] {
	if (!isSelfRoot(repo)) return [];
	let out: string;
	try {
		out = execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return ["review-freeze: cannot run git — worktree freeze unverifiable"];
	}
	const violations: string[] = [];
	for (const ln of out.split("\n")) {
		if (ln.trim().length === 0) continue;
		if (ln.startsWith("?? ")) {
			violations.push(`review-freeze: untracked file outside the frozen review object: ${ln.slice(3)}`);
		} else if (ln.length >= 2 && (ln[1] ?? " ") !== " ") {
			violations.push(`review-freeze: worktree drifts from staged index (re-stage or discard before review): ${ln}`);
		}
	}
	return violations;
}

function frozenTree(repo: string): string | undefined {
	try {
		const out = execFileSync("git", ["-C", repo, "write-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return out.length > 0 ? out : undefined;
	} catch {
		return undefined;
	}
}

/** Verification rounds must pin `base:` to a tree with a live delta. Skipped unless repo owns its git root. */
export function roundDeltaViolations(repo: string, lanes: readonly Lane[]): string[] {
	if (!isSelfRoot(repo)) return [];
	const { found } = briefPaths(repo);
	const out: string[] = [];
	for (const lane of lanes) {
		const p = found[lane];
		if (p === undefined || !existsSync(p) || roundOf(p.split("/").at(-1) ?? "") < 2) continue;
		const text = readFileSync(p, "utf-8");
		const m = BASE_RE.exec(text);
		if (m === null || m.index === undefined) continue;
		const base = m[0].split(":", 2)[1]?.trim() ?? "";
		if (base.length === 0) continue;
		let kind = "";
		try {
			kind = execFileSync("git", ["-C", repo, "cat-file", "-t", base], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		} catch {
			kind = "";
		}
		if (kind !== "tree") {
			out.push(`${lane}: ${(p.split("/").at(-1) ?? p)} 验轮 base '${base}' 不是 tree 对象——须写上一轮冻结时 \`git write-tree\` 的 SHA`);
			continue;
		}
		try {
			execFileSync("git", ["-C", repo, "diff", "--cached", "--quiet", base], { stdio: ["ignore", "pipe", "ignore"] });
			out.push(`${lane}: ${(p.split("/").at(-1) ?? p)} 验轮相对 base 的增量为空——本轮没有待验修复，开验轮无对象可审`);
		} catch (e) {
			const code = typeof e === "object" && e !== null && "status" in e ? (e as { readonly status: unknown }).status : undefined;
			if (code !== 1) out.push(`${lane}: ${(p.split("/").at(-1) ?? p)} 验轮增量不可判定：\`git diff --cached --quiet ${base}\` 退出码 ${String(code)}`);
		}
	}
	return out;
}

/** Lanes required by the staged tier (FULL → R1+R2+R3, LIGHT → R2). Fixture dirs inside the repo must not read the parent staged set. */
export function tierLanes(repo: string): Lane[] {
	if (!isSelfRoot(repo)) return ["R1", "R2", "R3"];
	try {
		const out = execFileSync("git", ["-C", repo, "diff", "--cached", "--name-only"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		const paths = out.length > 0 ? out.split("\n") : [];
		const { full } = classifyTier(paths, repo, { stagedOnly: true });
		return full ? ["R1", "R2", "R3"] : ["R2"];
	} catch {
		return ["R1", "R2", "R3"];
	}
}

/** All violations across required lanes (empty when well-formed). */
export function checkRepo(repo: string, lanes?: readonly Lane[]): string[] {
	const required: readonly Lane[] = lanes ?? tierLanes(repo);
	const { found, duplicates } = briefPaths(repo);
	const out: string[] = [...duplicates];
	for (const lane of required) {
		const p = found[lane];
		if (p === undefined) out.push(`${lane}: missing brief under ${BRIEFS_DIR}/`);
		else out.push(...violationsForLane(p, lane));
	}
	return out;
}

function main(): number {
	const argv = process.argv.slice(2);
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log("Usage: tsx scripts/verify-review-brief.ts [--repo ROOT] [--lane R1] [--lane R2] [--lane R3]");
		return 0;
	}
	let repo = process.cwd();
	const repoIdx = argv.indexOf("--repo");
	if (repoIdx >= 0) {
		const value = argv[repoIdx + 1];
		if (value === undefined || value.startsWith("--")) {
			console.error("error: --repo needs a value");
			return 2;
		}
		repo = value;
	}
	const lanes: Lane[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--lane") {
			const value = argv[i + 1];
			if (value !== "R1" && value !== "R2" && value !== "R3") {
				console.error(`error: --lane needs R1|R2|R3, got ${JSON.stringify(value)}`);
				return 2;
			}
			lanes.push(value);
			i += 1;
		}
	}
	const required: readonly Lane[] = lanes.length > 0 ? [...new Set(lanes)] : tierLanes(repo);
	const violations = checkRepo(repo, required);
	for (const s of violations) console.log(s);
	const freeze = freezeViolations(repo);
	for (const s of freeze) console.log(s);
	const delta = roundDeltaViolations(repo, [...required]);
	for (const s of delta) console.log(s);
	const treeErrors: string[] = [];
	let tree: string | undefined;
	if (violations.length === 0 && freeze.length === 0 && delta.length === 0 && isSelfRoot(repo)) {
		tree = frozenTree(repo);
		if (tree === undefined) {
			treeErrors.push("review-freeze: `git write-tree` 未能取得本轮评审对象 tree——下一轮验轮的 `base` 无从取得");
			console.log(treeErrors[0]);
		}
	}
	const total = [...violations, ...freeze, ...delta, ...treeErrors];
	if (total.length > 0) {
		console.log(`review-brief: ${total.length} violation(s)`);
		return 1;
	}
	console.log("review-brief: OK (briefs well-formed; worktree frozen onto the staged set)");
	if (tree !== undefined) console.log(`本轮评审对象 tree: ${tree}（下一轮简报的 base: 引它）`);
	return 0;
}

/** Run main only under direct execution (tests import the helpers without side effects). */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main();
}
