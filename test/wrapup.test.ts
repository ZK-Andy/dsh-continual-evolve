/**
 * Tests for the wrap-up lifecycle (local entries get an exit at session end).
 * Covers the deterministic audit and parse guards; the LLM classification
 * itself stays out of unit tests (verified against the live plugin).
 */
import { describe, expect, it } from "vitest";
import type { HarnessEntry, HarnessState, RefinementKind } from "../src/types.js";
import { PROMOTED_TO_KEY, emptyHarnessState } from "../src/types.js";
import {
	filterPromotable,
	globalCoverageDetected,
	listLocalCandidates,
	parseWrapupAssessment,
	type WrapupCandidate,
} from "../src/wrapup.js";

function entry(id: string, kind: RefinementKind, title: string, overrides: Partial<HarnessEntry> = {}): HarnessEntry {
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

	it("detects coverage by the same entry id", () => {
		const state = globalWith("memory", { "note_x": { title: "A totally different note" } });
		expect(globalCoverageDetected(state, "memory", { id: "note_x", title: "anything" })).toBe(true);
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
