#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Pack-contents gate: the published package must be a clean projection of
 * `src/`. `tsc` never deletes files, `lib/` is a persistent (gitignored)
 * output directory, and `files` globs `lib/**` — so a retired module's stale
 * build output silently rides the next `npm publish` out the door unless
 * something looks at the artifact set. This gate does, and names the file.
 *
 * Checks:
 * 1. no orphan `lib/**.{js,d.ts}` (no matching `src/**.ts`)
 * 2. no missing pair for any `src/**.ts`
 * 3. every `files` glob matches at least one real file (miss = silent
 *    under-publish)
 *
 * `lib/` absent (clean checkout, not built yet) → skip: nothing to audit.
 * See ADR `2026-10-06-pack-contents-gate`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Every file under `dir`, as slash-joined paths relative to it. */
function walk(dir: string, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === ".git" || entry.name === "node_modules") continue;
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
		else if (entry.isFile()) out.push(rel);
	}
	return out;
}

/** A module id: the file path minus its `.ts` / `.js` / `.d.ts` suffix. */
function moduleOf(file: string): string {
	return file.replace(/\.d\.ts$/, "").replace(/\.(ts|js)$/, "");
}

/** Glob (`**`, `*`, `?`) to an anchored RegExp over slash-joined paths. */
function globToRegExp(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i += 1) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				i += 1;
				if (pattern[i + 1] === "/") {
					i += 1;
					out += "(?:.*/)?";
				} else {
					out += ".*";
				}
			} else {
				out += "[^/]*";
			}
		} else if (ch === "?") {
			out += "[^/]";
		} else if (ch !== undefined && "\\^$+.()|{}[]".includes(ch)) {
			out += `\\${ch}`;
		} else if (ch !== undefined) {
			out += ch;
		}
	}
	return new RegExp(`^${out}$`);
}

function main(): number {
	const libDir = join(root, "lib");
	if (!existsSync(libDir)) {
		console.log("SKIP lib/ 未构建——先 `npm run build` 再跑本门禁");
		return 0;
	}
	let ok = true;

	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { files?: unknown };
	const srcModules = new Set(walk(join(root, "src")).filter((file) => file.endsWith(".ts")).map(moduleOf));
	const libFiles = walk(libDir);
	const libModules = new Set(
		libFiles.filter((file) => file.endsWith(".js") || file.endsWith(".d.ts")).map(moduleOf),
	);

	for (const module of [...libModules].sort()) {
		if (!srcModules.has(module)) {
			console.log(`FAIL 残留产物：lib/${module}.js|.d.ts 在 src/ 已无对应模块（tsc 不删旧文件）`);
			ok = false;
		}
	}
	for (const module of [...srcModules].sort()) {
		for (const suffix of [".js", ".d.ts"]) {
			if (!libFiles.includes(`${module}${suffix}`)) {
				console.log(`FAIL 缺失产物：lib/${module}${suffix}`);
				ok = false;
			}
		}
	}

	const patterns = Array.isArray(pkg.files) ? pkg.files.filter((entry): entry is string => typeof entry === "string") : [];
	if (patterns.length === 0) {
		console.log("FAIL package.json 的 files 白名单为空（会发布整个仓库）");
		ok = false;
	}
	const shipped = walk(root);
	for (const pattern of patterns) {
		const re = globToRegExp(pattern);
		if (!shipped.some((file) => re.test(file))) {
			console.log(`FAIL files 白名单空匹配：${pattern} 没命中任何文件（漏发风险）`);
			ok = false;
		}
	}

	console.log(ok ? `OK（${srcModules.size} 模块 / ${patterns.length} 白名单项）` : "FAIL");
	return ok ? 0 : 1;
}

process.exitCode = main();
