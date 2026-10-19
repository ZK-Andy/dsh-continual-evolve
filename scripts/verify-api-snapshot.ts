#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify API snapshot (backlog G5): the exported surface of every src module
 * is pinned in snapshot/api.json.
 *
 * The snapshot is produced by the TypeScript compiler itself: tsc emits
 * declarations for the whole program into a temp dir, and the gate stores
 * one .d.ts text per module. Deleting an export or changing a signature
 * changes the .d.ts and fails the gate; changing only a body keeps it
 * green. Re-running --update twice must yield byte-identical output.
 *
 * No new dependency: tsc comes from the declared typescript devDependency.
 * There are no static fixtures (like schema-snapshot): the clean sample is
 * generated at runtime with --update into a temp dir, and the violation
 * sample is a tampered copy, so the matrix can never rot as exports evolve.
 *
 * Usage: tsx scripts/verify-api-snapshot.ts [--snapshot PATH] [--project PATH] [--update]
 * Exit code 0 = pass, 1 = surface drift found.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export interface ApiSnapshot {
	readonly version: 1;
	readonly modules: Record<string, string>;
}

export interface ApiCheck {
	readonly ok: boolean;
	readonly messages: readonly string[];
}

/**
 * Pure check (importable by tests): compare one emitted surface against the
 * committed snapshot. Growth, shrinkage, and signature edits all fail until
 * the author re-anchors with --update (in the same PR as the ADR).
 */
export function compareApi(current: Record<string, string>, baseline: ApiSnapshot): ApiCheck {
	const messages: string[] = [];
	const failures: string[] = [];
	for (const mod of Object.keys(current).sort()) {
		if (baseline.modules[mod] === undefined) {
			failures.push(`FAIL: ${mod}: 新模块不在快照内 — 跑 --update 并在同 PR 给出 ADR`);
		} else if (baseline.modules[mod] !== current[mod]) {
			failures.push(`FAIL: ${mod}: 导出面变化（删 export / 改签名）— 确认有意后跑 --update`);
		}
	}
	for (const mod of Object.keys(baseline.modules).sort()) {
		if (current[mod] === undefined) {
			failures.push(`FAIL: ${mod}: 模块已删除但快照仍在 — 跑 --update 同步`);
		}
	}
	return { ok: failures.length === 0, messages: [...failures, ...messages] };
}

/** Emit declarations for the whole program into outDir (throws with tsc output on failure). */
export function emitDeclarations(tscPath: string, projectPath: string, outDir: string): void {
	try {
		execFileSync(
			process.execPath,
			[tscPath, "-p", projectPath, "--emitDeclarationOnly", "--declarationMap", "false", "--sourceMap", "false", "--outDir", outDir],
			{ encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
		);
	} catch (error) {
		const stderr = (error as { stderr?: unknown }).stderr;
		throw new Error(`tsc 声明 emit 失败：${typeof stderr === "string" ? stderr.slice(0, 2000) : String(error).slice(0, 500)}`);
	}
}

function collectDts(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) collectDts(full, out);
		else if (name.endsWith(".d.ts")) out.push(full);
	}
	return out;
}

/** Snapshot the current exported surface (keys are src/-relative .ts paths). */
export function snapshotApi(projectPath: string): ApiSnapshot {
	const require = createRequire(import.meta.url);
	const tscPath = require.resolve("typescript/lib/tsc.js");
	const tmp = mkdtempSync(join(tmpdir(), "evolve-g5-"));
	try {
		emitDeclarations(tscPath, projectPath, tmp);
		const modules: Record<string, string> = {};
		for (const file of collectDts(tmp).sort()) {
			const key = `src/${relative(tmp, file).replace(/\\/g, "/").replace(/\.d\.ts$/, ".ts")}`;
			modules[key] = readFileSync(file, "utf-8");
		}
		if (Object.keys(modules).length === 0) {
			throw new Error("emit 产物为空：tsconfig 的 include 是否覆盖了 src？");
		}
		return { version: 1, modules };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
	const here = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
	const snapshotPath = argValue("--snapshot") ?? join(here, "snapshot/api.json");
	const projectPath = argValue("--project") ?? join(here, "tsconfig.json");
	const update = process.argv.includes("--update");

	if (update) {
		try {
			const snapshot = snapshotApi(projectPath);
			mkdirSync(dirname(snapshotPath), { recursive: true });
			writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
			console.log(`UPDATED ${snapshotPath}（${Object.keys(snapshot.modules).length} modules）`);
			return 0;
		} catch (error) {
			console.log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
			return 1;
		}
	}

	if (!existsSync(snapshotPath)) {
		console.log(`FAIL: 快照缺失：${snapshotPath}（跑 tsx scripts/verify-api-snapshot.ts --update 生成并同 PR 说明）`);
		return 1;
	}
	let baseline: ApiSnapshot;
	try {
		baseline = JSON.parse(readFileSync(snapshotPath, "utf-8")) as ApiSnapshot;
	} catch {
		console.log(`FAIL: 快照无法解析：${snapshotPath}`);
		return 1;
	}
	let current: ApiSnapshot;
	try {
		current = snapshotApi(projectPath);
	} catch (error) {
		console.log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const result = compareApi(current.modules, baseline);
	console.log(`Checked ${Object.keys(current.modules).length} src modules against ${relative(".", snapshotPath)}`);
	for (const m of result.messages) console.log(m);
	if (result.ok) {
		console.log("OK（导出面与快照一致：删 export / 改签名会红，纯改实现保持绿）");
		return 0;
	}
	console.log("确认改动有意后跑 tsx scripts/verify-api-snapshot.ts --update 重定基线（同 PR 带 ADR 说明）");
	return 1;
}

/** Run main only under direct execution (tests import the helpers without side effects). */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main();
}
