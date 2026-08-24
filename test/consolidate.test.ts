/**
 * Consolidation tests (R3): conflictHint pairs and stale zero-use entries
 * become one deterministic, deduped batch of archive edits.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessEntry, HarnessState } from "../src/types.js";
import { ARCHIVED_AT_KEY, CONFLICT_HINT_KEY, emptyHarnessState } from "../src/types.js";
import { createEvolutionEngine } from "../src/service.js";
import { storePaths } from "../src/store.js";
import { loadUsage, saveUsage, usageKey } from "../src/usage.js";
import { loadHarnessState, saveHarnessState } from "../src/state.js";
import { findConflictPairs, findStaleEntries, parseConflictHint, planConsolidation } from "../src/consolidate.js";

const NOW = Date.parse("2026-08-24T00:00:00.000Z");

function entry(overrides: Partial<HarnessEntry> & { id: string; kind: HarnessEntry["kind"]; title: string }): HarnessEntry {
	return {
		content: "body",
		path: "general",
		scope: "global",
		reference: {},
		arguments: {},
		metadata: {},
		source: "evolve",
		created_at: "2026-08-24T00:00:00.000Z",
		updated_at: "2026-08-24T00:00:00.000Z",
		version: 1,
		...overrides,
	};
}

function seed(entries: readonly HarnessEntry[]): HarnessState {
	const state = emptyHarnessState();
	for (const item of entries) {
		state.entries[item.kind][item.id] = item;
	}
	return state;
}

describe("parseConflictHint", () => {
	it("accepts well-formed hints and rejects everything else", () => {
		expect(parseConflictHint("memory:evolve_x:0.73")).toEqual({ kind: "memory", id: "evolve_x", score: 0.73 });
		expect(parseConflictHint("prompt:p1:0")).toEqual({ kind: "prompt", id: "p1", score: 0 });
		expect(parseConflictHint("near-duplicate text")).toBeUndefined();
		expect(parseConflictHint("foo:id:0.5")).toBeUndefined();
		expect(parseConflictHint("memory:id:1.5")).toBeUndefined();
		expect(parseConflictHint("memory:id:abc")).toBeUndefined();
		expect(parseConflictHint(42)).toBeUndefined();
	});
});

describe("findConflictPairs", () => {
	it("lists hinted entries whose target is alive, skips dead ends", () => {
		const state = seed([
			entry({ id: "original", kind: "memory", title: "原条目", content: "x" }),
			entry({ id: "hinted", kind: "memory", title: "重复条目", content: "y", metadata: { [CONFLICT_HINT_KEY]: "memory:original:0.66" } }),
			entry({ id: "orphan", kind: "memory", title: "目标消失", content: "y", metadata: { [CONFLICT_HINT_KEY]: "memory:gone:0.9" } }),
			entry({ id: "dead-target", kind: "memory", title: "目标已归档", content: "y", metadata: { [CONFLICT_HINT_KEY]: "memory:archived-target:0.9" } }),
			entry({ id: "archived-target", kind: "memory", title: "t", content: "y", metadata: { [ARCHIVED_AT_KEY]: "2026-08-01T00:00:00.000Z" } }),
			entry({ id: "self-archived", kind: "memory", title: "自己已归档", content: "y", metadata: { [CONFLICT_HINT_KEY]: "memory:original:0.7", [ARCHIVED_AT_KEY]: "2026-08-02T00:00:00.000Z" } }),
			entry({ id: "kind-mismatch", kind: "prompt", title: "kind 不符", content: "y", metadata: { [CONFLICT_HINT_KEY]: "memory:original:0.7" } }),
		]);
		const pairs = findConflictPairs(state);
		expect(pairs).toHaveLength(1);
		expect(pairs[0]!.id).toBe("hinted");
		expect(pairs[0]!.reason).toContain("original");
		expect(pairs[0]!.reason).toContain("66%");
	});
});

describe("findStaleEntries", () => {
	it("includes only old, never-injected, active entries", () => {
		const state = seed([
			entry({ id: "stale", kind: "prompt", title: "old", content: "x", updated_at: "2026-07-24T00:00:00.000Z" }),
			entry({ id: "boundary", kind: "prompt", title: "exact age", content: "x", updated_at: "2026-07-25T00:00:00.000Z" }),
			entry({ id: "fresh", kind: "prompt", title: "recent", content: "x", updated_at: "2026-08-20T00:00:00.000Z" }),
			entry({ id: "used", kind: "prompt", title: "injected before", content: "x", updated_at: "2026-07-24T00:00:00.000Z" }),
			entry({ id: "archived", kind: "prompt", title: "gone", content: "x", updated_at: "2026-07-24T00:00:00.000Z", metadata: { [ARCHIVED_AT_KEY]: "2026-08-01T00:00:00.000Z" } }),
		]);
		const dir = mkdtempSync(join(tmpdir(), "consolidate-stale-"));
		try {
			const store = loadUsage(dir);
			store.counts[usageKey("prompt", "used")] = 2;
			saveUsage(dir, store);
			const reloaded = loadUsage(dir);
			const ids = findStaleEntries(state, reloaded, NOW).map((c) => c.id);
			expect(ids).toContain("stale");
			expect(ids).toContain("boundary"); // exactly STALE_MIN_AGE_MS old still counts
			expect(ids).not.toContain("fresh");
			expect(ids).not.toContain("used");
			expect(ids).not.toContain("archived");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("planConsolidation", () => {
	it("dedupes overlap with the conflict reason winning and preserves metadata", () => {
		const hintedStale = entry({
			id: "both",
			kind: "memory",
			title: "双重命中",
			content: "body text",
			updated_at: "2026-06-01T00:00:00.000Z",
			metadata: { [CONFLICT_HINT_KEY]: "memory:original:0.61", customKey: "keep-me" },
		});
		const state = seed([entry({ id: "original", kind: "memory", title: "原", content: "x" }), hintedStale]);
		const dir = mkdtempSync(join(tmpdir(), "consolidate-plan-"));
		try {
			const { candidates, edits } = planConsolidation(state, loadUsage(dir), NOW);
			expect(candidates).toHaveLength(1);
			expect(candidates[0]!.reason).toContain("near-duplicate");
			expect(edits).toHaveLength(1);
			expect(edits[0]!.action).toBe("update");
			expect(edits[0]!.metadata?.[ARCHIVED_AT_KEY]).toBeTruthy();
			expect(edits[0]!.metadata?.customKey).toBe("keep-me");
			expect(edits[0]!.metadata?.[CONFLICT_HINT_KEY]).toBe("memory:original:0.61");
			expect(edits[0]!.content).toBe("body text");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("consolidate end-to-end through the engine", () => {
	it("archives the planned batch as one refinement", () => {
		const dir = mkdtempSync(join(tmpdir(), "consolidate-e2e-"));
		try {
			const state = seed([
				entry({ id: "original", kind: "memory", title: "原", content: "x" }),
				entry({ id: "hinted", kind: "memory", title: "重复", content: "y", updated_at: "2026-06-01T00:00:00.000Z", metadata: { [CONFLICT_HINT_KEY]: "memory:original:0.85" } }),
			]);
			saveHarnessState(storePaths(dir, "global", undefined).stateDir, state);
			const engine = createEvolutionEngine(dir);
			const { edits } = planConsolidation(engine.load("global", undefined), loadUsage(dir));
			expect(edits.length).toBeGreaterThanOrEqual(1);
			const result = engine.apply(
				"global",
				undefined,
				{
					summary: "test batch",
					rationale: "test",
					expectedOutcome: "all planned entries archived",
					edits,
				},
				{ scope: "global" },
			);
			const reloaded = loadHarnessState(storePaths(dir, "global", undefined).stateDir, "global");
			for (const applied of result.appliedEdits) {
				expect(isArchivedLike(reloaded.entries[applied.kind][applied.id!])).toBe(true);
			}
			expect(reloaded.entries.memory.original?.metadata[ARCHIVED_AT_KEY]).toBeUndefined(); // original untouched
			expect(engine.history("global", undefined)).toHaveLength(1); // single refinement record
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}

		function isArchivedLike(candidate: HarnessEntry | undefined): boolean {
			return typeof candidate?.metadata[ARCHIVED_AT_KEY] === "string" && candidate.metadata[ARCHIVED_AT_KEY].length > 0;
		}
	});
});
