/**
 * Store layout and snapshot discipline for the evolution plugin.
 *
 * Layout (self-contained under the DSH home; no dependency on session
 * persistence internals):
 *
 *   <dshHome>/evolve/global/harness_state.json    cross-session store
 *   <dshHome>/evolve/global/refinements.jsonl     applied results (rollback source)
 *   <dshHome>/evolve/local/<sessionId>/...        per-session store
 *
 * Snapshot discipline is code-enforced: before any mutating apply, the
 * pre-apply state is copied to `snapshots/<refinementId>.json`. The model has
 * no way to skip it — it runs inside the service, not in a prompt.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessScope, HarnessState, RefinementResult } from "./types.js";
import { emptyHarnessState } from "./types.js";
import { stateFilePath } from "./state.js";

export const EVOLVE_DIR = "evolve";

export interface StorePaths {
	/** Directory holding harness_state.json. */
	stateDir: string;
	/** Directory holding snapshots for this store. */
	snapshotsDir: string;
	/** JSONL path for applied refinement results. */
	resultsPath: string;
}

export function storePaths(baseDir: string, scope: HarnessScope, sessionId?: string): StorePaths {
	const scopeDir = scope === "global" ? "global" : join("local", sessionId ?? "anonymous");
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
	writeFileSync(join(paths.snapshotsDir, `${refinementId}.json`), readFileSync(statePath, "utf8"), "utf8");
}

/** Append an applied result to the store's JSONL history. */
export function appendResult(paths: StorePaths, result: RefinementResult): void {
	mkdirSync(paths.stateDir, { recursive: true });
	writeFileSync(paths.resultsPath, `${JSON.stringify(result)}\n`, { encoding: "utf8", flag: "a" });
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

/** Load a state file into memory, returning empty state when absent. */
export function loadStateFile(paths: StorePaths): HarnessState {
	return existsSync(stateFilePath(paths.stateDir))
		? (JSON.parse(readFileSync(stateFilePath(paths.stateDir), "utf8")) as HarnessState)
		: emptyHarnessState();
}
