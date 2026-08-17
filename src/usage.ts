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
import type { HarnessState, RefinementKind } from "./types.js";

const USAGE_FILE = "usage.json";

function usagePath(baseDir: string): string {
	return join(baseDir, "evolve", USAGE_FILE);
}

export interface UsageStore {
	/** Injection count per entry key (`kind:id`). */
	counts: Record<string, number>;
}

/** Load the usage store from disk; returns an empty store when absent or corrupt. */
export function loadUsage(baseDir: string): UsageStore {
	const path = usagePath(baseDir);
	try {
		if (!existsSync(path)) return { counts: {} };
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
			return { counts: raw as Record<string, number> };
		}
		return { counts: {} };
	} catch {
		return { counts: {} };
	}
}

/** Persist the usage store atomically. */
export function saveUsage(baseDir: string, store: UsageStore): void {
	const dir = join(baseDir, "evolve");
	mkdirSync(dir, { recursive: true });
	const path = usagePath(baseDir);
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(store.counts, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/** Build the usage key for an entry. */
export function usageKey(kind: RefinementKind, id: string): string {
	return `${kind}:${id}`;
}

/**
 * Increment injection counts for the entries that were actually injected.
 * Called after `entriesSectionText` renders the injected block. Keys not
 * present in the store are initialized to 1; existing keys are incremented.
 */
export function recordInjection(baseDir: string, injectedKeys: string[]): void {
	if (injectedKeys.length === 0) return;
	const store = loadUsage(baseDir);
	for (const key of injectedKeys) {
		store.counts[key] = (store.counts[key] ?? 0) + 1;
	}
	saveUsage(baseDir, store);
}

/**
 * Get the injection count for a specific entry. Returns 0 when the entry
 * has never been injected (absent from the store).
 */
export function getUsageCount(store: UsageStore, kind: RefinementKind, id: string): number {
	return store.counts[usageKey(kind, id)] ?? 0;
}

/**
 * Find entries with zero injection usage. Returns `{kind, id, title}` for
 * each entry that has never been injected — prime candidates for archival.
 */
export function zeroUsageEntries(
	state: HarnessState,
	store: UsageStore,
): { kind: RefinementKind; id: string; title: string }[] {
	const results: { kind: RefinementKind; id: string; title: string }[] = [];
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		for (const entry of Object.values(state.entries[kind])) {
			if (entry.scope !== "local") continue;
			if (getUsageCount(store, kind, entry.id) === 0) {
				results.push({ kind, id: entry.id, title: entry.title });
			}
		}
	}
	return results;
}
