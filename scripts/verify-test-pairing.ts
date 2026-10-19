#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify test-source pairing (backlog G9): every src module must pair with
 * a same-name test file, or be listed in scripts/test-exempt.json.
 *
 * A src module counts as paired when test/<basename>.test.ts exists
 * (directories do not matter: pages/memory-card/mount.ts pairs with
 * test/mount.test.ts). Exempt entries that no longer have a gap — the test
 * was added, or the module was deleted — fail as stale so the list only
 * shrinks. Adding an entry requires an ADR in the same PR; dropping one
 * (by adding the test) needs none.
 *
 * Usage: tsx scripts/verify-test-pairing.ts [--src DIR] [--tests DIR] [--exempt PATH]
 * Exit code 0 = pass (or SKIP when a tree does not exist), 1 = unpaired or stale entries.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export interface PairingCheck {
	readonly ok: boolean;
	readonly missing: readonly string[];
	readonly stale: readonly string[];
}

/**
 * Pure check (importable by tests): src-relative .ts paths against the set
 * of test-relative .test.ts paths and the exempted src-relative paths.
 */
export function checkPairing(srcFiles: readonly string[], testFiles: ReadonlySet<string>, exempt: ReadonlySet<string>): PairingCheck {
	const testBases = new Set([...testFiles].map((test) => basename(test, ".test.ts")));
	const missing = [...srcFiles].sort().filter((src) => !testBases.has(basename(src, ".ts")) && !exempt.has(src));
	// Stale = the gap is gone: the module was deleted, or the test now exists.
	const srcSet = new Set(srcFiles);
	const stale = [...exempt].filter((entry) => !srcSet.has(entry) || testBases.has(basename(entry, ".ts"))).sort();
	return { ok: missing.length === 0 && stale.length === 0, missing, stale };
}

/** Read the exempt list (throws a readable error when missing or malformed). */
export function readExempt(exemptPath: string): Set<string> {
	if (!existsSync(exemptPath)) {
		throw new Error(`豁免清单缺失：${exemptPath}`);
	}
	const parsed = JSON.parse(readFileSync(exemptPath, "utf-8")) as { exempt?: unknown };
	if (!Array.isArray(parsed.exempt) || parsed.exempt.some((entry) => typeof entry !== "string")) {
		throw new Error(`豁免清单格式错误：${exemptPath} 需要 { "exempt": string[] }`);
	}
	return new Set(parsed.exempt as string[]);
}

/** Recursively list .ts files under dir (importable by tests). */
export function listTsFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) listTsFiles(full, out);
		else if (name.endsWith(".ts")) out.push(full);
	}
	return out;
}

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
	const srcRoot = argValue("--src") ?? "src";
	const testsRoot = argValue("--tests") ?? "test";
	const exemptPath = argValue("--exempt") ?? new URL("test-exempt.json", import.meta.url).pathname;
	for (const dir of [srcRoot, testsRoot]) {
		try {
			if (!statSync(dir).isDirectory()) {
				console.log(`SKIP: ${dir} does not exist (no tree to pair)`);
				return 0;
			}
		} catch {
			console.log(`SKIP: ${dir} does not exist (no tree to pair)`);
			return 0;
		}
	}
	let exempt: Set<string>;
	try {
		exempt = readExempt(exemptPath);
	} catch (error) {
		console.log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const srcFiles = listTsFiles(srcRoot)
		.map((file) => `src/${relative(srcRoot, file).replace(/\\/g, "/")}`)
		.sort();
	const testFiles = new Set(
		listTsFiles(testsRoot)
			.map((file) => relative(".", file).replace(/\\/g, "/"))
			.filter((rel) => rel.endsWith(".test.ts")),
	);
	const result = checkPairing(srcFiles, testFiles, exempt);
	console.log(`Checked ${srcFiles.length} src modules against ${testFiles.size} test files (${exempt.size} exempt)`);
	for (const m of result.missing) console.log(`FAIL: ${m}: 无配对 test/${basename(m, ".ts")}.test.ts 且不在豁免清单内`);
	for (const s of result.stale) console.log(`FAIL: 豁免条目已过期（配对已存在或模块已删除）：${s} —— 删掉该条目`);
	if (result.ok) {
		console.log("OK（源码与测试配对齐备，豁免只减不增）");
		return 0;
	}
	console.log("加测试，或在同 PR 用 ADR 说明后把路径加进 scripts/test-exempt.json");
	return 1;
}

/** Run main only under direct execution (tests import the helpers without side effects). */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main();
}
