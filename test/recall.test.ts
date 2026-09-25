/**
 * Tests for targeted memory recall: mechanical filters, BM25 relevance
 * ranking (including CJK bigrams), scope honesty notes, limits, archived
 * handling, and the rendered output shape.
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createEvolutionEngine } from "../src/service.js";
import { formatRecallResult, recallMemories } from "../src/recall.js";
import { MEMORY_TYPE_KEY } from "../src/types.js";

function engineHarness() {
	const dir = mkdtempSync(join(tmpdir(), "evolve-recall-"));
	return { dir, engine: createEvolutionEngine(dir) };
}

function userMemory(title: string, content: string) {
	return { action: "create" as const, kind: "memory" as const, title, content, metadata: { [MEMORY_TYPE_KEY]: "user" } };
}

function seed(engine: ReturnType<typeof createEvolutionEngine>) {
	engine.apply("global", undefined, {
		summary: "seed",
		rationale: "test",
		expectedOutcome: "test",
		edits: [userMemory("偏好深色主题", "用户偏好深色主题开发环境")],
	}, { scope: "global" });
	engine.apply("local", "session-recall", {
		summary: "seed",
		rationale: "test",
		expectedOutcome: "test",
		edits: [userMemory("全文检索方案", "全文检索用字符二元模型加 BM25 排序")],
	}, { scope: "local" });
}

describe("recallMemories", () => {
	it("returns no hits and no notes on empty stores", () => {
		const { dir, engine } = engineHarness();
		try {
			const result = recallMemories(engine, { sessionId: "s", projectKey: "p" }, { query: "主题" });
			expect(result.hits).toEqual([]);
			expect(result.notes).toEqual([]);
			expect(result.totalCandidates).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ranks CJK bigram matches above unrelated entries", () => {
		const { dir, engine } = engineHarness();
		try {
			seed(engine);
			const result = recallMemories(engine, { sessionId: "session-recall" }, { query: "检索升级" });
			expect(result.hits.length).toBe(1);
			expect(result.hits[0]?.title).toBe("全文检索方案");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lists most-recently-updated first without a query", () => {
		const { dir, engine } = engineHarness();
		try {
			seed(engine);
			const result = recallMemories(engine, { sessionId: "session-recall" }, {});
			expect(result.hits.length).toBe(2);
			expect(result.totalCandidates).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("filters by scope, kind, and memory type", () => {
		const { dir, engine } = engineHarness();
		try {
			seed(engine);
			engine.apply("global", undefined, {
				summary: "seed",
				rationale: "test",
				expectedOutcome: "test",
				edits: [{ action: "create", kind: "prompt", title: "深色主题提示", content: "深色主题相关提示词" }],
			}, { scope: "global" });
			const scopeOnly = recallMemories(engine, { sessionId: "session-recall" }, { query: "主题", scopes: ["global"] });
			expect(scopeOnly.hits.every((hit) => hit.scope === "global")).toBe(true);
			const kindOnly = recallMemories(engine, { sessionId: "session-recall" }, { query: "主题", kinds: ["prompt"] });
			expect(kindOnly.hits.every((hit) => hit.kind === "prompt")).toBe(true);
			const typeOnly = recallMemories(engine, { sessionId: "session-recall" }, { query: "主题", memoryTypes: ["feedback"] });
			expect(typeOnly.hits).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("boosts exact scope:id matches above fuzzy relevance", () => {
		const { dir, engine } = engineHarness();
		try {
			seed(engine);
			const local = engine.load("local", "session-recall");
			const id = Object.keys(local.entries.memory)[0] ?? "";
			const result = recallMemories(engine, { sessionId: "session-recall" }, { query: `local:${id}` });
			expect(result.hits[0]?.id).toBe(id);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("hides archived entries unless includeArchived is set", () => {
		const { dir, engine } = engineHarness();
		try {
			seed(engine);
			const local = engine.load("local", "session-recall");
			const id = Object.keys(local.entries.memory)[0] ?? "";
			const entry = local.entries.memory[id];
			if (!entry) throw new Error("seed entry missing");
			engine.apply("local", "session-recall", {
				summary: "archive",
				rationale: "test",
				expectedOutcome: "test",
				edits: [{ action: "update", kind: "memory", id, title: entry.title, content: entry.content, metadata: { ...entry.metadata, archivedAt: new Date().toISOString() } }],
			}, { scope: "local" });
			const hidden = recallMemories(engine, { sessionId: "session-recall" }, { query: "检索" });
			expect(hidden.hits).toEqual([]);
			const shown = recallMemories(engine, { sessionId: "session-recall" }, { query: "检索", includeArchived: true });
			expect(shown.hits.length).toBe(1);
			expect(shown.hits[0]?.archived).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("notes skipped scopes instead of silently dropping them", () => {
		const { dir, engine } = engineHarness();
		try {
			seed(engine);
			const result = recallMemories(engine, {}, { query: "主题" });
			expect(result.hits.length).toBe(1);
			expect(result.hits[0]?.scope).toBe("global");
			expect(result.notes.join(" ")).toContain("local");
			expect(result.notes.join(" ")).toContain("project");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("clamps limits and fails loud on unknown filters", () => {
		const { dir, engine } = engineHarness();
		try {
			seed(engine);
			const ctx = { sessionId: "session-recall" };
			expect(recallMemories(engine, ctx, { limit: 1000 }).hits.length).toBeLessThanOrEqual(50);
			expect(recallMemories(engine, ctx, { limit: 0 }).hits.length).toBeLessThanOrEqual(10);
			expect(() => recallMemories(engine, ctx, { kinds: ["nope" as never] })).toThrow("unknown kind");
			expect(() => recallMemories(engine, ctx, { scopes: ["nope" as never] })).toThrow("unknown scope");
			expect(() => recallMemories(engine, ctx, { memoryTypes: ["nope" as never] })).toThrow("unknown memoryType");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("carries version, source, and staleness signals onto hits", () => {
		const { dir, engine } = engineHarness();
		try {
			seed(engine);
			const result = recallMemories(engine, { sessionId: "session-recall" }, { query: "深色" });
			expect(result.hits[0]?.version).toBe(1);
			const text = formatRecallResult(result, "深色");
			expect(text).toContain("v1");
			expect(text).toContain("用户偏好深色主题开发环境");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("breaks relevance ties by recency", () => {
		const { dir, engine } = engineHarness();
		try {
			// Entry ids hash the title, so distinct titles coexist; local
			// scope skips the conflict block, so identical content ties.
			const twin = (title: string) => ({
				summary: "seed", rationale: "test", expectedOutcome: "test",
				edits: [userMemory(title, "共享内容英国短毛猫护理")],
			});
			engine.apply("local", "twin-session", twin("甲条目"), { scope: "local" });
			engine.apply("local", "twin-session", twin("乙条目"), { scope: "local" });
			const result = recallMemories(engine, { sessionId: "twin-session" }, { query: "英国短毛猫", scopes: ["local"] });
			expect(result.hits.length).toBe(2);
			const [first, second] = result.hits;
			expect(first!.updatedAt >= second!.updatedAt).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("orders three entries by recency without a query", () => {
		const { dir, engine } = engineHarness();
		try {
			for (const title of ["甲条目", "乙条目", "丙条目"]) {
				engine.apply("local", "trio-session", {
					summary: "seed", rationale: "test", expectedOutcome: "test",
					edits: [userMemory(title, `${title}内容各不相同`)],
				}, { scope: "local" });
			}
			const result = recallMemories(engine, { sessionId: "trio-session" }, { scopes: ["local"] });
			expect(result.hits.map((h) => h.title)).toEqual(["丙条目", "乙条目", "甲条目"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("carries conflict hints and source provenance onto hits and format", () => {
		const { dir, engine } = engineHarness();
		try {
			const seedEdit = (title: string, content: string, metadata: Record<string, unknown>) => ({
				summary: "seed", rationale: "test", expectedOutcome: "test",
				edits: [{ action: "create" as const, kind: "memory" as const, title, content, metadata }],
			});
			engine.apply("global", undefined, seedEdit("带来源的结论", "内容携带来源与冲突印章", {
				[MEMORY_TYPE_KEY]: "reference", conflictHint: "memory:older:0.65", sourceSession: "session-abc", sourceSeqs: [3, 7],
			}), { scope: "global" });
			engine.apply("global", undefined, seedEdit("空信号条目", "空字符串印章与坏 seq 视为无信号", {
				[MEMORY_TYPE_KEY]: "user", conflictHint: "", sourceSeqs: ["x"],
			}), { scope: "global" });
			const result = recallMemories(engine, {}, { scopes: ["global"] });
			expect(result.hits.length).toBe(2);
			const hinted = result.hits.find((h) => h.title === "带来源的结论")!;
			expect(hinted.staleHint).toBe("memory:older:0.65");
			expect(hinted.sourceSession).toBe("session-abc");
			expect(hinted.sourceSeqs).toEqual([3, 7]);
			const bare = result.hits.find((h) => h.title === "空信号条目")!;
			expect(bare.staleHint).toBeUndefined();
			expect(bare.sourceSession).toBeUndefined();
			expect(bare.sourceSeqs).toBeUndefined();
			const text = formatRecallResult(result);
			expect(text).toContain("conflict-hint=memory:older:0.65");
			expect(text).toContain("src=session-abc:3,7");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("renders empty results, notes, and archived flags", () => {
		const { dir, engine } = engineHarness();
		try {
			const empty = recallMemories(engine, { sessionId: "s", projectKey: "p" }, { query: "不存在" });
			expect(formatRecallResult(empty)).toContain("hidden unless includeArchived");
			expect(formatRecallResult(empty, "  ")).not.toContain("for \"");
			const archived = formatRecallResult({
				hits: [{
					scope: "global", kind: "memory", id: "x", title: "t", content: "c", path: "",
					version: 2, createdAt: "a", updatedAt: "b", archived: true,
				}],
				notes: ["n1"], totalCandidates: 1,
			});
			expect(archived).toContain("· archived");
			expect(archived).toContain("note: n1");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
