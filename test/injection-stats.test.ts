import { describe, expect, it } from "vitest";
import { emptyInjectionStats, injectionStats } from "../src/services/injection-stats.js";
import type { MemoryStore } from "../src/store-types.js";

/** A store stand-in: only the two reads the stats module uses. */
function fakeStore(opts: {
	rows?: { ts: string; ids: string[]; estTokens: number }[];
	listThrows?: boolean;
	usage?: Record<string, { useCount: number; lastUsedAt: string | null } | Error>;
}): MemoryStore {
	return {
		listInjections: (workspaceId: string, sinceIso: string) => {
			if (opts.listThrows === true) {
				throw new Error("boom");
			}
			return (opts.rows ?? [])
				.filter((row) => row.ts >= sinceIso)
				.map((row) => ({ workspaceId, sessionId: `s-${row.ts}`, ts: row.ts, ids: row.ids, estTokens: row.estTokens }));
		},
		getMemoryUse: (_workspaceId: string, memoryId: string) => {
			const value = opts.usage?.[memoryId];
			if (value instanceof Error) {
				throw value;
			}
			return value;
		},
	} as unknown as MemoryStore;
}

const NOW = new Date("2026-10-18T12:00:00.000Z");

describe("injectionStats", () => {
	it("reads as empty when nothing was injected", () => {
		expect(injectionStats(fakeStore({ rows: [] }), "/w", 7, NOW)).toEqual(emptyInjectionStats(7));
	});

	it("counts distinct ids and those read after their injection", () => {
		const store = fakeStore({
			rows: [
				{ ts: "2026-10-17T00:00:00.000Z", ids: ["a", "b"], estTokens: 30 },
				{ ts: "2026-10-16T00:00:00.000Z", ids: ["b", "c"], estTokens: 20 },
			],
			usage: {
				a: { useCount: 1, lastUsedAt: "2026-10-17T01:00:00.000Z" },
				b: { useCount: 0, lastUsedAt: null },
				c: { useCount: 2, lastUsedAt: "2026-10-15T00:00:00.000Z" },
			},
		});
		const stats = injectionStats(store, "/w", 7, NOW);
		expect(stats.sessions).toBe(2);
		expect(stats.injected).toBe(3);
		// a was read after its injection; b never read; c's last read predates the injection.
		expect(stats.read).toBe(1);
		expect(stats.readThrough).toBeCloseTo(1 / 3);
		// Deprecated alias, pinned equal until the removal release (P1 ADR).
		expect(stats.rate).toBe(stats.readThrough);
		expect(stats.tokens).toBe(50);
		// The recall numerator N: the latest window injection named 2 ids.
		expect(stats.latestInjected).toBe(2);
	});

	it("reports the latest injection by ts, not row order", () => {
		const store = fakeStore({
			rows: [
				{ ts: "2026-10-10T00:00:00.000Z", ids: ["a", "b", "c"], estTokens: 10 },
				{ ts: "2026-10-17T00:00:00.000Z", ids: ["z"], estTokens: 5 },
			],
		});
		expect(injectionStats(store, "/w", 7, NOW).latestInjected).toBe(1);
	});

	it("reports zero latest ids when nothing was injected", () => {
		const stats = injectionStats(fakeStore({ rows: [] }), "/w", 7, NOW);
		expect(stats.latestInjected).toBe(0);
		expect(stats.readThrough).toBe(0);
		expect(stats.rate).toBe(0);
	});

	it("drops rows outside the window", () => {
		const store = fakeStore({ rows: [{ ts: "2026-09-01T00:00:00.000Z", ids: ["a"], estTokens: 5 }] });
		expect(injectionStats(store, "/w", 7, NOW).sessions).toBe(0);
	});

	it("degrades to empty when the ledger read throws", () => {
		expect(injectionStats(fakeStore({ listThrows: true }), "/w", 7, NOW)).toEqual(emptyInjectionStats(7));
	});

	it("counts a usage read that throws as not read", () => {
		const store = fakeStore({
			rows: [{ ts: "2026-10-17T00:00:00.000Z", ids: ["a"], estTokens: 5 }],
			usage: { a: new Error("usage down") },
		});
		const stats = injectionStats(store, "/w", 7, NOW);
		expect(stats.injected).toBe(1);
		expect(stats.read).toBe(0);
	});
});
