/**
 * Persistence layer for harness state: atomic writes, corrupt-file degrade,
 * scope merge, and optimistic-concurrency primitives.
 *
 * Safety properties (code-enforced, not prompt-enforced):
 * - writes are atomic (temp file + rename) and preserve the file mode;
 * - an unreadable or non-object state file degrades to empty state so a
 *   broken file can never take a session down; the next save rewrites it
 *   cleanly;
 * - every entry read from disk is shape-normalized (scope, reference,
 *   arguments, metadata) so a hand-edited file cannot smuggle garbage into
 *   the system prompt renderer.
 */
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { HarnessScope, HarnessState } from "./types.js";
import { emptyHarnessState } from "./types.js";

/** Directory holding the cross-session (global) store. */
export function globalStateDir(baseDir: string): string {
	return join(baseDir, "evolve");
}

/** Directory holding a session-scoped (local) store, if the session has one. */
export function localStateDir(sessionDir: string | undefined): string | undefined {
	return sessionDir ? join(sessionDir, "evolve") : undefined;
}

export function stateFilePath(stateDir: string): string {
	return join(stateDir, "harness_state.json");
}

function normalizeScope(value: unknown, fallback: HarnessScope): HarnessScope {
	return value === "global" || value === "local" ? value : fallback;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

/**
 * Load state from disk, degrading to empty on any unreadable or malformed
 * content. Called on every system-prompt build and before every apply, so it
 * must never throw for a bad file.
 */
export function loadHarnessState(stateDir: string, scope: HarnessScope = "global"): HarnessState {
	const path = stateFilePath(stateDir);
	if (!existsSync(path)) {
		return emptyHarnessState();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return emptyHarnessState();
	}
	const root = objectRecord(parsed);
	if (!root) {
		return emptyHarnessState();
	}
	const state = emptyHarnessState();
	if (typeof root["schema"] === "number") {
		state.schema = root["schema"];
	}
	const entries = objectRecord(root["entries"]);
	if (entries) {
		for (const kind of Object.keys(state.entries) as (keyof HarnessState["entries"])[]) {
			const records = objectRecord(entries[kind]);
			if (!records) continue;
			for (const [id, raw] of Object.entries(records)) {
				const entry = objectRecord(raw);
				if (!entry) continue;
				state.entries[kind][id] = {
					id: typeof entry["id"] === "string" ? entry["id"] : id,
					kind,
					title: typeof entry["title"] === "string" ? entry["title"] : id,
					content: typeof entry["content"] === "string" ? entry["content"] : "",
					path: typeof entry["path"] === "string" ? entry["path"] : "general",
					scope: normalizeScope(entry["scope"], scope),
					reference: objectRecord(entry["reference"]) ?? {},
					arguments: objectRecord(entry["arguments"]) ?? {},
					metadata: objectRecord(entry["metadata"]) ?? {},
					source: entry["source"] === "evolve" ? "evolve" : "evolve",
					created_at: typeof entry["created_at"] === "string" ? entry["created_at"] : new Date(0).toISOString(),
					updated_at: typeof entry["updated_at"] === "string" ? entry["updated_at"] : new Date(0).toISOString(),
					version: typeof entry["version"] === "number" ? entry["version"] : 1,
				};
			}
		}
	}
	if (Array.isArray(root["refinements"])) {
		state.refinements = root["refinements"] as HarnessState["refinements"];
	}
	return state;
}

/**
 * Merge global and local state into the view the model sees. Local entries
 * win over same-id global entries; a colliding local id is prefixed
 * `local:` so both remain addressable.
 */
export function mergeHarnessStates(globalState: HarnessState, localState: HarnessState | undefined): HarnessState {
	const merged = emptyHarnessState();
	merged.schema = Math.max(globalState.schema, localState?.schema ?? 1);
	for (const kind of Object.keys(merged.entries) as (keyof HarnessState["entries"])[]) {
		for (const [id, entry] of Object.entries(globalState.entries[kind])) {
			merged.entries[kind][id] = { ...entry, scope: "global" };
		}
		for (const [id, entry] of Object.entries(localState?.entries[kind] ?? {})) {
			const scoped = { ...entry, scope: "local" as const };
			const mergedId = merged.entries[kind][id] ? `local:${id}` : id;
			merged.entries[kind][mergedId] = scoped;
		}
	}
	merged.refinements = [...globalState.refinements, ...(localState?.refinements ?? [])];
	return merged;
}

/**
 * Persist state atomically: write to a temp file, fsync-free but rename-based,
 * preserving the mode of an existing file (defaults to 0o600 for new files).
 */
export function saveHarnessState(stateDir: string, state: HarnessState): string {
	const path = stateFilePath(stateDir);
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	mkdirSync(stateDir, { recursive: true });
	try {
		const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
		writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode });
		renameSync(tempPath, path);
	} finally {
		if (existsSync(tempPath)) {
			unlinkSync(tempPath);
		}
	}
	return path;
}

/**
 * Capture the state snapshot a plan was based on. At apply time the caller
 * re-reads the file and compares; an entry that changed since planning is
 * rejected per-edit, never silently overwritten.
 */
export function baselineOf(state: HarnessState): HarnessState {
	return JSON.parse(JSON.stringify(state)) as HarnessState;
}

/** True when an entry in `current` differs from the same entry in `baseline`. */
export function entryChangedSince(
	baseline: HarnessState,
	current: HarnessState,
	kind: keyof HarnessState["entries"],
	id: string,
): boolean {
	const before = baseline.entries[kind][id];
	const after = current.entries[kind][id];
	return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
}

/** The set of keys an entry must not expose beyond the persisted shape. */
export const ENTRY_KEYS = ["id", "kind", "title", "content", "path", "scope", "reference", "arguments", "metadata", "source", "created_at", "updated_at", "version"] as const;
