/**
 * Store layout and snapshot discipline for the evolution plugin.
 *
 * Layout (self-contained under the DSH home; no dependency on session
 * persistence internals):
 *
 *   <dshHome>/evolve/global/harness_state.json    cross-project store
 *   <dshHome>/evolve/global/refinements.jsonl     applied results (rollback source)
 *   <dshHome>/evolve/projects/<slug-hash>/...     per-project store
 *   <dshHome>/evolve/local/<sessionId>/...        per-session staging store
 *
 * Snapshot discipline is code-enforced: before any mutating apply, the
 * pre-apply state is copied to `snapshots/<refinementId>.json`. The model has
 * no way to skip it — it runs inside the service, not in a prompt.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessScope, RefinementResult } from "./types.js";
import { sanitizeProjectKey } from "./project.js";
import { stateFilePath } from "./state.js";

export const EVOLVE_DIR = "evolve";

/**
 * Storage-hygiene defaults (#20): history used to grow append-only without
 * bound (dozens of full-state snapshot copies, unbounded JSONL). Retention
 * is count-based and generous — rollback only ever needs recent snapshots
 * and readers (`failures.ts` over reviews) need a working window, not the
 * full past. Tunable via the `historyRetain` plugin config.
 */
export const DEFAULT_SNAPSHOT_RETAIN = 20;
export const DEFAULT_REFINEMENTS_RETAIN = 500;
export const DEFAULT_REVIEWS_RETAIN = 500;

/** Resolved retention triple: how many snapshots / JSONL tail lines to keep. */
export interface HistoryRetention {
	/** Full-state snapshots kept per store (oldest pruned first). */
	snapshots: number;
	/** Tail lines kept in each store's refinements.jsonl. */
	refinements: number;
	/** Tail lines kept in the shared reviews.jsonl audit trail. */
	reviews: number;
}

/** Defaults applied for absent / non-positive retention fields (fail loud never: clamp, don't throw). */
export function resolveHistoryRetention(raw?: Partial<HistoryRetention>): HistoryRetention {
	const pick = (value: unknown, fallback: number): number =>
		typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
	return {
		snapshots: pick(raw?.snapshots, DEFAULT_SNAPSHOT_RETAIN),
		refinements: pick(raw?.refinements, DEFAULT_REFINEMENTS_RETAIN),
		reviews: pick(raw?.reviews, DEFAULT_REVIEWS_RETAIN),
	};
}

export interface StorePaths {
	/** Directory holding harness_state.json. */
	stateDir: string;
	/** Directory holding snapshots for this store. */
	snapshotsDir: string;
	/** JSONL path for applied refinement results. */
	resultsPath: string;
}

/**
 * Resolve store paths for a scope. For `project` the `sessionId` parameter
 * carries the project key (see {@link resolveProjectKey} in project.ts) —
 * it is sanitized to a single path segment so an externally supplied key
 * can never traverse out of `evolve/projects/`.
 */
export function storePaths(baseDir: string, scope: HarnessScope, sessionId?: string): StorePaths {
	const scopeDir =
		scope === "global" ? "global" : scope === "project" ? join("projects", sanitizeProjectKey(sessionId ?? "project")) : join("local", sessionId ?? "anonymous");
	const stateDir = join(baseDir, EVOLVE_DIR, scopeDir);
	return {
		stateDir,
		snapshotsDir: join(stateDir, "snapshots"),
		resultsPath: join(stateDir, "refinements.jsonl"),
	};
}

/** Snapshot the current state file before a mutation, if one exists. */
export function snapshotBefore(paths: StorePaths, refinementId: string): void {
	const statePath = stateFilePath(paths.stateDir);
	if (!existsSync(statePath)) {
		return;
	}
	mkdirSync(paths.snapshotsDir, { recursive: true });
	// 0600: the snapshot is a full copy of harness_state.json — same
	// permission discipline as the store itself (review audit 2026-08-28 S5).
	writeFileSync(join(paths.snapshotsDir, `${refinementId}.json`), readFileSync(statePath, "utf8"), { encoding: "utf8", mode: 0o600 });
}

/** Append an applied result to the store's JSONL history. */
export function appendResult(paths: StorePaths, result: RefinementResult): void {
	mkdirSync(paths.stateDir, { recursive: true });
	writeFileSync(paths.resultsPath, `${JSON.stringify(result)}\n`, { encoding: "utf8", flag: "a" });
}

/**
 * Prune a store's snapshots to the newest `retain` files (by mtime, oldest
 * first). Best-effort: a missing directory or an unlink failure never breaks
 * the apply path — the next apply retries.
 */
export function pruneSnapshots(snapshotsDir: string, retain: number): void {
	const keep = Math.floor(retain);
	if (!(keep > 0) || !existsSync(snapshotsDir)) return;
	let files: string[];
	try {
		files = readdirSync(snapshotsDir).filter((f) => f.endsWith(".json"));
	} catch {
		return; // unreadable directory — leave it for the next attempt
	}
	if (files.length <= keep) return;
	const withTime: { file: string; mtime: number }[] = [];
	for (const file of files) {
		try {
			withTime.push({ file, mtime: statSync(join(snapshotsDir, file)).mtimeMs });
		} catch {
			// unstatable file — keep it rather than delete blindly
		}
	}
	withTime.sort((a, b) => a.mtime - b.mtime);
	for (const victim of withTime.slice(0, Math.max(0, withTime.length - keep))) {
		try {
			unlinkSync(join(snapshotsDir, victim.file));
		} catch {
			// one bad unlink must not stop the sweep or the apply path
		}
	}
}

/**
 * Truncate a JSONL file to its last `retain` non-empty lines. No-op when the
 * file is missing or already within budget — the common case costs one
 * read and no write.
 */
export function pruneJsonlFile(path: string, retain: number): void {
	const keep = Math.floor(retain);
	if (!(keep > 0) || !existsSync(path)) return;
	let lines: string[];
	try {
		lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
	} catch {
		return; // unreadable file — leave it for the next attempt
	}
	if (lines.length <= keep) return;
	try {
		writeFileSync(path, `${lines.slice(-keep).join("\n")}\n`, "utf8");
	} catch {
		// truncation failure must not break the write path that called it
	}
}

/** Reviews audit-trail path shared by the gate, fate, and tool events. */
export function reviewsPath(baseDir: string): string {
	return join(baseDir, EVOLVE_DIR, "reviews.jsonl");
}

/** Read the applied results history; malformed lines are skipped, never fatal. */
export function loadResults(paths: StorePaths): RefinementResult[] {
	if (!existsSync(paths.resultsPath)) {
		return [];
	}
	const results: RefinementResult[] = [];
	for (const line of readFileSync(paths.resultsPath, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (isResult(parsed)) {
				results.push(parsed);
			}
		} catch {
			// skip malformed line
		}
	}
	return results;
}

function isResult(data: unknown): data is RefinementResult {
	return typeof data === "object" && data !== null && "id" in data && "appliedEdits" in data;
}
