/**
 * Tests for the apply pass and deterministic rollback, including
 * optimistic-concurrency rejection and per-edit failure accounting.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvolutionEngine } from "../src/service.js";

/** Portable fixture body clearing validation floors. */
const PREFIX_BODY =
	"Portable durable content used by prefix-hygiene regression tests; long enough for any minimum length guard.";
import { applyRefinementProposal } from "../src/apply.js";
import { rollbackProposal } from "../src/rollback.js";
import { loadHarnessState, saveHarnessState } from "../src/state.js";
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
	it("persists skill_kind=guidance on skill creates", () => {
		const state = emptyHarnessState();
		const result = applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [
					{ action: "create", kind: "skill", title: "Session handoff process", content: "# Handoff\n\nbody", skill_kind: "guidance" },
				],
			},
			{ id: "refine_skill", scope: "local" },
		);
		const entry = state.entries.skill["session_handoff_process"];
		expect(entry?.skill_kind).toBe("guidance");
		expect(result.appliedEdits[0]?.applied).toBe(true);
	});

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
		const current = structuredClone(baseline);
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

describe("archive action", () => {
	it("stamps archivedAt, bumps version, and keeps all other fields", () => {
		const state = stateWith({ id: "x", title: "old" });
		const before = state.entries.memory["x"]!;
		const result = applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "archive", kind: "memory", id: "x" }],
			},
			{ id: "refine_archive_1" },
		);
		const after = state.entries.memory["x"];
		expect(after?.metadata.archivedAt).toBeDefined();
		expect(after?.version).toBe(before.version + 1);
		expect(after?.title).toBe("old");
		expect(after?.content).toBe("old content");
		expect(after?.created_at).toBe(before.created_at);
		expect(result.appliedEdits[0]?.applied).toBe(true);
		expect(result.appliedEdits[0]?.before?.metadata.archivedAt).toBeUndefined();
	});

	it("fails when the entry does not exist", () => {
		const state = emptyHarnessState();
		const result = applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "archive", kind: "memory", id: "missing" }],
			},
			{ id: "refine_archive_2" },
		);
		expect(result.appliedEdits[0]?.applied).toBe(false);
		expect(result.appliedEdits[0]?.error).toMatch(/entry not found/);
	});

	it("fails on a second archive (no silent no-op)", () => {
		const state = stateWith({ id: "x", title: "old" });
		const archiveOnce = (refinementId: string) =>
			applyRefinementProposal(
				state,
				{
					summary: "s",
					rationale: "r",
					expectedOutcome: "o",
					edits: [{ action: "archive", kind: "memory", id: "x" }],
				},
				{ id: refinementId },
			);
		expect(archiveOnce("refine_archive_3").appliedEdits[0]?.applied).toBe(true);
		const second = archiveOnce("refine_archive_4");
		expect(second.appliedEdits[0]?.applied).toBe(false);
		expect(second.appliedEdits[0]?.error).toMatch(/already archived/);
	});

	it("rolls back by restoring the pre-archive snapshot (stamp cleared)", () => {
		const state = stateWith({ id: "x", title: "old" });
		const applied = applyRefinementProposal(
			state,
			{
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "archive", kind: "memory", id: "x" }],
			},
			{ id: "refine_archive_5" },
		);
		expect(state.entries.memory["x"]?.metadata.archivedAt).toBeDefined();
		const inverse = rollbackProposal(applied);
		expect(inverse.edits[0]?.action).toBe("update");
		applyRefinementProposal(state, inverse, { id: "refine_archive_6" });
		expect(state.entries.memory["x"]?.metadata.archivedAt).toBeUndefined();
		expect(state.entries.memory["x"]?.version).toBe(3);
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

function mkdtempSafe(): string {
	const base = join(process.cwd(), "test/.tmp");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "/"));
}

describe("create id store-prefix hygiene (2026-08-22)", () => {
	function engineOn(dir: string) {
		return createEvolutionEngine(dir);
	}

	it("strips merged-view local:/global: prefixes from CREATE ids only", () => {
		const dir = mkdtempSync(join(tmpdir(), "apply-prefix-"));
		try {
			const engine = engineOn(dir);
			const result = engine.apply("global", undefined, {
				summary: "planner-style create with merged-view id",
				rationale: "regression: global entries named local:foo",
				expectedOutcome: "entry id has no store prefix",
				edits: [{ action: "create", kind: "memory", id: "local:handoff_todo", title: "clean id", content: PREFIX_BODY }],
			}, { scope: "global" });
			expect(result.appliedEdits[0]?.applied).toBe(true);
			expect(result.appliedEdits[0]?.id).toBe("handoff_todo");
			expect(engine.load("global").entries.memory["handoff_todo"]).toBeTruthy();
			expect(engine.load("global").entries.memory["local:handoff_todo"]).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps update/delete ids untouched (they address existing entries)", () => {
		const dir = mkdtempSync(join(tmpdir(), "apply-prefix-update-"));
		try {
			const engine = engineOn(dir);
			engine.apply("global", undefined, {
				summary: "seed",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "create", kind: "memory", id: "weird:id", title: "t", content: PREFIX_BODY }],
			}, { scope: "global" });
			const result = engine.apply("global", undefined, {
				summary: "update keeps raw id",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "update", kind: "memory", id: "weird:id", title: "t2", content: PREFIX_BODY }],
			}, { scope: "global" });
			expect(result.appliedEdits[0]?.applied).toBe(true);
			expect(engine.load("global").entries.memory["weird:id"]?.title).toBe("t2");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("strips merged-view prefixes from UPDATE ids too (review S7)", () => {
		const dir = mkdtempSync(join(tmpdir(), "apply-prefix-update-merged-"));
		try {
			const engine = engineOn(dir);
			engine.apply("global", undefined, {
				summary: "seed",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "create", kind: "memory", id: "note1", title: "t", content: PREFIX_BODY }],
			}, { scope: "global" });
			// The merged view prefixes colliding local ids; a planner update
			// against that view used to address a nonexistent "local:note1".
			const result = engine.apply("global", undefined, {
				summary: "planner-style merged-view update",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "update", kind: "memory", id: "local:note1", title: "updated", content: PREFIX_BODY }],
			}, { scope: "global" });
			expect(result.appliedEdits[0]?.applied).toBe(true);
			expect(engine.load("global").entries.memory["note1"]?.title).toBe("updated");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("skill update/rollback policy (review B3/B4)", () => {
	const EXECUTABLE = {
		kind: "skill" as const,
		title: "Code reviewer",
		content: "Review the diff strictly.",
		reference: { type: "python" as const, import: "reviewer", callable: "run" },
		arguments: { strictness: { type: "string" as const, required: true, description: "how strict" } },
	};

	function makeEngine(dir: string) {
		return createEvolutionEngine(dir);
	}

	it("archives a skill entry through the command's metadata-only update (B3)", () => {
		const dir = mkdtempSync(join(tmpdir(), "apply-skill-archive-"));
		try {
			const engine = makeEngine(dir);
			engine.apply("global", undefined, {
				summary: "seed skill",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "create", kind: "skill", id: "s1", ...EXECUTABLE }],
			}, { scope: "global" });
			// /evolve archive constructs exactly this shape (metadata-only
			// update); it used to fail the full executable contract check.
			const result = engine.apply("global", undefined, {
				summary: "archive skill",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "update", kind: "skill", id: "s1", metadata: { archivedAt: "2026-08-28T00:00:00.000Z" } }],
			}, { scope: "global" });
			expect(result.appliedEdits[0]?.applied).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a real skill_kind switch but accepts the persisted value (B4/B3)", () => {
		const dir = mkdtempSync(join(tmpdir(), "apply-skill-kind-"));
		try {
			const engine = makeEngine(dir);
			engine.apply("global", undefined, {
				summary: "seed skill",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "create", kind: "skill", id: "s1", ...EXECUTABLE }],
			}, { scope: "global" });
			const flip = engine.apply("global", undefined, {
				summary: "flip kind",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "update", kind: "skill", id: "s1", skill_kind: "guidance", content: "Now a document." }],
			}, { scope: "global" });
			expect(flip.appliedEdits[0]?.applied).toBe(false);
			expect(flip.appliedEdits[0]?.error).toContain("cannot change skill_kind");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rolls back a deleted guidance skill with its skill_kind intact (B4)", () => {
		const dir = mkdtempSync(join(tmpdir(), "apply-skill-rollback-"));
		try {
			const engine = makeEngine(dir);
			engine.apply("global", undefined, {
				summary: "seed guidance skill",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "create", kind: "skill", id: "g1", title: "Guide", content: "Read this first.", reference: {}, arguments: {}, skill_kind: "guidance" }],
			}, { scope: "global" });
			const deletion = engine.apply("global", undefined, {
				summary: "delete guidance skill",
				rationale: "r",
				expectedOutcome: "o",
				edits: [{ action: "delete", kind: "skill", id: "g1" }],
			}, { scope: "global" });
			// The inverse is a skill re-create carrying the snapshot; it used
			// to fail the executable contract check, making guidance skills
			// unrecoverable after deletion.
			const restored = engine.rollback("global", undefined, deletion.id);
			expect(restored.appliedEdits[0]?.applied).toBe(true);
			expect(engine.load("global").entries.skill["g1"]?.skill_kind).toBe("guidance");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
