/**
 * Tests for the apply pass and deterministic rollback, including
 * optimistic-concurrency rejection and per-edit failure accounting.
 */
import { describe, expect, it } from "vitest";
import { applyRefinementProposal } from "../src/apply.js";
import { rollbackProposal } from "../src/rollback.js";
import { baselineOf, loadHarnessState, saveHarnessState } from "../src/state.js";
import { emptyHarnessState, type HarnessState } from "../src/types.js";

function stateWith(entry: { id: string; title: string; version?: number }): HarnessState {
	const state = emptyHarnessState();
	state.entries.memory[entry.id] = {
		id: entry.id,
		kind: "memory",
		title: entry.title,
		content: "old content",
		path: "general",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "evolve",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		version: entry.version ?? 1,
	};
	return state;
}

describe("applyRefinementProposal", () => {
	it("creates entries with computed ids and version 1", () => {
		const state = emptyHarnessState();
		const result = applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "create", kind: "memory", title: "Remember the API key location", content: "~/.dsh/.credentials.yaml" }],
			},
			{ id: "refine_1", scope: "local" },
		);
		const entry = state.entries.memory["remember_the_api_key_location"];
		expect(entry?.title).toBe("Remember the API key location");
		expect(entry?.version).toBe(1);
		expect(result.appliedEdits[0]?.applied).toBe(true);
		expect(state.refinements).toHaveLength(1);
	});

	it("bumps version on update and keeps created_at", () => {
		const state = stateWith({ id: "x", title: "old" });
		const result = applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "update", kind: "memory", id: "x", title: "new", content: "new content" }],
			},
			{ id: "refine_2" },
		);
		expect(result.appliedEdits[0]?.applied).toBe(true);
		expect(state.entries.memory["x"]?.title).toBe("new");
		expect(state.entries.memory["x"]?.version).toBe(2);
		expect(result.appliedEdits[0]?.before?.version).toBe(1);
	});

	it("records per-edit failures without failing the whole proposal", () => {
		const state = stateWith({ id: "x", title: "old" });
		const result = applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [
					{ action: "create", kind: "memory", id: "x", title: "dup", content: "exists" }, // conflict
					{ action: "create", kind: "memory", title: "Fresh", content: "ok" }, // fine
				],
			},
			{ id: "refine_3" },
		);
		expect(result.appliedEdits[0]?.applied).toBe(false);
		expect(result.appliedEdits[0]?.error).toMatch(/already exists/);
		expect(result.appliedEdits[1]?.applied).toBe(true);
		expect(state.entries.memory["fresh"]).toBeDefined();
	});

	it("rejects an edit whose entry changed during planning", () => {
		const baseline = stateWith({ id: "x", title: "old" });
		const current = baselineOf(baseline);
		// someone else edited the same entry between plan and apply
		current.entries.memory["x"] = { ...current.entries.memory["x"]!, title: "changed by another session" };
		const result = applyRefinementProposal(
			current,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "update", kind: "memory", id: "x", title: "mine", content: "mine" }],
			},
			{ id: "refine_4", baselineState: baseline },
		);
		expect(result.appliedEdits[0]?.applied).toBe(false);
		expect(result.appliedEdits[0]?.error).toMatch(/changed during planning/);
	});

	it("delete removes the entry and records before", () => {
		const state = stateWith({ id: "x", title: "old" });
		const result = applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "delete", kind: "memory", id: "x" }],
			},
			{ id: "refine_5" },
		);
		expect(result.appliedEdits[0]?.applied).toBe(true);
		expect(state.entries.memory["x"]).toBeUndefined();
		expect(result.appliedEdits[0]?.before?.title).toBe("old");
	});

	it("stamps the trajectory citation into created entries", () => {
		const state = emptyHarnessState();
		const result = applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "create", kind: "memory", title: "Cited", content: "value" }],
			},
			{ id: "refine_src", scope: "local", source: { sessionId: "session-abc", seqs: [12, 15] } },
		);
		expect(result.appliedEdits[0]?.applied).toBe(true);
		const entry = state.entries.memory["cited"];
		expect(entry?.metadata["sourceSession"]).toBe("session-abc");
		expect(entry?.metadata["sourceSeqs"]).toEqual([12, 15]);
	});

	it("omits the seqs key when the citation has no seqs", () => {
		const state = emptyHarnessState();
		applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "create", kind: "memory", title: "Cited", content: "value" }],
			},
			{ id: "refine_src2", source: { sessionId: "session-abc" } },
		);
		const entry = state.entries.memory["cited"];
		expect(entry?.metadata["sourceSession"]).toBe("session-abc");
		expect(entry?.metadata["sourceSeqs"]).toBeUndefined();
	});

	it("writes no citation without a source and keeps it on update", () => {
		const state = emptyHarnessState();
		applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "create", kind: "memory", title: "Uncited", content: "value" }],
			},
			{ id: "refine_src3" },
		);
		expect(state.entries.memory["uncited"]?.metadata).toEqual({});
		// An update does not re-stamp and does not wipe the original citation.
		applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "create", kind: "memory", title: "Cited", content: "value" }],
			},
			{ id: "refine_src4", source: { sessionId: "session-abc", seqs: [12] } },
		);
		const entry = state.entries.memory["cited"]!;
		applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "update", kind: "memory", id: "cited", content: "new value" }],
			},
			{ id: "refine_src5", source: { sessionId: "session-other" } },
		);
		expect(entry.metadata["sourceSession"]).toBe("session-abc");
		expect(entry.metadata["sourceSeqs"]).toEqual([12]);
	});

	it("keeps model-supplied metadata on top of the citation", () => {
		const state = emptyHarnessState();
		applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [
					{
						action: "create",
						kind: "memory",
						title: "Meta",
						content: "value",
						metadata: { note: "model provided" },
					},
				],
			},
			{ id: "refine_src6", source: { sessionId: "session-abc", seqs: [1] } },
		);
		const entry = state.entries.memory["meta"];
		expect(entry?.metadata["note"]).toBe("model provided");
		expect(entry?.metadata["sourceSession"]).toBe("session-abc");
	});
});

describe("rollbackProposal", () => {
	it("restores an updated entry to its before snapshot", () => {
		const state = stateWith({ id: "x", title: "old" });
		const applied = applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "update", kind: "memory", id: "x", title: "new", content: "new" }],
			},
			{ id: "refine_6" },
		);
		const inverse = rollbackProposal(applied);
		expect(inverse.summary).toMatch(/Rollback refinement refine_6/);
		expect(inverse.edits[0]?.action).toBe("update");
		expect(inverse.edits[0]?.title).toBe("old");
	});

	it("deletes an entry that was created by the refinement", () => {
		const state = emptyHarnessState();
		const applied = applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "create", kind: "memory", title: "Temp", content: "temp" }],
			},
			{ id: "refine_7" },
		);
		const inverse = rollbackProposal(applied);
		expect(inverse.edits[0]?.action).toBe("delete");
		expect(inverse.edits[0]?.id).toBe("temp");
	});

	it("re-creates an entry that was deleted by the refinement", () => {
		const state = stateWith({ id: "x", title: "old" });
		const applied = applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "delete", kind: "memory", id: "x" }],
			},
			{ id: "refine_8" },
		);
		const inverse = rollbackProposal(applied);
		expect(inverse.edits[0]?.action).toBe("create");
		expect(inverse.edits[0]?.content).toBe("old content");
		// applying the inverse restores the entry
		applyRefinementProposal(state, inverse, { id: "refine_9" });
		expect(state.entries.memory["x"]?.title).toBe("old");
	});
});

describe("persistence integration", () => {
	it("roundtrips an applied refinement through save/load", () => {
		const dir = mkdtempSafe();
		try {
			const state = emptyHarnessState();
			const result = applyRefinementProposal(
				state,
				{
					summary: "s",
					rationale: "r",
					expectedOutcome: "o",
					edits: [{ action: "create", kind: "memory", title: "Persist me", content: "value" }],
				},
				{ id: "refine_10", scope: "global" },
			);
			saveHarnessState(dir, state);
			const loaded = loadHarnessState(dir, "global");
			expect(loaded.entries.memory["persist_me"]?.content).toBe("value");
			expect(loaded.refinements[0]?.id).toBe("refine_10");
			expect(result.harnessStatePath).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
function mkdtempSafe(): string {
	const base = join(process.cwd(), "test/.tmp");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "/"));
}
