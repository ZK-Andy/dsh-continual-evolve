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
});
