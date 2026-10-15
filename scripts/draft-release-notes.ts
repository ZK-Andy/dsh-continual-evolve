#!/usr/bin/env -S ../node_modules/.bin/tsx
/**
 * Draft bilingual GitHub Release notes from the commit range since the
 * previous release tag (DSH release-notes shape, single-package trim).
 *
 * Usage: tsx scripts/draft-release-notes.ts [prev-tag] [new-version]
 *   prev-tag     default: newest reachable v* tag (full history when none)
 *   new-version  default: package.json version
 * Output: releases/v<new-version>.md (draft: EN section needs polishing,
 *   author names need @handle replacement at publish time).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface LogCommit {
	hash: string;
	author: string;
	subject: string;
}

export interface NoteGroups {
	feat: string[];
	fix: string[];
	other: string[];
}

/** One bullet per commit; the short hash stays as an audit comment. */
export function bulletOf(commit: LogCommit): string {
	return `- ${commit.subject} (@${commit.author}) <!-- ${commit.hash.slice(0, 7)} -->`;
}

/** Group log commits, skipping the version-bump commit (release mechanics, not content). */
export function groupCommits(commits: readonly LogCommit[]): NoteGroups {
	const groups: NoteGroups = { feat: [], fix: [], other: [] };
	for (const commit of commits) {
		if (commit.hash.length === 0 || commit.subject.startsWith("chore(release)")) {
			continue;
		}
		if (commit.subject.startsWith("feat")) {
			groups.feat.push(bulletOf(commit));
		} else if (commit.subject.startsWith("fix")) {
			groups.fix.push(bulletOf(commit));
		} else {
			groups.other.push(bulletOf(commit));
		}
	}
	return groups;
}

/** Normalize an origin URL to an https compare base (no trailing .git). */
export function compareBaseOf(remoteUrl: string): string {
	return remoteUrl
		.trim()
		.replace(/\.git$/, "")
		.replace(/^git@github\.com:/, "https://github.com/");
}

/** Render the bilingual draft (same shape as the retired shell script). */
export function renderNotes(
	newTag: string,
	newVersion: string,
	pkgName: string,
	prevTag: string,
	compareBase: string,
	rangeBase: string,
	groups: NoteGroups,
): string {
	const section = (lines: string[], empty: string): string => (lines.length > 0 ? `${lines.join("\n")}\n` : `- ${empty}\n`);
	return (
		`[中文](#cn-${newTag}) | [English](#en-${newTag})\n` +
		`\n<h3 id="cn-${newTag}">新功能</h3>\n` +
		section(groups.feat, "（无）") +
		`\n### 问题修复\n` +
		section(groups.fix, "（无）") +
		`\n### 其他改动\n` +
		section(groups.other, "（无）") +
		`\n<!-- TODO: polish the English section before publishing -->\n` +
		`\n<h3 id="en-${newTag}">Features</h3>\n` +
		section(groups.feat, "(none)") +
		`\n### Bug Fixes\n` +
		section(groups.fix, "(none)") +
		`\n### Chores\n` +
		section(groups.other, "(none)") +
		`\nFull Changelog: [${prevTag}...${newTag}](${compareBase}/compare/${rangeBase}...${newTag})\n` +
		`npm: https://www.npmjs.com/package/${pkgName}/v/${newVersion}\n`
	);
}

/** Run git and return trimmed stdout ("" when git reports nothing). */
function git(...args: string[]): string {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** Parse `git log --format=%H|%an|%s` lines (subjects may contain `|` — split head-first). */
export function parseLog(text: string): LogCommit[] {
	const commits: LogCommit[] = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) {
			continue;
		}
		const first = line.indexOf("|");
		const second = line.indexOf("|", first + 1);
		if (first < 0 || second < 0) {
			continue;
		}
		commits.push({ hash: line.slice(0, first), author: line.slice(first + 1, second), subject: line.slice(second + 1) });
	}
	return commits;
}

function main(): void {
	const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { name: string; version: string };
	const prevTag = process.argv[2] ?? (() => {
		try {
			return git("describe", "--tags", "--match", "v*", "--abbrev=0");
		} catch {
			return "";
		}
	})();
	const newVersion = process.argv[3] ?? pkg.version;
	const newTag = `v${newVersion}`;
	const range = prevTag.length > 0 ? `${prevTag}..HEAD` : "HEAD";

	const remoteUrl = (() => {
		try {
			return git("config", "--get", "remote.origin.url");
		} catch {
			return "";
		}
	})();
	const compareBase = compareBaseOf(remoteUrl);
	const rangeBase = prevTag.length > 0 ? prevTag : git("rev-list", "--max-parents=0", "HEAD").split("\n")[0] ?? "";
	const commits = parseLog(git("log", range, "--reverse", "--format=%H|%an|%s"));
	const notes = renderNotes(newTag, newVersion, pkg.name, prevTag.length > 0 ? prevTag : "root", compareBase, rangeBase, groupCommits(commits));

	mkdirSync("releases", { recursive: true });
	const out = `releases/${newTag}.md`;
	writeFileSync(out, notes, "utf8");
	console.log(`draft written to ${out} (range: ${range})`);
}

/** Run main only under direct execution (tests import the helpers without side effects). */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
