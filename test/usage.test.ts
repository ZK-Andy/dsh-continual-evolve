/**
 * Tests for entry usage tracking (gap B1): load/save persistence, injection
 * recording, count retrieval, and zero-usage detection.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadUsage, saveUsage, usageKey, recordInjection, getUsageCount } from "../src/usage.js";

function tmpBase(): string {
	const base = join(process.cwd(), "test/.tmp");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "/"));
}

describe("usage store v2 (session dedup)", () => {
	it("dedups counting per session and keeps legacy always-increment without one", () => {
		const dir = tmpBase();
		try {
			recordInjection(dir, ["memory:a", "memory:b"], "session-1");
			recordInjection(dir, ["memory:a", "memory:b"], "session-1"); // same session: no-op
			recordInjection(dir, ["memory:a"], "session-2");
			let store = loadUsage(dir);
			expect(store.counts["memory:a"]).toBe(2);
			expect(store.counts["memory:b"]).toBe(1);
			expect(store.lastSession?.["memory:a"]).toBe("session-2");

			recordInjection(dir, ["memory:c"]); // no sessionId: legacy increment
			store = loadUsage(dir);
			expect(store.counts["memory:c"]).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists the v2 shape and reads back counts + lastSession", () => {
		const dir = tmpBase();
		try {
			recordInjection(dir, ["skill:s1"], "session-x");
			const raw = JSON.parse(require("node:fs").readFileSync(join(dir, "evolve", "usage.json"), "utf8")) as Record<string, unknown>;
			expect(raw["version"]).toBe(2);
			expect((raw["counts"] as Record<string, number>)["skill:s1"]).toBe(1);
			expect((raw["lastSession"] as Record<string, string>)["skill:s1"]).toBe("session-x");
			expect(loadUsage(dir).counts["skill:s1"]).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads the legacy flat-map shape without a version key", () => {
		const dir = tmpBase();
		try {
			mkdirSync(join(dir, "evolve"), { recursive: true });
			require("node:fs").writeFileSync(join(dir, "evolve", "usage.json"), JSON.stringify({ "prompt:old": 2311 }), "utf8");
			const store = loadUsage(dir);
			expect(store.counts["prompt:old"]).toBe(2311);
			// legacy data keeps counting under session dedup (no lastSession yet)
			recordInjection(dir, ["prompt:old"], "session-new");
			expect(loadUsage(dir).counts["prompt:old"]).toBe(2312);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

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
