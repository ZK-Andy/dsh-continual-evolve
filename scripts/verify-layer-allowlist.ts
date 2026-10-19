#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify layer allowlist (backlog G12): top-level src directories must belong
 * to the allowlist in scripts/layers.json.
 *
 * The initial allowlist is derived from docs/architecture-standard.md section 1
 * (data / pages / services / surfaces). A new directory outside the set fails
 * the gate; adding it requires editing layers.json in the same PR with an ADR
 * (the allowlist change itself is the human approval point).
 *
 * Usage: tsx scripts/verify-layer-allowlist.ts [src_root] [--layers PATH]
 * Exit code 0 = pass (or SKIP when the tree does not exist), 1 = unknown layers found.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface LayerCheck {
	readonly ok: boolean;
	readonly known: readonly string[];
	readonly unknown: readonly string[];
}

/** Pure check (importable by tests): every top dir must be allowlisted. */
export function checkLayers(topDirs: readonly string[], allowed: readonly string[]): LayerCheck {
	const allow = new Set(allowed);
	const known = [...topDirs].sort();
	return { ok: known.every((dir) => allow.has(dir)), known, unknown: known.filter((dir) => !allow.has(dir)) };
}

/** Read the allowlist file (throws a readable error when it is missing or malformed). */
export function readAllowlist(layersPath: string): string[] {
	if (!existsSync(layersPath)) {
		throw new Error(`allowlist 缺失：${layersPath}`);
	}
	const parsed = JSON.parse(readFileSync(layersPath, "utf-8")) as { layers?: unknown };
	if (!Array.isArray(parsed.layers) || parsed.layers.some((entry) => typeof entry !== "string")) {
		throw new Error(`allowlist 格式错误：${layersPath} 需要 { "layers": string[] }`);
	}
	return parsed.layers as string[];
}

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): number {
	const positional = process.argv.slice(2).find((arg) => !arg.startsWith("--") && process.argv[process.argv.indexOf(arg) - 1] !== "--layers");
	const root = positional ?? "src";
	const layersPath = argValue("--layers") ?? new URL("layers.json", import.meta.url).pathname;
	try {
		if (!statSync(root).isDirectory()) {
			console.log(`SKIP: ${root} does not exist (no src tree)`);
			return 0;
		}
	} catch {
		console.log(`SKIP: ${root} does not exist (no src tree)`);
		return 0;
	}
	let allowed: string[];
	try {
		allowed = readAllowlist(layersPath);
	} catch (error) {
		console.log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const topDirs = readdirSync(root).filter((name) => {
		try {
			return statSync(join(root, name)).isDirectory();
		} catch {
			return false;
		}
	});
	const result = checkLayers(topDirs, allowed);
	console.log(`Checked ${result.known.length} top-level dirs (${result.known.join(", ") || "none"})`);
	if (result.ok) {
		console.log("OK（顶层目录全在归层白名单内）");
		return 0;
	}
	for (const dir of result.unknown) console.log(`FAIL: src/${dir}/ 不在归层白名单内`);
	console.log("新分层先立 ADR，再把目录名加进 scripts/layers.json（白名单变更即人工批准点）");
	return 1;
}

/** Run main only under direct execution (tests import the helpers without side effects). */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main();
}
