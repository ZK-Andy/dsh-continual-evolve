/**
 * Tests for entry usage tracking (gap B1): load/save persistence, injection
 * recording, count retrieval, and zero-usage detection.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadUsage, saveUsage, usageKey, recordInjection, getUsageCount, zeroUsageEntries } from "../src/usage.js";
import { emptyHarnessState } from "../src/types.js";
import type { HarnessState } from "../src/types.js";

function tmpBase(): string {
	const base = join(process.cwd(), "test/.tmp");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "/"));
}

describe("usageKey", () => {
	it("formats kind:id", () => {
		expect(usageKey("memory", "foo")).toBe("memory:foo");
		expect(usageKey("prompt", "bar_baz")).toBe("prompt:bar_baz");
	});
});

describe("loadUsage", () => {
	it("returns empty store when file is absent", () => {
		const dir = tmpBase();
		try {
			const store = loadUsage(dir);
			expect(store.counts).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns empty store when file is corrupt", () => {
		const dir = tmpBase();
		try {
			mkdirSync(join(dir, "evolve"), { recursive: true });
			require("node:fs").writeFileSync(join(dir, "evolve", "usage.json"), "NOT JSON", "utf8");
			const store = loadUsage(dir);
			expect(store.counts).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads a valid store", () => {
		const dir = tmpBase();
		try {
			saveUsage(dir, { counts: { "memory:foo": 3, "prompt:bar": 1 } });
			const store = loadUsage(dir);
			expect(store.counts["memory:foo"]).toBe(3);
			expect(store.counts["prompt:bar"]).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("saveUsage", () => {
	it("writes atomically and is re-readable", () => {
		const dir = tmpBase();
		try {
			saveUsage(dir, { counts: { "skill:x": 5 } });
			expect(existsSync(join(dir, "evolve", "usage.json"))).toBe(true);
			const loaded = loadUsage(dir);
			expect(loaded.counts["skill:x"]).toBe(5);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("recordInjection", () => {
	it("initializes new keys to 1 and increments existing", () => {
		const dir = tmpBase();
		try {
			recordInjection(dir, ["memory:a", "prompt:b"]);
			expect(loadUsage(dir).counts["memory:a"]).toBe(1);
			expect(loadUsage(dir).counts["prompt:b"]).toBe(1);
			// Second call increments
			recordInjection(dir, ["memory:a"]);
			expect(loadUsage(dir).counts["memory:a"]).toBe(2);
			expect(loadUsage(dir).counts["prompt:b"]).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does nothing when injectedKeys is empty", () => {
		const dir = tmpBase();
		try {
			recordInjection(dir, []);
			expect(existsSync(join(dir, "evolve", "usage.json"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("getUsageCount", () => {
	it("returns 0 for unknown entries", () => {
		const store = { counts: { "memory:known": 3 } };
		expect(getUsageCount(store, "memory", "known")).toBe(3);
		expect(getUsageCount(store, "memory", "unknown")).toBe(0);
		expect(getUsageCount(store, "prompt", "known")).toBe(0);
	});
});

describe("zeroUsageEntries", () => {
	it("finds local entries with zero usage", () => {
		const state: HarnessState = emptyHarnessState();
		state.entries.memory["m1"] = {
			id: "m1", kind: "memory", title: "Memory 1", content: "c", path: "",
			scope: "local", metadata: {}, source: "evolve",
			created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", version: 1,
		};
		state.entries.memory["m2"] = {
			id: "m2", kind: "memory", title: "Memory 2", content: "c", path: "",
			scope: "local", metadata: {}, source: "evolve",
			created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", version: 1,
		};
		state.entries.prompt["p1"] = {
			id: "p1", kind: "prompt", title: "Prompt 1", content: "c", path: "",
			scope: "global", metadata: {}, source: "evolve",
			created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", version: 1,
		};
		const store = { counts: { "memory:m2": 5 } };
		const zeros = zeroUsageEntries(state, store);
		expect(zeros).toHaveLength(1);
		expect(zeros[0]).toEqual({ kind: "memory", id: "m1", title: "Memory 1" });
	});

	it("excludes global entries", () => {
		const state: HarnessState = emptyHarnessState();
		state.entries.memory["g1"] = {
			id: "g1", kind: "memory", title: "Global", content: "c", path: "",
			scope: "global", metadata: {}, source: "evolve",
			created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", version: 1,
		};
		expect(zeroUsageEntries(state, { counts: {} })).toHaveLength(0);
	});
});
