/**
 * Runtime gate switch (#21 P2): a tiny human-owned file that pauses the
 * automatic review gate without touching the plugin config or restarting.
 *
 * - file: `<baseDir>/evolve/runtime.json` (`{version, paused, updatedAt}`)
 * - `/evolve pause` sets paused, `/evolve resume` clears it, `/evolve
 *   status` shows it alongside the static patch config.
 * - the gate consults it on every trigger (turn-interval AND compaction)
 *   and stays dormant while paused — manual tools/commands keep working.
 * - fail-open: a missing or corrupt file means "running". Pausing is the
 *   exceptional state; a broken file must never silently wedge the gate
 *   shut (the next save rewrites it cleanly).
 */
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { EVOLVE_DIR } from "./store.js";

const RUNTIME_FILE = "runtime.json";

export interface GateRuntime {
	version: 1;
	/** True while the human paused the automatic review gate. */
	paused: boolean;
	/** ISO timestamp of the last pause/resume write. */
	updatedAt: string;
}

/** Full path of the runtime switch file. */
export function runtimePath(baseDir: string): string {
	return join(baseDir, EVOLVE_DIR, RUNTIME_FILE);
}

function running(): GateRuntime {
	return { version: 1, paused: false, updatedAt: new Date(0).toISOString() };
}

/**
 * Load the runtime switch; fail open to "running" on any unreadable or
 * malformed content (called on every gate trigger, so it must never throw
 * for a bad file).
 */
export function loadGateRuntime(baseDir: string): GateRuntime {
	const path = runtimePath(baseDir);
	if (!existsSync(path)) {
		return running();
	}
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return running();
		}
		const record = raw as Record<string, unknown>;
		return {
			version: 1,
			paused: record["paused"] === true,
			updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : new Date(0).toISOString(),
		};
	} catch {
		return running();
	}
}

/**
 * Persist the pause switch atomically (temp file + rename). Never throws
 * for a bad file — callers (pause/resume commands) surface real IO errors
 * through the command's own error path instead.
 */
export function saveGateRuntime(baseDir: string, paused: boolean): string {
	const path = runtimePath(baseDir);
	mkdirSync(join(baseDir, EVOLVE_DIR), { recursive: true });
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const payload: GateRuntime = { version: 1, paused, updatedAt: new Date().toISOString() };
	writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	try {
		renameSync(tempPath, path);
	} finally {
		if (existsSync(tempPath)) {
			unlinkSync(tempPath);
		}
	}
	return path;
}

/** True while the human paused the automatic review gate (fail-open). */
export function isGatePaused(baseDir: string): boolean {
	try {
		return loadGateRuntime(baseDir).paused;
	} catch {
		return false;
	}
}
