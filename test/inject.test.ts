/**
 * Injection tests: the dynamic system-prompt section that makes prompt
 * entries visible without a tool call and subagent entries reusable at the
 * delegation seam (design.md §7 Phase 2 remaining items).
 */
import { describe, expect, it } from "vitest";
import { loadUsage } from "../src/usage.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { HarnessEntry, HarnessState } from "../src/types.js";
import { emptyHarnessState } from "../src/types.js";
import { createEvolutionEngine } from "../src/service.js";
import { storePaths } from "../src/store.js";
import { saveHarnessState } from "../src/state.js";
import { entryLine } from "../src/render.js";
import {
	MAX_INJECTED_ENTRIES_PER_KIND,
	entriesSectionText,
	formatEntriesDirectory,
	formatPromptEntriesSection,
	formatSubagentSpecsSection,
	nearestLocalStateWithEntries,
	rankEntries,
	recentUserText,
	recencyScore,
	relevanceHits,
	tokenize,
	formatEntriesDirectoryCapped,
	DEFAULT_DIRECTORY_LINES,
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

	it("shows the trajectory citation when the entry carries one", () => {
		const cited = entry({
			id: "p0",
			kind: "prompt",
			title: "Cited note",
			metadata: { sourceSession: "session-abc", sourceSeqs: [12, 15] },
		});
		expect(formatPromptEntriesSection([cited])).toContain("src=session-abc:12,15");
	});
});

describe("archived entries", () => {
	it("hides archived entries from the injected block", () => {
		const entries = [
			entry({ id: "live", kind: "prompt", title: "Live", content: "x" }),
			entry({
				id: "gone",
				kind: "prompt",
				title: "Gone",
				content: "x",
				metadata: { archivedAt: "2026-08-15T00:00:00.000Z" },
			}),
		];
		const text = formatPromptEntriesSection(entries);
		expect(text).toContain("[local:live]");
		expect(text).not.toContain("[local:gone]");
	});

	it("renders '' when every entry is archived", () => {
		const text = formatPromptEntriesSection([
			entry({ id: "gone", kind: "prompt", title: "Gone", content: "x", metadata: { archivedAt: "2026-08-15T00:00:00.000Z" } }),
		]);
		expect(text).toBe("");
	});

	it("excludes archived entries from the overflow count", () => {
		const entries = Array.from({ length: 7 }, (_, i) =>
			entry({ id: `p${i}`, kind: "prompt", title: `Note ${i}`, content: "x" }),
		);
		entries.push(
			entry({ id: "gone", kind: "prompt", title: "Gone", content: "x", metadata: { archivedAt: "2026-08-15T00:00:00.000Z" } }),
		);
		const text = formatPromptEntriesSection(entries);
		expect(text).toContain("+1 more prompt notes");
		expect(text).not.toContain("[local:gone]");
	});

	it("marks archived entries with [archived] in listings", () => {
		const line = entryLine(
			entry({ id: "gone", kind: "memory", title: "Gone", content: "x", metadata: { archivedAt: "2026-08-15T00:00:00.000Z" } }),
			180,
		);
		expect(line).toContain("[archived]");
		expect(
			entryLine(entry({ id: "live", kind: "memory", title: "Live", content: "x" }), 180),
		).not.toContain("[archived]");
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
			// Filter for curated entries only (format: `- [local:...]`); directory uses `- [kind:...]` without scope.
			expect(text.split("\n").filter((l) => l.includes("[local:")).length).toBe(MAX_INJECTED_ENTRIES_PER_KIND);
		} finally {
			cleanup(engine);
		}
	});

	it("injects the most recently updated entries when the store exceeds the cap", () => {
		const engine = makeEngine() as ReturnType<typeof createEvolutionEngine> & { _dir: string };
		try {
			const many = Array.from({ length: 9 }, (_, i) =>
				entry({
					id: `p${i}`,
					kind: "prompt",
					title: `Note ${i}`,
					content: "x",
					updated_at: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
					created_at: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
				}),
			);
			saveState(engine, "local", "session-main", stateWith(many));
			const text = entriesSectionText(engine, { id: "session-main" });
			// Newest six (p8..p3) fill the cap, not the fixed first six (p0..p5).
			for (const id of ["p8", "p7", "p6", "p5", "p4", "p3"]) {
				expect(text).toContain(`[local:${id}]`);
			}
			expect(text).not.toContain("[local:p0]");
			expect(text).not.toContain("[local:p1]");
			expect(text).not.toContain("[local:p2]");
		} finally {
			cleanup(engine);
		}
	});

	it("ranks injected entries by the agent's recent messages", () => {
		const engine = makeEngine() as ReturnType<typeof createEvolutionEngine> & { _dir: string };
		try {
			const many = Array.from({ length: 9 }, (_, i) =>
				entry({
					id: `p${i}`,
					kind: "prompt",
					title: `Note ${i}`,
					content: i === 0 ? "always run the linter before writing code" : "x",
					updated_at: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
					created_at: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
				}),
			);
			saveState(engine, "local", "session-main", stateWith(many));
			const agent = {
				id: "session-main",
				session: {
					events: [{ type: "user/message", data: { content: "lint before you write code", source: { kind: "user" } } }],
				},
			};
			const text = entriesSectionText(engine, agent);
			// p0 is the oldest entry but matches the recent user message, so it
			// must lead the injected block even though the five newest entries
			// (p8..p4) still fill the rest of the cap; p1 is old and irrelevant
			// and must be dropped.
			// Filter for curated entries only (format: `- [local:...]`); directory uses `- [kind:...]` without scope.
			const lines = text.split("\n").filter((l) => l.includes("[local:"));
			expect(lines[0]).toContain("[local:p0]");
			expect(lines).toHaveLength(MAX_INJECTED_ENTRIES_PER_KIND);
			expect(text).not.toContain("[local:p1]");
		} finally {
			cleanup(engine);
		}
	});

	it("skips archived entries in the injected block", () => {
		const engine = makeEngine() as ReturnType<typeof createEvolutionEngine> & { _dir: string };
		try {
			saveState(
				engine,
				"local",
				"session-main",
				stateWith([
					entry({ id: "live", kind: "prompt", title: "Live", content: "still injectable" }),
					entry({
						id: "gone",
						kind: "prompt",
						title: "Gone",
						content: "hidden",
						metadata: { archivedAt: "2026-08-15T00:00:00.000Z" },
					}),
				]),
			);
			const text = entriesSectionText(engine, { id: "session-main" });
			expect(text).toContain("still injectable");
			expect(text).not.toContain("[local:gone]");
		} finally {
			cleanup(engine);
		}
	});
});

describe("rankEntries", () => {
	const NOW = Date.parse("2026-08-15T00:00:00.000Z");

	function dated(id: string, updatedAt: string, title = `Note ${id}`, content = "body"): HarnessEntry {
		return entry({ id, kind: "prompt", title, content, updated_at: updatedAt, created_at: updatedAt });
	}

	it("ranks by recency (newest first) when there is no query", () => {
		const entries = [
			dated("old", "2026-07-01T00:00:00.000Z"),
			dated("new", "2026-08-14T00:00:00.000Z"),
			dated("mid", "2026-08-01T00:00:00.000Z"),
		];
		expect(rankEntries(entries, undefined, NOW).map((e) => e.id)).toEqual(["new", "mid", "old"]);
	});

	it("ranks relevant entries above newer irrelevant ones when a query is given", () => {
		const entries = [
			dated("old-relevant", "2026-07-01T00:00:00.000Z", "Lint before code", "run oxlint"),
			dated("new-irrelevant", "2026-08-14T00:00:00.000Z", "Baking notes", "oven temperature"),
		];
		const ranked = rankEntries(entries, "lint", NOW);
		expect(ranked[0]!.id).toBe("old-relevant");
		expect(ranked[1]!.id).toBe("new-irrelevant");
	});

	it("breaks recency ties with the stable dictionary order", () => {
		const entries = [
			dated("zeta", "2026-08-01T00:00:00.000Z"),
			dated("alpha", "2026-08-01T00:00:00.000Z"),
		];
		expect(rankEntries(entries, undefined, NOW).map((e) => e.id)).toEqual(["alpha", "zeta"]);
	});

	it("does not mutate the input array", () => {
		const entries = [dated("a", "2026-07-01T00:00:00.000Z"), dated("b", "2026-08-01T00:00:00.000Z")];
		const before = entries.map((e) => e.id);
		rankEntries(entries, undefined, NOW);
		expect(entries.map((e) => e.id)).toEqual(before);
	});
});

describe("tokenize / relevanceHits / recencyScore", () => {
	it("tokenizes lowercase words and keeps CJK runs intact", () => {
		expect(tokenize("Run OXlint 记忆 before code!")).toEqual(["run", "oxlint", "记忆", "before", "code"]);
	});

	it("weighs title hits twice as much as content hits", () => {
		const inTitle = entry({ id: "t", kind: "prompt", title: "Lint first", content: "x" });
		const inBody = entry({ id: "b", kind: "prompt", title: "Notes", content: "lint everything" });
		expect(relevanceHits(inTitle, "lint")).toBe(2);
		expect(relevanceHits(inBody, "lint")).toBe(1);
	});

	it("scores recent entries 1 and decays to 0 after the half life", () => {
		const fresh = entry({ id: "f", kind: "prompt", title: "x", updated_at: "2026-08-15T00:00:00.000Z" });
		const ancient = entry({ id: "a", kind: "prompt", title: "x", updated_at: "2020-01-01T00:00:00.000Z" });
		expect(recencyScore(fresh, Date.parse("2026-08-15T00:00:00.000Z"))).toBe(1);
		expect(recencyScore(ancient, Date.parse("2026-08-15T00:00:00.000Z"))).toBe(0);
	});
});

describe("recentUserText", () => {
	const userEvent = (content: unknown) => ({ type: "user/message", data: { content, source: { kind: "user" } } });

	it("joins the most recent direct user messages", () => {
		const agent = {
			id: "s",
			session: {
				events: [
					userEvent([{ type: "text", text: "first" }]),
					{ type: "assistant/message", data: { message: {} } },
					userEvent("second direct"),
					{ type: "user/message", data: { content: "injected", source: { kind: "plugin", plugin: "x" } } },
				],
			},
		};
		expect(recentUserText(agent)).toBe("first second direct");
	});

	it("returns '' when there are no qualifying messages", () => {
		expect(recentUserText(undefined)).toBe("");
		expect(
			recentUserText({
				id: "s",
				session: { events: [{ type: "user/message", data: { content: "injected", source: { kind: "tool" } } }] },
			}),
		).toBe("");
	});

	it("caps messages and chars", () => {
		const agent = {
			id: "s",
			session: {
				events: [userEvent("one"), userEvent("two"), userEvent("three")],
			},
		};
		expect(recentUserText(agent, { maxMessages: 2 })).toBe("two three");
		expect(recentUserText(agent, { maxChars: 5 })).toBe("one t");
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

// ── Gap B3: entry directory view ──────────────────────────────────────

describe("formatEntriesDirectory (B3)", () => {
	it("returns empty when no entries exist", () => {
		const result = formatEntriesDirectory([], [], [], []);
		expect(result).toBe("");
	});

	it("returns empty when all entries fit in curated sections", () => {
		const entries = Array.from({ length: 3 }, (_, i) =>
			entry({ id: `e${i}`, kind: "memory", title: `Memory ${i}` }),
		);
		const result = formatEntriesDirectory(entries);
		expect(result).toBe("");
	});

	it("shows directory when entries exceed curated cap", () => {
		const memories = Array.from({ length: 8 }, (_, i) =>
			entry({ id: `mem${i}`, kind: "memory", title: `Memory ${i}` }),
		);
		const result = formatEntriesDirectory(memories);
		expect(result).toContain("# Continual Harness — Entry Directory");
		expect(result).toContain("[memory:mem0] Memory 0");
		expect(result).toContain("[memory:mem7] Memory 7");
	});

	it("excludes archived entries", () => {
		const memories = [
			entry({ id: "live", kind: "memory", title: "Live", metadata: {} }),
			entry({ id: "archived", kind: "memory", title: "Gone", metadata: { archivedAt: "2026-08-18T00:00:00.000Z" } }),
			...Array.from({ length: 7 }, (_, i) => entry({ id: `extra${i}`, kind: "memory", title: `Extra ${i}` })),
		];
		const result = formatEntriesDirectory(memories);
		expect(result).toContain("[memory:live] Live");
		expect(result).not.toContain("[memory:archived]");
	});

	it("sorts by kind then id", () => {
		const all = [
			entry({ id: "z", kind: "skill", title: "Z Skill" }),
			entry({ id: "a", kind: "memory", title: "A Mem" }),
			entry({ id: "m", kind: "prompt", title: "M Prompt" }),
			...Array.from({ length: 7 }, (_, i) => entry({ id: `pad${i}`, kind: "memory", title: `Pad ${i}` })),
		];
		const result = formatEntriesDirectory(all);
		const lines = result.split("\n").filter((l) => l.startsWith("- ["));
		expect(lines[0]).toContain("[memory:");
		expect(lines[lines.length - 1]).toContain("[skill:z]");
	});
});

describe("entriesSectionText directory integration (B3)", () => {
	it("includes directory when total entries exceed curated cap", () => {
		const engine = makeEngine() as ReturnType<typeof createEvolutionEngine> & { _dir: string };
		try {
			const state = emptyHarnessState();
			for (let i = 0; i < 8; i++) {
				state.entries.memory[`mem${i}`] = entry({ id: `mem${i}`, kind: "memory", title: `Memory ${i}` });
			}
			saveState(engine, "local", "session-b3", state);
			const agent = { id: "session-b3" };
			const text = entriesSectionText(engine, agent);
			expect(text).toContain("Entry Directory");
			expect(text).toContain("[memory:mem0]");
			expect(text).toContain("[memory:mem7]");
		} finally {
			cleanup(engine);
		}
	});

	it("omits directory when all entries fit in curated sections", () => {
		const engine = makeEngine() as ReturnType<typeof createEvolutionEngine> & { _dir: string };
		try {
			const state = stateWith([entry({ id: "only", kind: "memory", title: "Only" })]);
			saveState(engine, "local", "session-b3-small", state);
			const agent = { id: "session-b3-small" };
			const text = entriesSectionText(engine, agent);
			expect(text).not.toContain("Entry Directory");
		} finally {
			cleanup(engine);
		}
	});
});

describe("entry directory cap (2026-08-22 throttle)", () => {
	it("folds directory lines beyond the cap into a counter", () => {
		const entries = Array.from({ length: 20 }, (_, i) =>
			entry({ id: `mem_${i}`, kind: "memory", title: `Memory ${i}` }),
		);
		const text = formatEntriesDirectoryCapped(5, entries);
		const lines = text.split("\n");
		expect(lines.some((l) => l.startsWith("- [memory:mem_"))).toBe(true);
		expect(lines.filter((l) => l.startsWith("- [")).length).toBe(5);
		expect(text).toContain("and 15 more entries");
	});

	it("keeps the legacy unlimited helper delegating to the default cap", () => {
		const entries = Array.from({ length: 20 }, (_, i) =>
			entry({ id: `mem_${i}`, kind: "memory", title: `Memory ${i}` }),
		);
		expect(formatEntriesDirectory(...[entries])).toBe(formatEntriesDirectoryCapped(DEFAULT_DIRECTORY_LINES, entries));
	});
});

describe("all-kind usage recording with session dedup (2026-08-22)", () => {
	it("counts memory and skill directory impressions once per session", () => {
		const engine = makeEngine();
		try {
			saveState(engine, "global", undefined, stateWith([
				entry({ id: "note", kind: "prompt", title: "Prompt note" }),
				entry({ id: "fact", kind: "memory", title: "Durable fact" }),
				entry({ id: "proc", kind: "skill", title: "Procedure" }),
			]));
			const agent = { id: "session-u1" };
			entriesSectionText(engine, agent);
			entriesSectionText(engine, agent); // same session again
			let store = loadUsage(engine.baseDir);
			expect(store.counts["prompt:note"]).toBe(1);
			expect(store.counts["memory:fact"]).toBe(1);
			expect(store.counts["skill:proc"]).toBe(1);

			entriesSectionText(engine, { id: "session-u2" });
			store = loadUsage(engine.baseDir);
			expect(store.counts["memory:fact"]).toBe(2);
		} finally {
			cleanup(engine as ReturnType<typeof createEvolutionEngine> & { _dir: string });
		}
	});
});
