/**
 * Write-time conflict guard tests (R2): global creates are mechanically
 * checked against the existing store at the engine's single chokepoint —
 * near-duplicates are rejected with an actionable error, moderate overlaps
 * proceed stamped with CONFLICT_HINT_KEY, rollbacks and local scope are
 * exempt.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HarnessEntry } from "../src/types.js";
import { CONFLICT_HINT_KEY, emptyHarnessState } from "../src/types.js";
import { createEvolutionEngine } from "../src/service.js";
import { storePaths } from "../src/store.js";
import { loadHarnessState, saveHarnessState } from "../src/state.js";
import { buildConflictNotice, mostSimilarEntry } from "../src/promotion.js";

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

function makeEngine(): { dir: string; engine: ReturnType<typeof createEvolutionEngine>; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "conflict-guard-"));
	return { dir, engine: createEvolutionEngine(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seedGlobal(dir: string, entries: readonly HarnessEntry[]): void {
	const state = emptyHarnessState();
	for (const item of entries) {
		state.entries[item.kind][item.id] = item;
	}
	saveHarnessState(storePaths(dir, "global", undefined).stateDir, state);
}

function createProposal(kind: HarnessEntry["kind"], title: string, content: string) {
	return { summary: "test", rationale: "test", expectedOutcome: "test", edits: [{ action: "create" as const, kind, title, content }] };
}

describe("mostSimilarEntry / buildConflictNotice", () => {
	it("finds the best non-archived hit above the threshold and ignores the rest", () => {
		const kept = entry({ id: "kept", kind: "memory", title: "Rate limit policy", content: "exponential backoff on 429" });
		const archived = entry({ id: "arch", kind: "memory", title: "Rate limit policy twin", content: "exponential backoff on 429", metadata: { archivedAt: "2026-08-01T00:00:00.000Z" } });
		const unrelated = entry({ id: "other", kind: "memory", title: "Baking", content: "oven temperature" });
		expect(mostSimilarEntry([kept, archived, unrelated], "rate limit rules", "backoff on 429 errors", 0.5)?.id).toBe("kept");
		expect(mostSimilarEntry([unrelated], "rate limit rules", "backoff on 429 errors", 0.5)).toBeUndefined();
	});

	it("formats the notice with id, title, and percent", () => {
		expect(buildConflictNotice({ id: "evolve_x", title: "限流策略", score: 0.83 })).toContain("evolve_x");
		expect(buildConflictNotice({ id: "evolve_x", title: "限流策略", score: 0.83 })).toContain("限流策略");
		expect(buildConflictNotice({ id: "evolve_x", title: "限流策略", score: 0.83 })).toContain("83%");
	});
});

describe("write-time conflict guard (engine.apply)", () => {
	it("blocks a global near-duplicate create before any side effect", () => {
		const { dir, engine, cleanup } = makeEngine();
		try {
			seedGlobal(dir, [entry({ id: "existing", kind: "memory", title: "T1", content: "w1a w2b w3c w4d" })]);
			expect(() => engine.apply("global", undefined, createProposal("memory", "T2", "w1a w2b w3c w4d"))).toThrow(/create blocked.*existing.*evolve_update/s);
			expect(engine.history("global", undefined)).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	it("stamps a warn-tier overlap instead of blocking", () => {
		const { dir, engine, cleanup } = makeEngine();
		try {
			seedGlobal(dir, [entry({ id: "base", kind: "memory", title: "T1", content: "w1a w2b w3c w4d" })]);
			// Token sets {w1a,w2b,w3c,w4d} ∩ {w1a,w2b,w3c,w9z} = 3, union = 5 → 0.60.
			const result = engine.apply("global", undefined, createProposal("memory", "unrelated-title", "w1a w2b w3c w9z"));
			const createdId = result.appliedEdits[0]!.id!;
			const reloaded = loadHarnessState(storePaths(dir, "global", undefined).stateDir, "global");
			const hint = reloaded.entries.memory[createdId]?.metadata[CONFLICT_HINT_KEY];
			expect(String(hint)).toMatch(/^memory:base:0\.60$/);
			expect(result.appliedEdits[0]!.after?.metadata[CONFLICT_HINT_KEY]).toBe(hint);
		} finally {
			cleanup();
		}
	});

	it("leaves distinct global creates unstamped", () => {
		const { dir, engine, cleanup } = makeEngine();
		try {
			seedGlobal(dir, [entry({ id: "base", kind: "memory", title: "T1", content: "w1a w2b w3c w4d" })]);
			const result = engine.apply("global", undefined, createProposal("memory", "fresh ground", "totally different body text"));
			const createdId = result.appliedEdits[0]!.id!;
			const reloaded = loadHarnessState(storePaths(dir, "global", undefined).stateDir, "global");
			expect(reloaded.entries.memory[createdId]?.metadata[CONFLICT_HINT_KEY]).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("never blocks local scope (scratch space)", () => {
		const { dir, engine, cleanup } = makeEngine();
		try {
			seedGlobal(dir, [entry({ id: "g1", kind: "memory", title: "T1", content: "w1a w2b w3c w4d" })]);
			seedLocalDuplicate(dir);
			const result = engine.apply("local", "session-x", createProposal("memory", "T2", "w1a w2b w3c w4d"));
			expect(result.appliedEdits[0]!.applied).toBe(true);
		} finally {
			cleanup();
		}

		function seedLocalDuplicate(dir: string): void {
			const state = emptyHarnessState();
			state.entries.memory.l1 = entry({ id: "l1", kind: "memory", title: "T1 twin", content: "w1a w2b w3c w4d" });
			saveHarnessState(storePaths(dir, "local", "session-x").stateDir, state);
		}
	});

	it("exempts rollbackOf re-creations from the block", () => {
		const { dir, engine, cleanup } = makeEngine();
		try {
			seedGlobal(dir, [entry({ id: "existing", kind: "memory", title: "T1", content: "same body tokens here" })]);
			const result = engine.apply("global", undefined, createProposal("memory", "T1", "same body tokens here"), { scope: "global", rollbackOf: `evolve_prior_${randomUUID().slice(0, 4)}` });
			expect(result.appliedEdits[0]!.applied).toBe(true);
			expect(result.appliedEdits[0]!.after?.metadata[CONFLICT_HINT_KEY]).toBeUndefined();
		} finally {
			cleanup();
		}
	});
});

describe("secret-leak guard (engine.apply)", () => {
	const SECRET = `token ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`;

	it("blocks a global create carrying a credential before any side effect", () => {
		const { engine, cleanup } = makeEngine();
		try {
			expect(() => engine.apply("global", undefined, createProposal("memory", "push setup", `always ${SECRET} for pushes`))).toThrow(
				/create blocked.*possible GitHub token.*rotate the credential/s,
			);
			expect(engine.history("global", undefined)).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	it("blocks a global update that injects a credential into an existing entry", () => {
		const { dir, engine, cleanup } = makeEngine();
		try {
			seedGlobal(dir, [entry({ id: "e1", kind: "memory", title: "T1", content: "clean body" })]);
			const proposal = {
				summary: "test",
				rationale: "test",
				expectedOutcome: "test",
				edits: [{ action: "update" as const, kind: "memory" as const, id: "e1", content: `updated: ${SECRET}` }],
			};
			expect(() => engine.apply("global", undefined, proposal)).toThrow(/update blocked.*possible GitHub token/s);
		} finally {
			cleanup();
		}
	});

	it("never blocks local scope (scratch space)", () => {
		const { engine, cleanup } = makeEngine();
		try {
			const result = engine.apply("local", "session-x", createProposal("memory", "local note", `draft mentioning ${SECRET}`));
			expect(result.appliedEdits[0]!.applied).toBe(true);
		} finally {
			cleanup();
		}
	});

	it("exempts rollbackOf re-creations (deterministic inverse beats screening)", () => {
		const { engine, cleanup } = makeEngine();
		try {
			const result = engine.apply("global", undefined, createProposal("memory", "T1", `historical ${SECRET}`), {
				scope: "global",
				rollbackOf: `evolve_prior_${randomUUID().slice(0, 4)}`,
			});
			expect(result.appliedEdits[0]!.applied).toBe(true);
		} finally {
			cleanup();
		}
	});
});
