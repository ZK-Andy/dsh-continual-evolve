/**
 * Engine entry-point tests (service.ts): the single mutation chokepoint's
 * containment paths — unknown kinds, post-commit history/hook failures,
 * best-effort projection/prune swallows, and the warn-tier stamp skip when
 * the warned edit never lands. All deterministic against tmpdir engines.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFLICT_HINT_KEY, emptyHarnessState, type HarnessEntry, type RefinementEdit, type RefinementProposal } from "../src/types.js";
import { createEvolutionEngine, EvolutionApplyPostCommitError } from "../src/service.js";
import { storePaths } from "../src/store.js";
import { loadHarnessState, saveHarnessState } from "../src/state.js";

function makeEngine(dir?: string): { dir: string; engine: ReturnType<typeof createEvolutionEngine>; cleanup: () => void } {
	const base = dir ?? mkdtempSync(join(tmpdir(), "evolve-service-"));
	return { dir: base, engine: createEvolutionEngine(base), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function memoryEntry(id: string, title: string, content: string): HarnessEntry {
	return {
		id,
		kind: "memory",
		title,
		content,
		path: "general",
		scope: "global",
		reference: {},
		arguments: {},
		metadata: { memoryType: "reference" },
		source: "evolve",
		created_at: "2026-09-25T00:00:00.000Z",
		updated_at: "2026-09-25T00:00:00.000Z",
		version: 1,
	};
}

function seedGlobal(dir: string, entries: readonly HarnessEntry[]): void {
	const state = emptyHarnessState();
	for (const item of entries) {
		state.entries[item.kind][item.id] = item;
	}
	saveHarnessState(storePaths(dir, "global", undefined).stateDir, state);
}

function createProposal(edit: RefinementEdit): RefinementProposal {
	return { summary: "test", rationale: "test", expectedOutcome: "test", edits: [edit] };
}

describe("createEvolutionEngine conflict screen edge cases", () => {
	it("skips the similarity corpus for unknown kinds without crashing", () => {
		const { engine, cleanup } = makeEngine();
		try {
			const result = engine.apply(
				"global",
				undefined,
				createProposal({ action: "create", kind: "config" as never, title: "t", content: "c" }),
			);
			expect(result.appliedEdits[0]?.applied).toBe(false);
			expect(result.appliedEdits[0]?.error).toMatch(/unsupported kind/);
		} finally {
			cleanup();
		}
	});

	it("screens missing title/content as empty strings", () => {
		const { engine, cleanup } = makeEngine();
		try {
			const result = engine.apply("global", undefined, createProposal({ action: "create", kind: "memory" }));
			expect(result.appliedEdits[0]?.applied).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("skips the warn-tier stamp when the warned edit never lands", () => {
		const { dir, engine, cleanup } = makeEngine();
		try {
			seedGlobal(dir, [memoryEntry("base", "T1", "w1a w2b w3c w4d")]);
			// 0.60 overlap hits the warn tier, but the edit is invalid per
			// apply-time validation (no recall type), so nothing lands.
			const result = engine.apply(
				"global",
				undefined,
				createProposal({ action: "create", kind: "memory", title: "unrelated-title", content: "w1a w2b w3c w9z" }),
			);
			expect(result.appliedEdits[0]?.applied).toBe(false);
			const reloaded = loadHarnessState(storePaths(dir, "global", undefined).stateDir, "global");
			const stamped = Object.values(reloaded.entries.memory).some((entry) => entry.metadata[CONFLICT_HINT_KEY] !== undefined);
			expect(stamped).toBe(false);
		} finally {
			cleanup();
		}
	});
});

describe("createEvolutionEngine post-commit containment", () => {
	it("carries the persisted result when history append fails", () => {
		const { dir, engine, cleanup } = makeEngine();
		try {
			seedGlobal(dir, [memoryEntry("base", "T1", "entirely different body text here")]);
			// A directory where refinements.jsonl belongs: state saves fine,
			// history append throws EISDIR.
			mkdirSync(storePaths(dir, "global", undefined).resultsPath, { recursive: true });
			let caught: unknown;
			try {
				engine.apply(
					"global",
					undefined,
					createProposal({ action: "create", kind: "memory", title: "fresh entry", content: "another distinct body", metadata: { memoryType: "reference" } }),
				);
			} catch (cause) {
				caught = cause;
			}
			expect(caught).toBeInstanceOf(EvolutionApplyPostCommitError);
			const failure = caught as EvolutionApplyPostCommitError;
			expect(failure.message).toMatch(/failed to append history/);
			expect(failure.scope).toBe("global");
			expect(failure.result.appliedEdits[0]?.applied).toBe(true);
			// State was persisted before the history failure.
			const reloaded = loadHarnessState(storePaths(dir, "global", undefined).stateDir, "global");
			expect(Object.keys(reloaded.entries.memory)).toContain("base");
		} finally {
			cleanup();
		}
	});

	it("ignores a projection failure and still applies", () => {
		const { dir, engine, cleanup } = makeEngine();
		try {
			// A file where the memory-facts directory belongs: projection
			// mkdir throws, the apply still succeeds (JSON is the source).
			const stateDir = storePaths(dir, "global", undefined).stateDir;
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(join(stateDir, "memory"), "blocking file", "utf8");
			const result = engine.apply(
				"global",
				undefined,
				createProposal({ action: "create", kind: "memory", title: "fresh entry", content: "another distinct body", metadata: { memoryType: "reference" } }),
			);
			expect(result.appliedEdits[0]?.applied).toBe(true);
			const reloaded = loadHarnessState(stateDir, "global");
			expect(Object.keys(reloaded.entries.memory)).toHaveLength(1);
		} finally {
			cleanup();
		}
	});

	it("carries the persisted result when a post-commit hook throws", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-service-hook-"));
		try {
			const throwing = createEvolutionEngine(dir, {
				onApplied: () => {
					throw new Error("hook offline");
				},
			});
			let caught: unknown;
			try {
				throwing.apply(
					"global",
					undefined,
					createProposal({ action: "create", kind: "memory", title: "fresh entry", content: "another distinct body", metadata: { memoryType: "reference" } }),
				);
			} catch (cause) {
				caught = cause;
			}
			expect(caught).toBeInstanceOf(EvolutionApplyPostCommitError);
			expect((caught as Error).message).toContain("hook offline");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("renders a string-valued hook failure without throwing", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-service-hook-str-"));
		try {
			const throwing = createEvolutionEngine(dir, {
				onApplied: () => {
					throw "string-hook-failure";
				},
			});
			let caught: unknown;
			try {
				throwing.apply(
					"global",
					undefined,
					createProposal({ action: "create", kind: "memory", title: "fresh entry", content: "another distinct body", metadata: { memoryType: "reference" } }),
				);
			} catch (cause) {
				caught = cause;
			}
			expect(caught).toBeInstanceOf(EvolutionApplyPostCommitError);
			expect((caught as Error).message).toContain("string-hook-failure");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
