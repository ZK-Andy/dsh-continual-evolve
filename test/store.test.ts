/**
 * Tests for storage hygiene (#20): count-based retention of snapshots and
 * JSONL histories, resolved with generous defaults and enforced at write
 * time (best-effort — pruning never fails the write path).
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createEvolutionEngine } from "../src/service.js";
import {
	DEFAULT_REFINEMENTS_RETAIN,
	DEFAULT_REVIEWS_RETAIN,
	DEFAULT_SNAPSHOT_RETAIN,
	DEFAULT_TOKEN_USAGE_RETAIN,
	loadResults,
	pruneJsonlFile,
	pruneSnapshots,
	resolveHistoryRetention,
	storePaths,
} from "../src/store.js";
import { buildEvolveCompleteEvent, emitEvolveComplete } from "../src/evolve-event.js";

describe("resolveHistoryRetention", () => {
	it("falls back to generous defaults when unconfigured", () => {
		expect(resolveHistoryRetention(undefined)).toEqual({
			snapshots: DEFAULT_SNAPSHOT_RETAIN,
			refinements: DEFAULT_REFINEMENTS_RETAIN,
			reviews: DEFAULT_REVIEWS_RETAIN,
			tokenUsage: DEFAULT_TOKEN_USAGE_RETAIN,
		});
		expect(DEFAULT_SNAPSHOT_RETAIN).toBeGreaterThan(0);
		expect(DEFAULT_REFINEMENTS_RETAIN).toBeGreaterThanOrEqual(500);
		expect(DEFAULT_REVIEWS_RETAIN).toBeGreaterThanOrEqual(500);
		expect(DEFAULT_TOKEN_USAGE_RETAIN).toBeGreaterThanOrEqual(500);
	});

	it("clamps absent and non-positive fields instead of failing loudly", () => {
		expect(resolveHistoryRetention({ snapshots: 3 })).toEqual({
			snapshots: 3,
			refinements: DEFAULT_REFINEMENTS_RETAIN,
			reviews: DEFAULT_REVIEWS_RETAIN,
			tokenUsage: DEFAULT_TOKEN_USAGE_RETAIN,
		});
		expect(resolveHistoryRetention({ snapshots: 0, refinements: -5, reviews: Number.NaN, tokenUsage: -1 })).toEqual({
			snapshots: DEFAULT_SNAPSHOT_RETAIN,
			refinements: DEFAULT_REFINEMENTS_RETAIN,
			reviews: DEFAULT_REVIEWS_RETAIN,
			tokenUsage: DEFAULT_TOKEN_USAGE_RETAIN,
		});
	});
});

describe("pruneJsonlFile", () => {
	it("keeps the tail and is a no-op within budget", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-prune-jsonl-"));
		try {
			const path = join(dir, "history.jsonl");
			expect(() => pruneJsonlFile(join(dir, "missing.jsonl"), 3)).not.toThrow();
			writeFileSync(path, "a\nb\n", "utf8");
			pruneJsonlFile(path, 5);
			expect(readFileSync(path, "utf8")).toBe("a\nb\n");
			writeFileSync(path, "1\n2\n3\n4\n5\n", "utf8");
			pruneJsonlFile(path, 3);
			expect(readFileSync(path, "utf8")).toBe("3\n4\n5\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("pruneSnapshots", () => {
	it("keeps the newest N snapshots and ignores a missing directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-prune-snap-"));
		try {
			expect(() => pruneSnapshots(join(dir, "nope"), 2)).not.toThrow();
			const snaps = join(dir, "snapshots");
			mkdirSync(snaps, { recursive: true });
			for (const name of ["a.json", "b.json", "c.json", "d.json"]) {
				writeFileSync(join(snaps, name), "{}", "utf8");
				// Ensure distinct mtimes so "newest N" is deterministic.
				const t = new Date(Date.now() + name.charCodeAt(0));
				utimesSync(join(snaps, name), t, t);
			}
			writeFileSync(join(snaps, "notes.txt"), "not a snapshot", "utf8");
			pruneSnapshots(snaps, 2);
			const remaining = readdirSync(snaps).sort();
			expect(remaining).toEqual(["c.json", "d.json", "notes.txt"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("engine write-time retention (#20)", () => {
	it("bounds snapshots and the per-store history across many applies", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-retain-engine-"));
		try {
			const engine = createEvolutionEngine(dir, {}, { historyRetain: { snapshots: 3, refinements: 4 } });
			for (let i = 0; i < 7; i += 1) {
				const result = engine.apply("local", "sess", {
					summary: `seed ${i}`,
					rationale: "r",
					expectedOutcome: "o",
					edits: [{ action: "create", kind: "prompt", id: `p${i}`, title: `t${i}`, content: "durable prompt body for retention testing" }],
				});
				expect(result.appliedEdits[0]?.applied).toBe(true);
			}
			const paths = storePaths(dir, "local", "sess");
			const snapshots = existsSync(paths.snapshotsDir) ? readdirSync(paths.snapshotsDir).filter((f) => f.endsWith(".json")) : [];
			expect(snapshots.length).toBeLessThanOrEqual(3);
			const lines = readFileSync(paths.resultsPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
			expect(lines).toHaveLength(4);
			// The tail survives: newest refinements remain rollbackable.
			expect(engine.history("local", "sess")).toHaveLength(4);
			expect(engine.load("local", "sess").entries.prompt["p6"]).toBeTruthy();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("uses defaults when no retention is configured (still bounded)", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-retain-default-"));
		try {
			const engine = createEvolutionEngine(dir);
			expect(engine.retention.snapshots).toBe(DEFAULT_SNAPSHOT_RETAIN);
			expect(engine.retention.refinements).toBe(DEFAULT_REFINEMENTS_RETAIN);
			expect(engine.retention.reviews).toBe(DEFAULT_REVIEWS_RETAIN);
			expect(engine.retention.tokenUsage).toBe(DEFAULT_TOKEN_USAGE_RETAIN);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("reviews trail retention (#20)", () => {
	it("truncates the shared audit trail to its tail on emission", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-retain-reviews-"));
		try {
			for (let i = 0; i < 7; i += 1) {
				emitEvolveComplete(
					dir,
					{
						type: "evolve_complete",
						refinementId: `r${i}`,
						summary: `s${i}`,
						appliedEdits: 1,
						failedEdits: 0,
						scope: "local",
						trigger: "manual_tool",
						sessionId: "sess",
						timestamp: new Date().toISOString(),
						edits: [],
					},
					3,
				);
			}
			const lines = readFileSync(join(dir, "evolve", "reviews.jsonl"), "utf8").split("\n").filter((l) => l.trim().length > 0);
			expect(lines).toHaveLength(3);
			expect(lines[2]).toContain("r6");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("buildEvolveCompleteEvent still round-trips through the pruned trail", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-retain-roundtrip-"));
		try {
			const engine = createEvolutionEngine(dir, {}, { historyRetain: { reviews: 5 } });
			const result = engine.apply("local", "sess", {
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "create", kind: "prompt", title: "t", content: "durable prompt body" }],
			});
			emitEvolveComplete(dir, buildEvolveCompleteEvent(result, "manual_tool", "sess"), engine.retention.reviews);
			const lines = readFileSync(join(dir, "evolve", "reviews.jsonl"), "utf8").split("\n").filter((l) => l.trim().length > 0);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain(result.id);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("store unreadable-path containment (round 8)", () => {
	it("leaves an unreadable snapshots dir alone (file in its place)", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-store-"));
		try {
			const fake = join(dir, "snapshots");
			writeFileSync(fake, "x", "utf8");
			expect(() => pruneSnapshots(fake, 20)).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps unstatable files rather than deleting blindly (dangling symlink)", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-store-"));
		try {
			const snapshots = join(dir, "snapshots");
			mkdirSync(snapshots, { recursive: true });
			writeFileSync(join(snapshots, "a.json"), "{}", "utf8");
			symlinkSync(join(snapshots, "no-such-target.json"), join(snapshots, "ghost.json"));
			expect(() => pruneSnapshots(snapshots, 1)).not.toThrow();
			expect(lstatSync(join(snapshots, "ghost.json")).isSymbolicLink()).toBe(true);
			expect(existsSync(join(snapshots, "a.json"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("continues the sweep past an undeletable victim (directory)", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-store-"));
		try {
			const snapshots = join(dir, "snapshots");
			mkdirSync(join(snapshots, "b.json"), { recursive: true });
			writeFileSync(join(snapshots, "a.json"), "{}", "utf8");
			writeFileSync(join(snapshots, "c.json"), "{}", "utf8");
			utimesSync(join(snapshots, "b.json"), new Date("2020-01-01"), new Date("2020-01-01"));
			utimesSync(join(snapshots, "a.json"), new Date("2021-01-01"), new Date("2021-01-01"));
			utimesSync(join(snapshots, "c.json"), new Date("2022-01-01"), new Date("2022-01-01"));
			expect(() => pruneSnapshots(snapshots, 1)).not.toThrow();
			// The directory victim survives (unlink rejects directories) but
			// the sweep continues past it: the older real file is gone.
			expect(existsSync(join(snapshots, "b.json"))).toBe(true);
			expect(existsSync(join(snapshots, "a.json"))).toBe(false);
			expect(existsSync(join(snapshots, "c.json"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves an unreadable JSONL file alone (directory in its place)", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-store-"));
		try {
			const resultsPath = storePaths(dir, "local", "s").resultsPath;
			mkdirSync(resultsPath, { recursive: true });
			expect(() => pruneJsonlFile(resultsPath, 5)).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips malformed and non-result lines when reading history", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-store-"));
		try {
			const paths = storePaths(dir, "local", "s");
			mkdirSync(paths.stateDir, { recursive: true });
			writeFileSync(paths.resultsPath, ['{"id":"r1","appliedEdits":[]}', "garbage{{{", '{"nope":1}', "", "   "].join("\n"), "utf8");
			expect(loadResults(paths)).toEqual([{ id: "r1", appliedEdits: [] }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves project/local path variants without traversal", () => {
		expect(storePaths("/b", "project").stateDir).toBe(join("/b", "evolve", "projects", "project"));
		expect(storePaths("/b", "project", "my-proj").stateDir).toBe(join("/b", "evolve", "projects", "my-proj"));
		expect(storePaths("/b", "project", "../../evil").stateDir.split("/")).not.toContain("..");
		expect(storePaths("/b", "local").stateDir).toBe(join("/b", "evolve", "local", "anonymous"));
		expect(storePaths("/b", "local", "s1").stateDir).toBe(join("/b", "evolve", "local", "s1"));
	});
});
