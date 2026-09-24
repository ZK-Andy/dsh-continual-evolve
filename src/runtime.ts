/**
 * Runtime gate switch: a small human-owned file that enables or pauses the
 * automatic review listener without editing the profile or restarting DSH.
 *
 * - file: `<baseDir>/evolve/runtime.json` (`{version: 2, enabled, paused, updatedAt}`)
 * - the file is consulted at every trigger and before scheduler execution;
 * - `/evolve pause` sets `paused`, `/evolve resume` sets `enabled=true` and
 *   clears the pause, while manual tools and commands remain independent;
 * - a missing or malformed file uses the caller's configured default. A
 *   legacy v1 `{paused}` file is readable and preserves its pause state.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { EVOLVE_DIR } from "./store.js";

const RUNTIME_FILE = "runtime.json";

/** On-disk runtime gate state. Version 2 adds an explicit enable bit. */
export interface GateRuntime {
	version: 2;
	/** Whether the human has enabled automatic review. */
	enabled: boolean;
	/** Whether the human has explicitly paused automatic review. */
	paused: boolean;
	/** ISO timestamp of the last pause/resume write. */
	updatedAt: string;
}

/** Full path of the runtime switch file. */
export function runtimePath(baseDir: string): string {
	return join(baseDir, EVOLVE_DIR, RUNTIME_FILE);
}

function state(enabled: boolean, paused: boolean): GateRuntime {
	return { version: 2, enabled, paused, updatedAt: new Date(0).toISOString() };
}

/**
 * Load the runtime switch. Missing, malformed, or legacy content uses the
 * supplied configured default and never throws; this is a trigger-path read.
 */
export function loadGateRuntime(baseDir: string, defaultEnabled = false): GateRuntime {
	const path = runtimePath(baseDir);
	if (!existsSync(path)) return state(defaultEnabled, false);
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return state(defaultEnabled, false);
		const record = raw as Record<string, unknown>;
		const paused = record["paused"] === true;
		// v1 had no enable bit. Its only meaningful state was pause, so retain
		// the configured default when it is not paused.
		const enabled = typeof record["enabled"] === "boolean" ? record["enabled"] : defaultEnabled;
		return {
			version: 2,
			enabled,
			paused,
			updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : new Date(0).toISOString(),
		};
	} catch {
		return state(defaultEnabled, false);
	}
}

/** Persist the runtime switch atomically (temp file + rename). */
export function saveGateRuntime(baseDir: string, paused: boolean, enabled = true): string {
	const path = runtimePath(baseDir);
	mkdirSync(join(baseDir, EVOLVE_DIR), { recursive: true });
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const payload: GateRuntime = { version: 2, enabled, paused, updatedAt: new Date().toISOString() };
	writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	try {
		renameSync(tempPath, path);
	} finally {
		if (existsSync(tempPath)) unlinkSync(tempPath);
	}
	return path;
}

/** True while the human paused the automatic review gate. */
export function isGatePaused(baseDir: string): boolean {
	try {
		return loadGateRuntime(baseDir).paused;
	} catch {
		return false;
	}
}

/** Effective automatic-review state, including the explicit enable bit. */
export function isGateEnabled(baseDir: string, defaultEnabled = false): boolean {
	try {
		const current = loadGateRuntime(baseDir, defaultEnabled);
		return current.enabled && !current.paused;
	} catch {
		return defaultEnabled;
	}
}
