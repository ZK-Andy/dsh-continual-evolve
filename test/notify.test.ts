/**
 * Tests for the memory-extraction receipt: the receipt text is built from
 * the applied refinement batches (never model text), and the follow-up queue
 * is error-contained so a broken notification never breaks the extraction
 * path.
 */
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { buildMemoryReceipt, notifyMemoryExtraction } from "../src/notify.js";
import type { RefinementResult } from "../src/types.js";

function result(overrides: Partial<RefinementResult> = {}): RefinementResult {
	return {
		id: "evolve_test123",
		summary: "summary",
		rationale: "rationale",
		expectedOutcome: "outcome",
		appliedEdits: [],
		harnessStatePath: "/tmp/state.json",
		...overrides,
	};
}

describe("buildMemoryReceipt", () => {
	it("renders applied batches with edits, stats, and rollback commands", () => {
		const text = buildMemoryReceipt({
			outcome: "applied",
			results: [
				result({
					id: "evolve_mem1",
					appliedEdits: [{ id: "mem_a", action: "create", kind: "memory", title: "深色偏好", content: "c", applied: true }],
				}),
			],
			turns: 2,
			searches: 1,
			durationMs: 5300,
		});
		expect(text).toContain("沉淀 1 条记忆");
		expect(text).toContain("记忆「深色偏好」（mem_a）");
		expect(text).toContain("2 轮推理 / 1 次检索 / 5.3s");
		expect(text).toContain("/evolve rollback evolve_mem1");
		expect(text).toContain("/evolve recall");
		expect(text).toContain("不要调用任何工具");
	});

	it("renders declined scopes without applied results", () => {
		const text = buildMemoryReceipt({ outcome: "declined", declinedScopes: ["global"], turns: 1, searches: 0, durationMs: 100 });
		expect(text).toContain("global");
		expect(text).toContain("未获批准");
	});

	it("renders no-op as one quiet line", () => {
		const text = buildMemoryReceipt({ outcome: "noop", turns: 1, searches: 1, durationMs: 200 });
		expect(text).toContain("no-op");
		expect(text).not.toContain("/evolve rollback");
	});

	it("folds long edit lists behind an overflow counter", () => {
		const appliedEdits = Array.from({ length: 13 }, (_, i) => ({
			id: `mem_${i}`,
			action: "create" as const,
			kind: "memory" as const,
			title: `T${i}`,
			content: "c",
			applied: true,
		}));
		const text = buildMemoryReceipt({
			outcome: "applied",
			results: [result({ id: "evolve_big", appliedEdits })],
			turns: 3,
			searches: 2,
			durationMs: 1000,
		});
		expect(text).toContain("沉淀 13 条记忆");
		expect(text).toContain("另有 1 条");
	});

	it("names declined scopes on an applied receipt", () => {
		const text = buildMemoryReceipt({
			outcome: "applied",
			results: [
				result({
					id: "evolve_mem1",
					appliedEdits: [{ id: "mem_a", action: "create", kind: "memory", title: "T", content: "c", applied: true }],
				}),
			],
			declinedScopes: ["global"],
			turns: 1,
			searches: 0,
			durationMs: 100,
		});
		expect(text).toContain("global");
		expect(text).toContain("未经批准");
	});

	it("contains a receipt follow-up failure instead of throwing", () => {
		const warn = vi.fn();
		const ctx = { logger: () => ({ warn }) } as unknown as Parameters<typeof notifyMemoryExtraction>[0];
		const agent = { id: "s", followup: () => { throw new Error("inbox full"); } } as unknown as Agent;
		expect(() => notifyMemoryExtraction(ctx, agent, { outcome: "noop", turns: 0, searches: 0, durationMs: 0 })).not.toThrow();
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("falls back to the entry id when an applied edit has no title", () => {
		const text = buildMemoryReceipt({
			outcome: "applied",
			results: [result({ id: "evolve_t", appliedEdits: [{ id: "mem_x", action: "create", kind: "memory", content: "c", applied: true }] })],
			turns: 1,
			searches: 0,
			durationMs: 100,
		});
		expect(text).toContain("（mem_x）");
	});

	it("renders an applied outcome with no batches as declined with the default scope", () => {
		const text = buildMemoryReceipt({ outcome: "applied", turns: 1, searches: 0, durationMs: 100 });
		expect(text).toContain("持久化作用域");
		expect(text).toContain("未写入任何条目");
	});

	it("renders an applied batch with zero landed edits without hiding it", () => {
		const text = buildMemoryReceipt({
			outcome: "applied",
			results: [
				result({
					id: "evolve_empty",
					appliedEdits: [{ id: "mem_z", action: "create", kind: "memory", title: "Z", content: "c", applied: false, error: "no" }],
				}),
			],
			turns: 1,
			searches: 0,
			durationMs: 100,
		});
		expect(text).toContain("沉淀 0 条记忆");
		expect(text).toContain("无条目成功应用");
		expect(text).toContain("/evolve rollback evolve_empty");
	});

	it("renders a declined outcome with the default scope when none is named", () => {
		const text = buildMemoryReceipt({ outcome: "declined", turns: 1, searches: 0, durationMs: 100 });
		expect(text).toContain("持久化作用域");
	});

	it("contains a non-Error follow-up failure instead of throwing", () => {
		const warn = vi.fn();
		const ctx = { logger: () => ({ warn }) } as unknown as Parameters<typeof notifyMemoryExtraction>[0];
		const agent = { id: "s", followup: () => { throw "string failure"; } } as unknown as Agent;
		expect(() => notifyMemoryExtraction(ctx, agent, { outcome: "noop", turns: 0, searches: 0, durationMs: 0 })).not.toThrow();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain("string failure");
	});
});
