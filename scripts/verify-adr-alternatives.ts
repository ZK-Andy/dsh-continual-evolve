#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify ADR Alternatives quality (backlog G8): the Alternatives section
 * must hold at least two substantive bullets.
 *
 * Scope mirrors verify-adr-format.ts: every .md under the lifecycle
 * directories (proposed / implemented / rejected), skipping archived/ and
 * .zh.md files. A bullet counts when it starts with "- ", carries at least
 * 20 characters, and is not an emptiness shell (a lone 无 / 不适用 / N/A /
 * none — "无法…" style content words still count).
 *
 * Usage: tsx scripts/verify-adr-alternatives.ts [notes_root]
 * Exit code 0 = pass (or SKIP when the tree does not exist), 1 = thin Alternatives found.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const SECTION = "## Alternatives considered";
const MIN_BULLETS = 2;
const MIN_LENGTH = 20;
/** Shells that admit having no alternatives (content words starting with 无 still count). */
const SHELL_RE = /^(不适用|暂无|无[，。,.:;\s]|无$|N\/A|none\b)/i;

export interface AlternativesCheck {
	readonly ok: boolean;
	readonly bullets: number;
	readonly substantive: number;
}

/** Pure check of one note's Alternatives section (importable by tests). */
export function checkAlternatives(text: string): AlternativesCheck {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line.trim() === SECTION);
	if (start < 0) {
		return { ok: false, bullets: 0, substantive: 0 };
	}
	const bullets: string[] = [];
	for (let i = start + 1; i < lines.length; i += 1) {
		const line = lines[i] as string;
		if (/^##\s/.test(line)) break;
		const match = /^\s*-\s+(.*)$/.exec(line);
		if (match?.[1] !== undefined) bullets.push(match[1].trim());
	}
	const substantive = bullets.filter((body) => body.length >= MIN_LENGTH && !SHELL_RE.test(body));
	return { ok: substantive.length >= MIN_BULLETS, bullets: bullets.length, substantive: substantive.length };
}

function collectMd(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) collectMd(full, out);
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
	const failures: string[] = [];
	let checked = 0;
	for (const note of collectMd(root).sort()) {
		const rel = relative(root, note).replace(/\\/g, "/");
		if (rel.includes("archived/") || note.endsWith(".zh.md")) continue;
		const lifecycle = rel.split("/")[0] ?? "";
		if (lifecycle !== "proposed" && lifecycle !== "implemented" && lifecycle !== "rejected") continue;
		checked += 1;
		const result = checkAlternatives(readFileSync(note, "utf-8"));
		if (!result.ok) {
			failures.push(`FAIL: ${rel}: Alternatives 下只有 ${result.substantive} 条实质 bullet（要 ≥${MIN_BULLETS} 条，每条 ≥${MIN_LENGTH} 字，空壳不算）`);
		}
	}
	console.log(`Checked ${checked} Agent Notes`);
	for (const failure of failures) console.log(failure);
	if (failures.length > 0) return 1;
	console.log("OK（每份 ADR 的 Alternatives 都有 ≥2 条实质备选）");
	return 0;
}

/** Run main only under direct execution (tests import the helpers without side effects). */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main();
}
