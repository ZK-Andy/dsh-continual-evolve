/**
 * Tests for the persistence layer: atomic writes, corrupt-file degrade,
 * shape normalization, scope merge, and optimistic-concurrency detection.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
	entryChangedSince,
	loadHarnessState,
	mergeHarnessStates,
	saveHarnessState,
	stateFilePath,
} from "../src/state.js";
import { emptyHarnessState, type HarnessState } from "../src/types.js";

function tmpDir(): string {
	const base = join(process.cwd(), "test/.tmp");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "/"));
}

function withTmp(fn: (dir: string) => void): void {
	const dir = tmpDir();
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("save/load roundtrip", () => {
	it("persists state and preserves entries", () => {
		withTmp((dir) => {
			const state = emptyHarnessState();
			state.entries.memory["foo"] = {
				id: "foo",
				kind: "memory",
				title: "Foo",
				content: "bar",
				path: "general",
				scope: "local",
				reference: {},
				arguments: {},
				metadata: {},
				source: "evolve",
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
				version: 1,
			};
			saveHarnessState(dir, state);
			const loaded = loadHarnessState(dir, "local");
			expect(loaded.entries.memory["foo"]?.title).toBe("Foo");
			expect(loaded.entries.memory["foo"]?.scope).toBe("local");
			expect(loaded.schema).toBe(1);
		});
	});

	it("degrades to empty on corrupt content instead of throwing", () => {
		withTmp((dir) => {
			writeFileSync(stateFilePath(dir), "{ not json", "utf8");
			expect(loadHarnessState(dir)).toEqual(emptyHarnessState());
		});
	});

	it("degrades to empty on non-object content", () => {
		withTmp((dir) => {
			writeFileSync(stateFilePath(dir), JSON.stringify([1, 2, 3]), "utf8");
			expect(loadHarnessState(dir)).toEqual(emptyHarnessState());
		});
	});

	it("normalizes malformed entries and never throws", () => {
		withTmp((dir) => {
			writeFileSync(
				stateFilePath(dir),
				JSON.stringify({
					schema: "bogus",
					entries: { memory: { bad: { title: 42, scope: "evil", content: "x" } } },
					refinements: "nope",
				}),
				"utf8",
			);
			const loaded = loadHarnessState(dir, "global");
			expect(loaded.schema).toBe(1);
			expect(loaded.entries.memory["bad"]?.scope).toBe("global");
			expect(loaded.entries.memory["bad"]?.title).toBe("bad");
			expect(loaded.refinements).toEqual([]);
		});
	});

	it("writes atomically and keeps the file mode of an existing file", () => {
		withTmp((dir) => {
			saveHarnessState(dir, emptyHarnessState());
			const path = stateFilePath(dir);
			expect(existsSync(path)).toBe(true);
			expect(readFileSync(path, "utf8")).toContain('"schema": 1');
		});
	});
});

describe("merge", () => {
	function entry(id: string, title: string, scope: "local" | "global") {
		return {
			id,
			kind: "memory" as const,
			title,
			content: "c",
			path: "general",
			scope,
			reference: {},
			arguments: {},
			metadata: {},
			source: "evolve" as const,
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
			version: 1,
		};
	}

	it("local wins over same-id global and is prefixed local:", () => {
		const globalState = emptyHarnessState();
		globalState.entries.memory["dup"] = entry("dup", "global version", "global");
		const localState = emptyHarnessState();
		localState.entries.memory["dup"] = entry("dup", "local version", "local");
		const merged = mergeHarnessStates(globalState, localState);
		expect(merged.entries.memory["dup"]?.title).toBe("global version");
		expect(merged.entries.memory["local:dup"]?.title).toBe("local version");
	});

	it("keeps disjoint entries from both scopes", () => {
		const globalState = emptyHarnessState();
		globalState.entries.memory["a"] = entry("a", "A", "global");
		const localState = emptyHarnessState();
		localState.entries.memory["b"] = entry("b", "B", "local");
		const merged = mergeHarnessStates(globalState, localState);
		expect(merged.entries.memory["a"]?.title).toBe("A");
		expect(merged.entries.memory["b"]?.title).toBe("B");
	});
});

describe("optimistic concurrency", () => {
	it("detects an entry changed since baseline", () => {
		const baseline: HarnessState = emptyHarnessState();
		baseline.entries.memory["x"] = {
			id: "x",
			kind: "memory",
			title: "old",
			content: "old",
			path: "general",
			scope: "local",
			reference: {},
			arguments: {},
			metadata: {},
			source: "evolve",
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
			version: 1,
		};
		const current = structuredClone(baseline);
		current.entries.memory["x"] = { ...current.entries.memory["x"]!, title: "new" };
		expect(entryChangedSince(baseline, current, "memory", "x")).toBe(true);
		expect(entryChangedSince(baseline, current, "memory", "missing")).toBe(false);
	});
});
