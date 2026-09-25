#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify relative Markdown links: file targets exist and #fragment anchors resolve.
 *
 * Checks, for every .md file under the given root (default: current directory):
 *   - `](relative/path.md)`  -> target file must exist
 *   - `](relative/path.md#slug)` -> target exists AND slug must match a heading
 *     slug (GitHub-style: lowercase, spaces->hyphens, strip punctuation) or an
 *     explicit <a id="slug"> anchor in that file
 *   - `](https://…)` / `](mailto:…)` / `](<…>)` -> skipped (external)
 *
 * By default, `skills/` and `node_modules/` directories are excluded: vendored
 * skill sources keep their upstream path references, and node_modules is
 * third-party dependency content. Pass --include-skills to check skills/ anyway.
 *
 * Usage: tsx scripts/verify-md-links.ts [root_dir] [--include-skills]
 * Exit code 0 = pass, 1 = violations.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const ANCHOR_RE = /<a\s+id="([^"]+)"/;

function slugify(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/[^\w\u4e00-\u9fff -]/g, "")
		.replace(/\s+/g, "-");
}

function headingSlugs(path: string): Set<string> {
	const slugs = new Set<string>();
	let lines: string[];
	try {
		lines = readFileSync(path, "utf-8").split("\n");
	} catch {
		return slugs;
	}
	for (const line of lines) {
		const m = HEADING_RE.exec(line);
		if (m?.[2]) slugs.add(slugify(m[2]));
		const a = ANCHOR_RE.exec(line);
		if (a?.[1]) slugs.add(a[1]);
	}
	return slugs;
}

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
	const args = process.argv.slice(2);
	const includeSkills = args.includes("--include-skills");
	const root = args.find((a) => !a.startsWith("--")) ?? ".";
	const errors: string[] = [];
	let checked = 0;
	for (const md of collectMd(root).sort()) {
		const parts = md.split("/");
		if (parts.includes("node_modules")) continue;
		if (!includeSkills && parts.includes("skills")) continue;
		const text = readFileSync(md, "utf-8");
		for (const match of text.matchAll(LINK_RE)) {
			let target = (match[1] ?? "").trim();
			if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:") || target.startsWith("#") || target.startsWith("<")) continue;
			if (target.includes("://")) continue;
			let resolved: string;
			if (target.startsWith("/")) {
				resolved = resolve(root, target.replace(/^\/+/, ""));
			} else {
				resolved = resolve(join(md, ".."), target.split("#")[0] ?? "");
			}
			if (!existsSync(resolved) || !statSync(resolved).isFile()) {
				errors.push(`${md}: missing target '${target}'`);
				continue;
			}
			checked += 1;
			if (target.includes("#")) {
				const frag = target.split("#", 2)[1] ?? "";
				if (frag && !headingSlugs(resolved).has(frag)) {
					errors.push(`${md}: dead anchor '#${frag}' in '${target}'`);
				}
			}
		}
	}

	console.log(`Checked ${checked} link targets`);
	if (errors.length > 0) {
		for (const e of errors) console.log(`FAIL: ${e}`);
		return 1;
	}
	console.log("OK");
	return 0;
}

process.exitCode = main();
