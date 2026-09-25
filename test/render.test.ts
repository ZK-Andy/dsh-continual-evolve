/**
 * Tests for prompt rendering (render.ts): skill contracts surface their
 * arguments/reference inline, crowded kinds fold into a counter row, and
 * trajectory citations survive the bound.
 */
import { describe, expect, it } from "vitest";
import type { HarnessEntry, HarnessState } from "../src/types.js";
import { SOURCE_SEQS_KEY, SOURCE_SESSION_KEY, emptyHarnessState } from "../src/types.js";
import { compactText, entryLine, formatHarnessStateForPrompt, historyForPrompt } from "../src/render.js";

function entry(id: string, kind: HarnessEntry["kind"], overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	return {
		id,
		kind,
		title: `Title ${id}`,
		content: "Some durable content for the prompt view.",
		path: "general",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "evolve",
		created_at: "2026-09-25T00:00:00.000Z",
		updated_at: "2026-09-25T00:00:00.000Z",
		version: 1,
		...overrides,
	};
}

describe("entryLine", () => {
	it("inlines a skill arguments contract and python reference", () => {
		const line = entryLine(
			entry("reviewer", "skill", {
				reference: { type: "python", import: "reviewer", callable: "run" },
				arguments: { strictness: { type: "string", required: true, description: "how strict" } },
			}),
			180,
		);
		expect(line).toContain("args=");
		expect(line).toContain("strictness");
		expect(line).toContain("ref=");
		expect(line).toContain("reviewer");
	});

	it("marks archived and guidance skills and cites the trajectory source", () => {
		const line = entryLine(
			entry("flow", "skill", {
				skill_kind: "guidance",
				metadata: { [SOURCE_SESSION_KEY]: "session-x", [SOURCE_SEQS_KEY]: [3, 7], archivedAt: "2026-09-25T00:00:00.000Z" },
			}),
			180,
		);
		expect(line).toContain("[archived]");
		expect(line).toContain("[guidance]");
		expect(line).toContain("src=session-x:3,7");
	});
});

describe("formatHarnessStateForPrompt", () => {
	it("sorts entries and folds crowded kinds into a counter row", () => {
		const state: HarnessState = emptyHarnessState();
		for (let i = 0; i < 8; i += 1) {
			state.entries.memory[`m${i}`] = entry(`m${i}`, "memory", { title: `Title ${String.fromCharCode(104 - i)}` });
		}
		const text = formatHarnessStateForPrompt(state);
		expect(text).toContain("memory: 8");
		expect(text).toContain("+2 more memory entries");
		// Sorted by path/title/id: Title a (m7) precedes Title b (m6); the tail folds.
		expect(text.indexOf("Title a")).toBeLessThan(text.indexOf("Title b"));
	});

	it("names the empty store explicitly", () => {
		expect(formatHarnessStateForPrompt(emptyHarnessState())).toContain("No saved harness entries yet.");
	});

	it("names refinements with no applied edits", () => {
		const state: HarnessState = emptyHarnessState();
		state.refinements.push({ id: "evolve_9", trigger: "auto", changes: [] });
		const text = formatHarnessStateForPrompt(state);
		expect(text).toContain("recent refinements: 1");
		expect(text).toContain("no applied edits");
	});
});

describe("historyForPrompt", () => {
	it("flags rollback lineage on refinement rows", () => {		const text = historyForPrompt([
			{
				id: "evolve_1",
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				appliedEdits: [{ id: "m1", action: "create", kind: "memory", applied: true }],
				harnessStatePath: "/tmp/x",
				rollbackOf: "evolve_0",
			},
		]);
		expect(text).toContain("rollbackOf=evolve_0");
		expect(text).toContain("applied create memory:m1");
	});

	it("names empty rows and rows without rollback lineage", () => {
		const text = historyForPrompt([
			{
				id: "evolve_2",
				summary: "s",
				rationale: "r",
				expectedOutcome: "o",
				appliedEdits: [],
				harnessStatePath: "/tmp/x",
			},
		]);
		expect(text).toContain("[evolve_2] s");
		expect(text).not.toContain("rollbackOf=");
		expect(text).not.toContain("applied ");
		expect(historyForPrompt([])).toBe("No prior refinement history.");
	});
});

describe("compactText", () => {
	it("truncates with an ellipsis marker", () => {
		expect(compactText("a  b   c d e f", 8)).toBe("a b c...");
		expect(compactText("short", 80)).toBe("short");
	});
});
