/**
 * Tests for the wrap-up lifecycle (local entries get an exit at session end).
 * Covers the deterministic audit and parse guards; the LLM classification
 * itself stays out of unit tests (verified against the live plugin).
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEntry, HarnessState, RefinementKind } from "../src/types.js";
import { PROMOTED_TO_KEY, emptyHarnessState } from "../src/types.js";

function tmpBase(): string {
	const base = join(process.cwd(), "test/.tmp");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "/"));
}
import {
	filterPromotable,
	globalCoverageDetected,
	globalHintsFor,
	listLocalCandidates,
	needsArchiveReview,
	parseWrapupAssessment,
	splitArchiveGuards,
	splitPromoteBlocked,
	type WrapupCandidate,
} from "../src/wrapup.js";

/** Portable fixture body clearing the promotion floor (>=100 chars). */
const PROMOTABLE_BODY =
	"Prefer small evidence-backed edits and verify assumptions against the actual repository state before writing any code change.";

function entry(id: string, kind: RefinementKind, title: string, overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	return {
		id,
		kind,
		title,
		content: PROMOTABLE_BODY,
		path: "general",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "evolve",
		created_at: "2026-08-17T00:00:00.000Z",
		updated_at: "2026-08-17T00:00:00.000Z",
		version: 1,
		...overrides,
	};
}

function candidateOf(entry: HarnessEntry, coveredGlobally = false): WrapupCandidate {
	return {
		kind: entry.kind,
		id: entry.id,
		title: entry.title,
		content: entry.content,
		path: entry.path,
		version: entry.version,
		metadata: entry.metadata,
		coveredGlobally,
		globalHints: [],
	};
}

describe("globalCoverageDetected", () => {
	function globalWith(kind: RefinementKind, records: Record<string, Partial<HarnessEntry>>): HarnessState {
		const state = emptyHarnessState();
		for (const [id, over] of Object.entries(records)) {
			state.entries[kind][id] = entry(id, kind, over.title ?? id, over);
		}
		return state;
	}

	it("does NOT treat a bare same-id collision as coverage (weak signal)", () => {
		const state = globalWith("memory", { "note_x": { title: "A totally different note" } });
		expect(globalCoverageDetected(state, "memory", { id: "note_x", title: "anything" })).toBe(false);
	});

	it("treats same id WITH a near-identical title as coverage", () => {
		const state = globalWith("memory", { "note_x": { title: "用户画像（持续更新）" } });
		expect(globalCoverageDetected(state, "memory", { id: "note_x", title: "用户画像 持续更新" })).toBe(true);
	});

	it("detects coverage by a normalized-equal title", () => {
		const state = globalWith("memory", { "a": { title: "User Prefers: pnpm over yarn" } });
		expect(globalCoverageDetected(state, "memory", { id: "b", title: "user prefers  pnpm over yarn!" })).toBe(true);
	});

	it("detects coverage by a substring title past a length floor", () => {
		const state = globalWith("memory", { "a": { title: "Fedora 44 开发环境细节" } });
		expect(globalCoverageDetected(state, "memory", { id: "b", title: "Fedora 44 开发环境细节补充" })).toBe(true);
	});

	it("equal short titles still count as coverage (no floor on the equality path)", () => {
		const state = globalWith("memory", { "a": { title: "note" } });
		expect(globalCoverageDetected(state, "memory", { id: "c", title: "note" })).toBe(true);
	});

	it("does not match genuinely distinct topics", () => {
		const state = globalWith("memory", { "a": { title: "completely unrelated topic" } });
		expect(globalCoverageDetected(state, "memory", { id: "c", title: "bookkeeping rules" })).toBe(false);
	});

	it("treats an archived global entry as covering the topic", () => {
		const state = globalWith("memory", { "a": { title: "旧观察结论", metadata: { archivedAt: "2026-08-01T00:00:00.000Z" } } });
		expect(globalCoverageDetected(state, "memory", { id: "b", title: "旧观察结论" })).toBe(true);
	});

	it("returns false for an empty global kind", () => {
		expect(globalCoverageDetected(emptyHarnessState(), "memory", { id: "x", title: "whatever" })).toBe(false);
	});
});

describe("listLocalCandidates", () => {
	it("lists active local entries and flags global coverage", () => {
		const local = emptyHarnessState();
		local.entries.memory["m1"] = entry("m1", "memory", "Reusable lesson");
		const global = emptyHarnessState();
		global.entries.memory["m1"] = entry("m1", "memory", "Reusable lesson (global)");
		const candidates = listLocalCandidates(local, global);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.id).toBe("m1");
		expect(candidates[0]?.coveredGlobally).toBe(true);
	});

	it("excludes archived entries from the wrap-up", () => {
		const local = emptyHarnessState();
		local.entries.memory["m1"] = entry("m1", "memory", "done", { metadata: { archivedAt: "2026-08-01T00:00:00.000Z" } });
		local.entries.memory["m2"] = entry("m2", "memory", "active");
		expect(listLocalCandidates(local, emptyHarnessState()).map((c) => c.id)).toEqual(["m2"]);
	});

	it("excludes entries already promoted in an earlier wrap-up", () => {
		const local = emptyHarnessState();
		local.entries.memory["m1"] = entry("m1", "memory", "promoted", { metadata: { [PROMOTED_TO_KEY]: "m1" } });
		local.entries.memory["m2"] = entry("m2", "memory", "fresh");
		const candidates = listLocalCandidates(local, emptyHarnessState());
		expect(candidates.map((c) => c.id)).toEqual(["m2"]);
	});

	it("returns an empty list for an empty local store", () => {
		expect(listLocalCandidates(emptyHarnessState(), emptyHarnessState())).toEqual([]);
	});

	it("includes injectionCount and stale fields in candidates", () => {
		const local = emptyHarnessState();
		local.entries.memory["m1"] = entry("m1", "memory", "Fresh entry");
		local.entries.memory["m2"] = entry("m2", "memory", "Old entry", {
			updated_at: "2020-01-01T00:00:00.000Z",
		});
		// No baseDir → injectionCount defaults to 0, stale depends on recency
		const candidates = listLocalCandidates(local, emptyHarnessState());
		expect(candidates).toHaveLength(2);
		for (const c of candidates) {
			expect(typeof c.injectionCount).toBe("number");
			expect(typeof c.stale).toBe("boolean");
		}
	});

	it("marks old zero-usage entries as stale when baseDir provided", () => {
		const dir = tmpBase();
		try {
			const local = emptyHarnessState();
			// Entry updated 60 days ago (well past the 30-day half-life)
			local.entries.memory["old"] = entry("old", "memory", "Stale entry", {
				updated_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
			});
			// Entry updated just now (fresh)
			local.entries.memory["fresh"] = entry("fresh", "memory", "Fresh entry");
			// No usage recorded → both have injectionCount=0
			const candidates = listLocalCandidates(local, emptyHarnessState(), dir);
			const oldCandidate = candidates.find((c) => c.id === "old");
			const freshCandidate = candidates.find((c) => c.id === "fresh");
			expect(oldCandidate?.stale).toBe(true);
			expect(freshCandidate?.stale).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("parseWrapupAssessment", () => {
	const candidates: WrapupCandidate[] = [
		candidateOf(entry("mem_1", "memory", "需要提升的结论")),
		candidateOf(entry("mem_2", "memory", "会话特有进度")),
		candidateOf(entry("mem_3", "memory", "不确定的条目")),
	];

	it("parses a well-formed assessment", () => {
		const text = JSON.stringify({
			rationale: "one durable, two ephemeral",
			items: [
				{ key: "memory:mem_1", verdict: "promote", reason: "cross-session durable preference" },
				{ key: "memory:mem_2", verdict: "archive", reason: "session-specific progress" },
			],
		});
		const assessment = parseWrapupAssessment(text, candidates);
		const byKey = new Map(assessment.items.map((item) => [item.key, item]));
		expect(byKey.get("memory:mem_1")?.verdict).toBe("promote");
		expect(byKey.get("memory:mem_2")?.verdict).toBe("archive");
		// The unmentioned candidate defaults to keep — a model reply can never
		// silently change an entry's fate.
		expect(byKey.get("memory:mem_3")?.verdict).toBe("keep");
		expect(assessment.rationale).toBe("one durable, two ephemeral");
	});

	it("drops off-list keys and collapses unknown verdicts to keep", () => {
		const text = JSON.stringify({
			items: [
				{ key: "memory:ghost", verdict: "promote", reason: "not a real key" },
				{ key: "memory:mem_1", verdict: "delete", reason: "invalid verdict" },
			],
		});
		const assessment = parseWrapupAssessment(text, candidates);
		expect(assessment.items.some((item) => item.key === "memory:ghost")).toBe(false);
		expect(assessment.items.find((item) => item.key === "memory:mem_1")?.verdict).toBe("keep");
	});

	it("recovers JSON from a fenced block", () => {
		const text = "```json\n{\"items\": [{\"key\": \"memory:mem_2\", \"verdict\": \"archive\", \"reason\": \"x\"}]}\n```";
		const assessment = parseWrapupAssessment(text, candidates);
		expect(assessment.items.find((item) => item.key === "memory:mem_2")?.verdict).toBe("archive");
	});

	it("throws when the reply is not an object", () => {
		expect(() => parseWrapupAssessment("[1,2,3]", candidates)).toThrow();
	});
});

describe("filterPromotable", () => {
	const mem1 = entry("mem_1", "memory", "要提升的");
	const mem2 = entry("mem_2", "memory", "已被 global 覆盖的话题");
	const candidates = [candidateOf(mem1), candidateOf(mem2, /* coveredGlobally */ true)];
	const items = [
		{ key: "memory:mem_1", verdict: "promote" as const, reason: "reusable" },
		{ key: "memory:mem_2", verdict: "promote" as const, reason: "should be blocked" },
		{ key: "memory:mem_1", verdict: "keep" as const, reason: "dup" },
	];

	it("keeps promotable items and blocks covered ones with a reason", () => {
		const split = filterPromotable(items, emptyHarnessState(), candidates);
		expect(split.promotable.map((item) => item.key)).toEqual(["memory:mem_1"]);
		expect(split.skipped).toEqual([{ key: "memory:mem_2", reason: "already covered globally" }]);
	});

	it("blocks candidates absent from the audited list", () => {
		const split = filterPromotable(
			[{ key: "memory:ghost", verdict: "promote", reason: "x" }],
			emptyHarnessState(),
			candidates,
		);
		expect(split.promotable).toEqual([]);
		expect(split.skipped[0]?.reason).toBe("not in the audited candidate list");
	});
});

describe("globalHintsFor", () => {
	function globalWith(kind: RefinementKind, records: Record<string, Partial<HarnessEntry>>): HarnessState {
		const state = emptyHarnessState();
		for (const [id, over] of Object.entries(records)) {
			state.entries[kind][id] = entry(id, kind, over.title ?? id, over);
		}
		return state;
	}

	it("surfaces a bare same-id collision (weak signal) with its real title", () => {
		const state = globalWith("memory", { "memory": { title: "用户画像（持续更新）" } });
		const hints = globalHintsFor(state, "memory", { id: "memory", title: "用户产品愿景与收入需求（本会话）" });
		expect(hints).toEqual([{ id: "memory", title: "用户画像（持续更新）" }]);
	});

	it("surfaces title-similar global entries", () => {
		const state = globalWith("memory", {
			"a": { title: "产品愿景与成功标准" },
			"b": { title: "完全无关的运维笔记" },
		});
		const hints = globalHintsFor(state, "memory", { id: "c", title: "产品愿景 与 成功标准（补充）" });
		expect(hints.map((hint) => hint.id)).toEqual(["a"]);
	});

	it("returns empty when no global entry touches the topic", () => {
		expect(globalHintsFor(emptyHarnessState(), "memory", { id: "x", title: "anything" })).toEqual([]);
	});
});

describe("split promotion (A-form)", () => {
	const candidates: WrapupCandidate[] = [candidateOf(entry("mem_1", "memory", "混合条目：持久愿景 + 会话快照", { metadata: { sourceSeqs: [1, 2], sourceSession: "session-x" } }))];

	it("parses a cleaned promote sub-object on an archive verdict", () => {
		const text = JSON.stringify({
			items: [
				{
					key: "memory:mem_1",
					verdict: "archive",
					reason: "snapshot half",
					promote: { title: "用户产品愿景（持久）", content: "电脑端写作 agent，番茄签约 + 月收入 500。" },
				},
			],
		});
		const assessment = parseWrapupAssessment(text, candidates);
		const item = assessment.items.find((i) => i.key === "memory:mem_1");
		expect(item?.verdict).toBe("archive");
		expect(item?.promote?.title).toBe("用户产品愿景（持久）");
		expect(item?.promote?.content).toContain("月收入 500");
	});

	it("degrades a malformed promote sub-object to a plain archive", () => {
		const text = JSON.stringify({
			items: [
				{ key: "memory:mem_1", verdict: "archive", reason: "x", promote: { title: "", content: "  " } },
				{ key: "memory:mem_1", verdict: "keep", reason: "dup", promote: { title: "no", content: "never accepted on keep" } },
			],
		});
		const assessment = parseWrapupAssessment(text, candidates);
		// Both items reference mem_1; keep wins the parse order but no promote payload survives.
		expect(assessment.items.filter((i) => i.key === "memory:mem_1").every((i) => !i.promote)).toBe(true);
	});

	it("splitPromoteBlocked rejects a cleaned title already covered globally", () => {
		const global = emptyHarnessState();
		global.entries.memory["g1"] = entry("g1", "memory", "用户产品愿景与成功标准");
		const item = { key: "memory:mem_1", verdict: "archive" as const, reason: "x", promote: { title: "用户产品愿景与成功标准 2", content: "body" } };
		expect(splitPromoteBlocked(item, global, "memory")).toBeTruthy();
	});

	it("splitPromoteBlocked allows a fresh cleaned title", () => {
		const item = { key: "memory:mem_1", verdict: "archive" as const, reason: "x", promote: { title: "全新主题", content: PROMOTABLE_BODY + " 全新主题的持久结论，与既有全局条目无重叠。" } };
		expect(splitPromoteBlocked(item, emptyHarnessState(), "memory")).toBeUndefined();
	});
});

describe("archive review guard (symmetric)", () => {
	const withSource = entry("m1", "memory", "有来源的实质条目", { metadata: { sourceSeqs: [10], sourceSession: "session-x" } });
	const withCoverage = entry("m2", "memory", "有来源但已被全局覆盖", { metadata: { sourceSeqs: [11], sourceSession: "session-x" } });
	const noSource = entry("m3", "memory", "无来源操作性条目");
	const splitArchive = entry("m4", "memory", "拆解归档", { metadata: { sourceSeqs: [12], sourceSession: "session-x" } });

	it("requires review only when not covered AND distilled from real messages", () => {
		const candidates = [
			candidateOf(withSource),
			candidateOf(withCoverage, /* coveredGlobally */ true),
			candidateOf(noSource),
		];
		expect(needsArchiveReview({ key: "memory:m1", verdict: "archive", reason: "" }, candidates[0]!)).toBe(true);
		expect(needsArchiveReview({ key: "memory:m2", verdict: "archive", reason: "" }, candidates[1]!)).toBe(false);
		expect(needsArchiveReview({ key: "memory:m3", verdict: "archive", reason: "" }, candidates[2]!)).toBe(false);
	});

	it("partitions silent vs review archives, and keeps split archives silent", () => {
		const candidates = [
			candidateOf(withSource),
			candidateOf(withCoverage, /* coveredGlobally */ true),
			candidateOf(noSource),
			candidateOf(splitArchive),
		];
		const items = [
			{ key: "memory:m1", verdict: "archive" as const, reason: "sourced, uncovered → review" },
			{ key: "memory:m2", verdict: "archive" as const, reason: "covered → silent" },
			{ key: "memory:m3", verdict: "archive" as const, reason: "no source → silent" },
			{ key: "memory:m4", verdict: "archive" as const, reason: "split → silent", promote: { title: "t", content: "c" } },
		];
		const { silent, review } = splitArchiveGuards(items, candidates);
		expect(review.map((i) => i.key)).toEqual(["memory:m1"]);
		expect(silent.map((i) => i.key).sort()).toEqual(["memory:m2", "memory:m3", "memory:m4"]);
	});
});
