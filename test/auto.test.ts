/**
 * Tests for the gate turn counter: completed turns are counted from
 * running → idle transitions only, and the gate's harness view merges the
 * global store so it can recognize topics already covered cross-session.
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { advanceGateState, loadGateHarnessView, type GateState } from "../src/auto.js";
import { createEvolutionEngine } from "../src/service.js";
import { saveHarnessState } from "../src/state.js";
import { storePaths } from "../src/store.js";
import { emptyHarnessState, type HarnessEntry } from "../src/types.js";

function fresh(): GateState {
	return { turns: 0, lastReviewAt: 0, running: false };
}

function fullEntry(id: string, kind: HarnessEntry["kind"], title: string): HarnessEntry {
	return {
		id,
		kind,
		title,
		content: "body",
		path: "general",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "evolve",
		created_at: "2026-08-14T00:00:00.000Z",
		updated_at: "2026-08-14T00:00:00.000Z",
		version: 1,
	};
}

describe("advanceGateState", () => {
	it("counts one turn per running → idle transition", () => {
		const state = fresh();
		expect(advanceGateState(state, "running")).toBe(false);
		expect(advanceGateState(state, "idle")).toBe(true);
		expect(state.turns).toBe(1);
		expect(advanceGateState(state, "running")).toBe(false);
		expect(advanceGateState(state, "idle")).toBe(true);
		expect(state.turns).toBe(2);
	});

	it("ignores duplicate idle emissions without an intervening running", () => {
		const state = fresh();
		advanceGateState(state, "running");
		expect(advanceGateState(state, "idle")).toBe(true);
		expect(advanceGateState(state, "idle")).toBe(false);
		expect(state.turns).toBe(1);
	});

	it("ignores initial idle before any running", () => {
		const state = fresh();
		expect(advanceGateState(state, "idle")).toBe(false);
		expect(state.turns).toBe(0);
	});

	it("ignores unknown statuses", () => {
		const state = fresh();
		expect(advanceGateState(state, "bogus")).toBe(false);
		expect(state.turns).toBe(0);
	});
});

describe("loadGateHarnessView", () => {
	it("merges global entries into the gate's view with their real scope", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-gateview-"));
		try {
			const engine = createEvolutionEngine(dir);
			const global = emptyHarnessState();
			global.entries.memory["readme"] = fullEntry("readme", "memory", "README upkeep");
			global.entries.memory["readme"].scope = "global";
			saveHarnessState(storePaths(dir, "global", undefined).stateDir, global);

			const local = emptyHarnessState();
			local.entries.memory["lint"] = fullEntry("lint", "memory", "Lint first");
			saveHarnessState(storePaths(dir, "local", "session-gate").stateDir, local);

			const view = loadGateHarnessView(engine, "session-gate");
			expect(view.entries.memory["readme"]?.scope).toBe("global");
			expect(view.entries.memory["lint"]?.scope).toBe("local");
			expect(Object.keys(view.entries.memory)).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps both sides visible on id collision (global keeps the id, local is prefixed)", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-gateview-"));
		try {
			const engine = createEvolutionEngine(dir);
			const global = emptyHarnessState();
			const g = fullEntry("shared", "memory", "Global version");
			g.scope = "global";
			global.entries.memory["shared"] = g;
			saveHarnessState(storePaths(dir, "global", undefined).stateDir, global);

			const local = emptyHarnessState();
			local.entries.memory["shared"] = fullEntry("shared", "memory", "Local version");
			saveHarnessState(storePaths(dir, "local", "session-gate").stateDir, local);

			const view = loadGateHarnessView(engine, "session-gate");
			expect(view.entries.memory["shared"]?.title).toBe("Global version");
			expect(view.entries.memory["local:shared"]?.title).toBe("Local version");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
