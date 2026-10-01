/**
 * evolve v2 memory-index tests: the passive read path (memory content in the
 * system prompt at session start, budget-bounded, frozen per session) and the
 * when_to_save guide that rides with it.
 *
 * See `.agents/notes/proposed/feature/2026-10-01-evolve-v2-passive-read-write.md`.
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { HarnessEntry, HarnessState, MemoryRecallType } from "../src/types.js";
import { ARCHIVED_AT_KEY, MEMORY_TYPE_KEY, emptyHarnessState } from "../src/types.js";
import { createEvolutionEngine } from "../src/service.js";
import { storePaths } from "../src/store.js";
import { saveHarnessState } from "../src/state.js";
import { loadUsage } from "../src/usage.js";
import { directoryLine, entriesSectionText, type AgentLike } from "../src/inject.js";
import {
	DEFAULT_MEMORY_INDEX_MAX_CHARS,
	DEFAULT_MEMORY_SECTION_ORDER,
	MEMORY_OVERFLOW_HINT,
	MEMORY_SECTION_NAME,
	MEMORY_TYPE_PRIORITY,
	createFrozenMemorySection,
	formatMemoriesBlock,
	memoryFullLine,
	memoryIndexSectionText,
	memoryTypeOf,
	rankMemories,
	renderMemorySelection,
	selectMemoryInjection,
} from "../src/memory-index.js";
import { MEMORY_GUIDE_INTRO, MEMORY_GUIDE_RULES } from "../src/memory-guide.js";

/** Fixture timestamp anchored to run time so the recency cliff cannot rot. */
const FIXTURE_NOW = Date.now();
function isoDaysAgo(days: number): string {
	return new Date(FIXTURE_NOW - days * 24 * 60 * 60 * 1000).toISOString();
}

function entry(overrides: Partial<HarnessEntry> & { id: string; title: string }): HarnessEntry {
	return {
		kind: "memory",
		content: "body",
		path: "general",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "evolve",
		created_at: isoDaysAgo(1),
		updated_at: isoDaysAgo(1),
		version: 1,
		...overrides,
	};
}

function memory(id: string, memoryType: MemoryRecallType | undefined, overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	return entry({
		id,
		title: `title-${id}`,
		metadata: memoryType ? { [MEMORY_TYPE_KEY]: memoryType } : {},
		...overrides,
	});
}

function stateWith(entries: HarnessEntry[]): HarnessState {
	const state = emptyHarnessState();
	for (const e of entries) {
		state.entries[e.kind][e.id] = e;
	}
	return state;
}

function withTempBase<T>(fn: (baseDir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "evolve-memory-index-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function saveGlobal(engine: ReturnType<typeof createEvolutionEngine>, state: HarnessState): void {
	saveHarnessState(storePaths(engine.baseDir, "global", undefined).stateDir, state);
}

const AGENT: AgentLike = { id: "session-1" };

describe("memoryTypeOf", () => {
	it("reads a valid recall type", () => {
		expect(memoryTypeOf(memory("a", "feedback"))).toBe("feedback");
	});

	it("returns undefined for a missing or invalid type", () => {
		expect(memoryTypeOf(memory("a", undefined))).toBeUndefined();
		expect(memoryTypeOf(memory("b", undefined, { metadata: { [MEMORY_TYPE_KEY]: 7 } }))).toBeUndefined();
		expect(memoryTypeOf(memory("c", undefined, { metadata: { [MEMORY_TYPE_KEY]: "nope" } }))).toBeUndefined();
	});
});

describe("rankMemories", () => {
	it("orders by recall-type priority project > feedback > user > reference, untyped last", () => {
		const ranked = rankMemories([
			memory("r", "reference"),
			memory("u", "user"),
			memory("f", "feedback"),
			memory("p", "project"),
			memory("x", undefined),
		], FIXTURE_NOW);
		expect(ranked.map((e) => e.id)).toEqual(["p", "f", "u", "r", "x"]);
	});

	it("breaks type ties by recency (newest first)", () => {
		const ranked = rankMemories(
			[
				memory("old", "user", { updated_at: isoDaysAgo(10) }),
				memory("new", "user", { updated_at: isoDaysAgo(1) }),
			],
			FIXTURE_NOW,
		);
		expect(ranked.map((e) => e.id)).toEqual(["new", "old"]);
	});

	it("is deterministic for full ties and never mutates the input", () => {
		const input = [memory("b", "user"), memory("a", "user")];
		const first = rankMemories(input, FIXTURE_NOW).map((e) => e.id);
		const second = rankMemories(input, FIXTURE_NOW).map((e) => e.id);
		expect(first).toEqual(second);
		expect(input.map((e) => e.id)).toEqual(["b", "a"]);
	});

	it("keeps the declared priority table stable", () => {
		expect(MEMORY_TYPE_PRIORITY).toEqual({ project: 0, feedback: 1, user: 2, reference: 3 });
	});
});

describe("memoryFullLine", () => {
	it("renders the id hook, title, and indented full body", () => {
		const line = memoryFullLine(memory("abc", "feedback", { title: "别 mock 数据库", content: "Why: 上次挂了\nHow to apply: 迁移测试" }));
		expect(line).toBe("- [memory:feedback:abc] 别 mock 数据库\n  Why: 上次挂了\n  How to apply: 迁移测试");
	});

	it("omits the type hook for an untyped memory and handles an empty body", () => {
		expect(memoryFullLine(memory("abc", undefined, { title: "t", content: "   " }))).toBe("- [memory:abc] t");
	});
});

describe("selectMemoryInjection", () => {
	it("keeps everything full when the budget allows", () => {
		const selection = selectMemoryInjection([memory("a", "user"), memory("b", "user")], DEFAULT_MEMORY_INDEX_MAX_CHARS);
		expect(selection.full.map((e) => e.id)).toEqual(["a", "b"]);
		expect(selection.indexed).toEqual([]);
		expect(selection.dropped).toBe(0);
		expect(selection.shown.map((e) => e.id)).toEqual(["a", "b"]);
	});

	it("degrades overflow to index rows once the budget is spent", () => {
		const big = memory("big", "project", { title: "big", content: "x".repeat(200) });
		const small = memory("small", "user", { title: "small", content: "y".repeat(200) });
		// Budget derived from the real rendered widths: the first full body plus
		// the second's index row — nothing more.
		const budget = memoryFullLine(big).length + directoryLine(small).length;
		const selection = selectMemoryInjection([big, small], budget);
		expect(selection.full.map((e) => e.id)).toEqual(["big"]);
		expect(selection.indexed.map((e) => e.id)).toEqual(["small"]);
		expect(selection.dropped).toBe(0);
	});

	it("drops the tail once even an index row no longer fits", () => {
		const entries = Array.from({ length: 4 }, (_, i) => memory(`m${i}`, "project", { title: "t".repeat(30), content: "" }));
		const selection = selectMemoryInjection(entries, 20);
		expect(selection.full).toEqual([]);
		expect(selection.indexed).toEqual([]);
		expect(selection.dropped).toBe(4);
		expect(selection.shown).toEqual([]);
	});

	it("ignores archived memories", () => {
		const archived = memory("arch", "user", { metadata: { [MEMORY_TYPE_KEY]: "user", [ARCHIVED_AT_KEY]: isoDaysAgo(2) } });
		const selection = selectMemoryInjection([archived, memory("live", "user")], DEFAULT_MEMORY_INDEX_MAX_CHARS);
		expect(selection.shown.map((e) => e.id)).toEqual(["live"]);
	});

	it("treats a zero budget as showing nothing", () => {
		const selection = selectMemoryInjection([memory("a", "user")], 0);
		expect(selection.shown).toEqual([]);
		expect(selection.dropped).toBe(1);
	});
});

describe("renderMemorySelection / formatMemoriesBlock", () => {
	it("returns an empty string when nothing is shown", () => {
		expect(renderMemorySelection(selectMemoryInjection([], DEFAULT_MEMORY_INDEX_MAX_CHARS))).toBe("");
		expect(formatMemoriesBlock([])).toBe("");
	});

	it("wraps shown memories and always appends the recall pointer", () => {
		const text = formatMemoriesBlock([memory("a", "user", { title: "t", content: "c" })]);
		expect(text).toBe(`<memories>\n- [memory:user:a] t\n  c\n${MEMORY_OVERFLOW_HINT}\n</memories>`);
	});

	it("reports degraded and dropped counts in the pointer", () => {
		const big = memory("big", "project", { title: "big", content: "x".repeat(200) });
		const small = memory("small", "user", { title: "small", content: "y".repeat(200) });
		const budget = memoryFullLine(big).length + directoryLine(small).length;
		const text = formatMemoriesBlock([big, small], budget);
		expect(text).toContain(MEMORY_OVERFLOW_HINT);
		expect(text).toContain("1 条仅列索引");
	});

	it("counts drops separately from degradations", () => {
		const entries = Array.from({ length: 3 }, (_, i) => memory(`m${i}`, "project", { title: `t${i}` }));
		// One full body + one index row exactly: the third entry gets neither.
		const budget = memoryFullLine(entries[0]!).length + directoryLine(entries[1]!).length;
		const text = formatMemoriesBlock(entries, budget);
		expect(text).toContain("1 条仅列索引");
		expect(text).toContain("1 条未列出");
		// Too small for even one row: nothing renders at all.
		expect(formatMemoriesBlock(entries, 5)).toBe("");
	});
});

describe("memoryIndexSectionText", () => {
	it("injects the guide plus memory content, and records usage", () => {
		withTempBase((baseDir) => {
			const engine = createEvolutionEngine(baseDir);
			saveGlobal(engine, stateWith([memory("a", "feedback", { title: "规则", content: "Why: 原因" })]));
			const text = memoryIndexSectionText(engine, AGENT);
			expect(text).toContain(MEMORY_GUIDE_INTRO);
			expect(text).toContain("<memories>");
			expect(text).toContain("- [memory:feedback:a] 规则");
			expect(text).toContain(MEMORY_GUIDE_RULES);
			expect(loadUsage(baseDir).counts["memory:a"]).toBe(1);
		});
	});

	it("still injects the guide with an empty store (the write path must be taught)", () => {
		withTempBase((baseDir) => {
			const engine = createEvolutionEngine(baseDir);
			const text = memoryIndexSectionText(engine, AGENT);
			expect(text).toContain(MEMORY_GUIDE_INTRO);
			expect(text).toContain("（暂无记忆）");
			expect(text).toContain(MEMORY_GUIDE_RULES);
		});
	});

	it("renders nothing when the guide is off and the store is empty", () => {
		withTempBase((baseDir) => {
			const engine = createEvolutionEngine(baseDir);
			expect(memoryIndexSectionText(engine, AGENT, { guide: false })).toBe("");
		});
	});

	it("renders only the memories block when the guide is off", () => {
		withTempBase((baseDir) => {
			const engine = createEvolutionEngine(baseDir);
			saveGlobal(engine, stateWith([memory("a", "user", { title: "t", content: "c" })]));
			const text = memoryIndexSectionText(engine, AGENT, { guide: false });
			expect(text.startsWith("<memories>")).toBe(true);
			expect(text).not.toContain(MEMORY_GUIDE_INTRO);
		});
	});

	it("honours the character budget", () => {
		withTempBase((baseDir) => {
			const engine = createEvolutionEngine(baseDir);
			saveGlobal(
				engine,
				stateWith(Array.from({ length: 6 }, (_, i) => memory(`m${i}`, "project", { title: `t${i}`, content: "x".repeat(300) }))),
			);
			const text = memoryIndexSectionText(engine, AGENT, { maxChars: 400, guide: false });
			expect(text).toContain("条仅列索引");
			// 6 × 300-char bodies cannot fit in 400 chars: at most one full body.
			expect(text.match(/  x{300}/g)?.length ?? 0).toBeLessThanOrEqual(1);
		});
	});

	it("ignores non-memory kinds", () => {
		withTempBase((baseDir) => {
			const engine = createEvolutionEngine(baseDir);
			saveGlobal(
				engine,
				stateWith([
					entry({ id: "p1", title: "note", kind: "prompt" }),
					entry({ id: "s1", title: "skill", kind: "skill" }),
				]),
			);
			expect(memoryIndexSectionText(engine, AGENT, { guide: false })).toBe("");
		});
	});

	it("returns an empty string for an undefined agent", () => {
		withTempBase((baseDir) => {
			const engine = createEvolutionEngine(baseDir);
			expect(memoryIndexSectionText(engine, undefined)).toBe("");
		});
	});
});

describe("createFrozenMemorySection", () => {
	it("builds once per session and reuses the frozen text", () => {
		const section = createFrozenMemorySection();
		let builds = 0;
		const build = () => {
			builds += 1;
			return `text-${builds}`;
		};
		expect(section.textFor(AGENT, build)).toBe("text-1");
		expect(section.textFor(AGENT, build)).toBe("text-1");
		expect(builds).toBe(1);
		expect(section.size()).toBe(1);
	});

	it("freezes independently per session id", () => {
		const section = createFrozenMemorySection();
		expect(section.textFor({ id: "a" }, () => "A")).toBe("A");
		expect(section.textFor({ id: "b" }, () => "B")).toBe("B");
		expect(section.textFor({ id: "a" }, () => "changed")).toBe("A");
	});

	it("evicts the oldest session past the cap (LRU by insertion order)", () => {
		const section = createFrozenMemorySection(2);
		section.textFor({ id: "a" }, () => "A");
		section.textFor({ id: "b" }, () => "B");
		section.textFor({ id: "c" }, () => "C");
		expect(section.size()).toBe(2);
		expect(section.textFor({ id: "a" }, () => "A2")).toBe("A2");
		expect(section.textFor({ id: "c" }, () => "C2")).toBe("C");
	});

	it("never builds for an undefined agent, and clears on demand", () => {
		const section = createFrozenMemorySection();
		let builds = 0;
		expect(section.textFor(undefined, () => {
			builds += 1;
			return "x";
		})).toBe("");
		expect(builds).toBe(0);
		section.textFor(AGENT, () => "y");
		section.clear();
		expect(section.size()).toBe(0);
	});

	it("keeps a session's section byte-stable across store writes", () => {
		withTempBase((baseDir) => {
			const engine = createEvolutionEngine(baseDir);
			saveGlobal(engine, stateWith([memory("a", "user", { title: "first", content: "one" })]));
			const section = createFrozenMemorySection();
			const build = (agent: AgentLike) => memoryIndexSectionText(engine, agent, { guide: false });
			const first = section.textFor(AGENT, build);
			saveGlobal(engine, stateWith([memory("b", "user", { title: "second", content: "two" })]));
			expect(section.textFor(AGENT, build)).toBe(first);
			// A fresh session (new id) sees the new store.
			expect(section.textFor({ id: "session-2" }, build)).toContain("second");
		});
	});
});

describe("section identity", () => {
	it("exposes the unique section name and the 400 slot", () => {
		expect(MEMORY_SECTION_NAME).toBe("evolve:memory-index");
		expect(DEFAULT_MEMORY_SECTION_ORDER).toBe(400);
		expect(DEFAULT_MEMORY_INDEX_MAX_CHARS).toBe(6000);
	});
});

describe("entry directory de-duplication", () => {
	it("stops listing memory rows when the memory section carries them", () => {
		withTempBase((baseDir) => {
			const engine = createEvolutionEngine(baseDir);
			saveGlobal(engine, stateWith([memory("a", "user", { title: "标题" })]));
			const withMemory = entriesSectionText(engine, AGENT, "", { includeMemoryDirectory: true });
			const withoutMemory = entriesSectionText(engine, AGENT, "", { includeMemoryDirectory: false });
			expect(withMemory).toContain("[memory:user:a]");
			expect(withoutMemory).not.toContain("[memory:user:a]");
		});
	});
});
