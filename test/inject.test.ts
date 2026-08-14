/**
 * Injection tests: the dynamic system-prompt section that makes prompt
 * entries visible without a tool call and subagent entries reusable at the
 * delegation seam (design.md §7 Phase 2 remaining items).
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { HarnessEntry, HarnessState } from "../src/types.js";
import { emptyHarnessState } from "../src/types.js";
import { createEvolutionEngine } from "../src/service.js";
import { storePaths } from "../src/store.js";
import { saveHarnessState } from "../src/state.js";
import {
	MAX_INJECTED_ENTRIES_PER_KIND,
	entriesSectionText,
	formatPromptEntriesSection,
	formatSubagentSpecsSection,
	nearestLocalStateWithEntries,
} from "../src/inject.js";

function entry(overrides: Partial<HarnessEntry> & { id: string; kind: HarnessEntry["kind"]; title: string }): HarnessEntry {
	return {
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
		...overrides,
	};
}

function stateWith(entries: HarnessEntry[]): HarnessState {
	const state = emptyHarnessState();
	for (const e of entries) {
		state.entries[e.kind][e.id] = e;
	}
	return state;
}

function saveState(engine: ReturnType<typeof createEvolutionEngine>, scope: "global" | "local", sessionId: string | undefined, state: HarnessState): void {
	saveHarnessState(storePaths(engine.baseDir, scope, sessionId).stateDir, state);
}

function makeEngine(): ReturnType<typeof createEvolutionEngine> {
	const dir = mkdtempSync(join(tmpdir(), "evolve-inject-"));
	const engine = createEvolutionEngine(dir);
	return { ...engine, _dir: dir };
}

function cleanup(engine: ReturnType<typeof createEvolutionEngine> & { _dir: string }): void {
	rmSync(engine._dir, { recursive: true, force: true });
}

describe("formatPromptEntriesSection", () => {
	it("renders the additive block with bounded entries", () => {
		const entries = Array.from({ length: 8 }, (_, i) =>
			entry({ id: `p${i}`, kind: "prompt", title: `Note ${i}`, content: `content ${i}` }),
		);
		const text = formatPromptEntriesSection(entries);
		expect(text).toContain("# Continual Harness — Prompt Notes");
		expect(text).toContain("base system prompt is immutable");
		expect(text).toContain("- [local:p0] Note 0");
		expect(text).toContain("+2 more prompt notes");
		const rendered = text.split("\n").filter((l) => l.startsWith("- ["));
		expect(rendered).toHaveLength(MAX_INJECTED_ENTRIES_PER_KIND);
	});

	it("renders nothing for an empty list", () => {
		expect(formatPromptEntriesSection([])).toBe("");
	});
});

describe("formatSubagentSpecsSection", () => {
	it("renders delegation specs with the reuse instruction", () => {
		const specs = [entry({ id: "reviewer", kind: "subagent", title: "Code reviewer", content: "check hygiene" })];
		const text = formatSubagentSpecsSection(specs);
		expect(text).toContain("# Continual Harness — Delegation Specs");
		expect(text).toContain("assemble the child prompt from its content");
		expect(text).toContain("- [local:reviewer] Code reviewer");
		expect(text).toContain("check hygiene");
	});

	it("renders nothing for an empty list", () => {
		expect(formatSubagentSpecsSection([])).toBe("");
	});
});

describe("entriesSectionText", () => {
	it("returns '' with no agent (diagnostics assemblies)", () => {
		const engine = makeEngine() as ReturnType<typeof createEvolutionEngine> & { _dir: string };
		try {
			expect(entriesSectionText(engine, undefined)).toBe("");
		} finally {
			cleanup(engine);
		}
	});

	it("injects prompt entries from the session's own local store", () => {
		const engine = makeEngine() as ReturnType<typeof createEvolutionEngine> & { _dir: string };
		try {
			saveState(
				engine,
				"local",
				"session-main",
				stateWith([entry({ id: "lint", kind: "prompt", title: "Lint first", content: "run lint before code" })]),
			);
			const text = entriesSectionText(engine, { id: "session-main" });
			expect(text).toContain("Lint first");
			expect(text).toContain("run lint before code");
			expect(text).not.toContain("Delegation Specs");
		} finally {
			cleanup(engine);
		}
	});

	it("injects delegation specs for the delegating session", () => {
		const engine = makeEngine() as ReturnType<typeof createEvolutionEngine> & { _dir: string };
		try {
			saveState(
				engine,
				"local",
				"session-main",
				stateWith([entry({ id: "reviewer", kind: "subagent", title: "Reviewer", content: "strict rubric" })]),
			);
			const text = entriesSectionText(engine, { id: "session-main" });
			expect(text).toContain("Delegation Specs");
			expect(text).toContain("Reviewer");
		} finally {
			cleanup(engine);
		}
	});

	it("inherits the parent session's entries through the parentSession chain", () => {
		const engine = makeEngine() as ReturnType<typeof createEvolutionEngine> & { _dir: string };
		try {
			saveState(
				engine,
				"local",
				"session-main",
				stateWith([
					entry({ id: "lint", kind: "prompt", title: "Lint first", content: "lint before code" }),
					entry({ id: "reviewer", kind: "subagent", title: "Reviewer", content: "strict rubric" }),
				]),
			);
			const child = { id: "session-child", session: { header: { parentSession: "session-main" } } };
			const text = entriesSectionText(engine, child);
			expect(text).toContain("Lint first");
			expect(text).toContain("Reviewer");
		} finally {
			cleanup(engine);
		}
	});

	it("returns '' when no store along the chain has entries", () => {
		const engine = makeEngine() as ReturnType<typeof createEvolutionEngine> & { _dir: string };
		try {
			const text = entriesSectionText(engine, { id: "session-main" });
			expect(text).toBe("");
		} finally {
			cleanup(engine);
		}
	});

	it("merges global entries and keeps a colliding local entry addressable as local:", () => {
		const engine = makeEngine() as ReturnType<typeof createEvolutionEngine> & { _dir: string };
		try {
			saveState(
				engine,
				"global",
				undefined,
				stateWith([
					entry({ id: "shared", kind: "prompt", scope: "global", title: "Global version", content: "global body" }),
					entry({ id: "global-only", kind: "prompt", scope: "global", title: "Global only", content: "g" }),
				]),
			);
			saveState(
				engine,
				"local",
				"session-main",
				stateWith([entry({ id: "shared", kind: "prompt", title: "Local version", content: "local body" })]),
			);
			const text = entriesSectionText(engine, { id: "session-main" });
			expect(text).toContain("- [local:shared] Local version");
			expect(text).toContain("- [global:shared] Global version");
			expect(text).toContain("Global only");
		} finally {
			cleanup(engine);
		}
	});

	it("caps each kind at 6 entries in the injected block", () => {
		const engine = makeEngine() as ReturnType<typeof createEvolutionEngine> & { _dir: string };
		try {
			const many = Array.from({ length: 9 }, (_, i) =>
				entry({ id: `p${i}`, kind: "prompt", title: `Note ${i}`, content: "x" }),
			);
			saveState(engine, "local", "session-main", stateWith(many));
			const text = entriesSectionText(engine, { id: "session-main" });
			expect(text).toContain("+3 more prompt notes");
			expect(text.split("\n").filter((l) => l.startsWith("- [")).length).toBe(MAX_INJECTED_ENTRIES_PER_KIND);
		} finally {
			cleanup(engine);
		}
	});
});

describe("nearestLocalStateWithEntries", () => {
	it("stops at the first non-empty store up the chain", () => {
		const engine = makeEngine() as ReturnType<typeof createEvolutionEngine> & { _dir: string };
		try {
			saveState(
				engine,
				"local",
				"session-grandparent",
				stateWith([entry({ id: "gp", kind: "prompt", title: "Grandparent", content: "g" })]),
			);
			const grandchild = {
				id: "session-grandchild",
				session: { header: { parentSession: "session-parent" } },
			};
			const parent = { id: "session-parent", session: { header: { parentSession: "session-grandparent" } } };
			// The walk starts at the given agent; simulate the chain by calling
			// with the child whose parent store exists.
			expect(nearestLocalStateWithEntries(engine, parent)?.entries.prompt["gp"]?.title).toBe("Grandparent");
			expect(nearestLocalStateWithEntries(engine, grandchild)).toBeUndefined();
		} finally {
			cleanup(engine);
		}
	});
});
