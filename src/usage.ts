/**
 * Entry usage tracking (gap B1): records how many times each entry has been
 * injected into system prompts. The counts are durable (persisted to disk)
 * and exposed in `evolve_list` and the gate's archive-candidate reporting,
 * so "zero-usage stale entries" can be surfaced for cleanup.
 *
 * Storage: `<baseDir>/evolve/usage.json` — a flat JSON object mapping
 * `kind:id` to an integer count. Reads are tolerant of missing/corrupt files;
 * writes are atomic (tmp + rename).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RefinementKind } from "./types.js";

const USAGE_FILE = "usage.json";

function usagePath(baseDir: string): string {
	return join(baseDir, "evolve", USAGE_FILE);
}

export interface UsageStore {
	/** Injection count per entry key (`kind:id`). */
	counts: Record<string, number>;
	/** Session dedup marker: the last session id each key was counted in (v2). */
	lastSession?: Record<string, string>;
}

/**
 * Load the usage store from disk; returns an empty store when absent or
 * corrupt. Accepts BOTH on-disk shapes:
 * - legacy (≤0.3.x): a flat `{ "kind:id": count }` map,
 * - v2: `{ version: 2, counts, lastSession }` with per-session dedup.
 */
export function loadUsage(baseDir: string): UsageStore {
	const path = usagePath(baseDir);
	try {
		if (!existsSync(path)) return { counts: {}, lastSession: {} };
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
			const record = raw as Record<string, unknown>;
			if (record["version"] === 2 && typeof record["counts"] === "object" && record["counts"] !== null) {
				return {
					counts: record["counts"] as Record<string, number>,
					lastSession:
						typeof record["lastSession"] === "object" && record["lastSession"] !== null
							? (record["lastSession"] as Record<string, string>)
							: {},
				};
			}
			// Legacy flat map: every key is a count.
			return { counts: raw as Record<string, number>, lastSession: {} };
		}
		return { counts: {}, lastSession: {} };
	} catch {
		return { counts: {}, lastSession: {} };
	}
}

/** Persist the usage store atomically (always the v2 shape). */
export function saveUsage(baseDir: string, store: UsageStore): void {
	const dir = join(baseDir, "evolve");
	mkdirSync(dir, { recursive: true });
	const path = usagePath(baseDir);
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ version: 2, counts: store.counts, lastSession: store.lastSession ?? {} }, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/** Build the usage key for an entry. */
export function usageKey(kind: RefinementKind, id: string): string {
	return `${kind}:${id}`;
}

/**
 * Increment injection counts for the entries that were actually injected.
 * Called after `entriesSectionText` renders the injected block. Keys not
 * present in the store are initialized to 1.
 *
 * Session dedup (2026-08-22): with a sessionId, each key counts AT MOST
 * ONCE per session — the old per-build counting produced meaningless
 * numbers (one entry hit 2311× in a week) and hid the real "how many
 * sessions found this useful" signal that staleness decay needs. Without
 * a sessionId the call degrades to legacy always-increment behavior.
 */
export function recordInjection(baseDir: string, injectedKeys: readonly string[], sessionId?: string): void {
	if (injectedKeys.length === 0) return;
	const store = loadUsage(baseDir);
	let dirty = false;
	for (const key of injectedKeys) {
		if (sessionId !== undefined && store.lastSession?.[key] === sessionId) {
			continue;
		}
		store.counts[key] = (store.counts[key] ?? 0) + 1;
		if (store.lastSession && sessionId !== undefined) {
			store.lastSession[key] = sessionId;
		}
		dirty = true;
	}
	if (dirty) {
		saveUsage(baseDir, store);
	}
}

/**
 * Get the injection count for a specific entry. Returns 0 when the entry
 * has never been injected (absent from the store).
 */
export function getUsageCount(store: UsageStore, kind: RefinementKind, id: string): number {
	return store.counts[usageKey(kind, id)] ?? 0;
}
