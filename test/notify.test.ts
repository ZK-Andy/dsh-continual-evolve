/**
 * Tests for the auto-review visibility notice: the notice text is built from
 * the applied refinement result (never model text), and the follow-up queue
 * is error-contained so a broken notification never breaks the gate path.
 */
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { buildGateNotice, buildMemoryReceipt, notifyAutoReview, notifyMemoryExtraction } from "../src/notify.js";
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

describe("buildGateNotice", () => {
	it("lists applied edits with title, id, and rollback command", () => {
		const notice = buildGateNotice(
			result({
				appliedEdits: [
					{
						id: "mem_a",
						action: "create",
						kind: "memory",
						title: "Project Maintenance Intent",
						content: "c",
						applied: true,
					},
				],
			}),
			6,
		);
		expect(notice).toContain("第 6 回合");
		expect(notice).toContain("1 条条目");
		expect(notice).toContain("记忆「Project Maintenance Intent」（mem_a）");
		expect(notice).toContain("/evolve list");
		expect(notice).toContain("/evolve rollback evolve_test123");
		expect(notice).toContain("不要调用任何工具");
	});

	it("reports failed edits without hiding them", () => {
		const notice = buildGateNotice(
			result({
				appliedEdits: [
					{
						id: "mem_ok",
						action: "create",
						kind: "memory",
						title: "OK",
						content: "c",
						applied: true,
					},
					{
						id: "mem_bad",
						action: "create",
						kind: "memory",
						title: "Bad",
						content: "c",
						applied: false,
						error: "validation failed",
					},
				],
			}),
			6,
		);
		expect(notice).toContain("另有 1 条编辑未应用");
		expect(notice).toContain("记忆「OK」（mem_ok）");
	});

	it("handles a zero-edit result", () => {
		const notice = buildGateNotice(result(), 6);
		expect(notice).toContain("无条目成功应用");
		expect(notice).toContain("沉淀 0 条条目");
	});

	it("falls back to the entry id when an applied edit has no title", () => {
		const notice = buildGateNotice(
			result({
				appliedEdits: [{ id: "mem_x", action: "create", kind: "memory", content: "c", applied: true }],
			}),
			2,
		);
		expect(notice).toContain("记忆「mem_x」（mem_x）");
	});
});

describe("notifyAutoReview", () => {
	function fakeCtx() {
		const warn = vi.fn();
		return {
			ctx: { logger: () => ({ warn }) },
			warn,
		};
	}

	it("queues one follow-up with the built notice text", () => {
		const { ctx } = fakeCtx();
		const followup = vi.fn();
		const agent = { id: "session-x", followup } as unknown as Agent;
		const res = result({
			appliedEdits: [
				{
					id: "mem_a",
					action: "create",
					kind: "memory",
					title: "T",
					content: "c",
					applied: true,
				},
			],
		});

		notifyAutoReview(ctx, agent, res, 6);

		expect(followup).toHaveBeenCalledTimes(1);
		const message = followup.mock.calls[0][0] as { content: Array<{ type: string; text: string }>; source: { kind: string } };
		expect(message.content[0].type).toBe("text");
		expect(message.content[0].text).toContain("记忆「T」（mem_a）");
		expect(message.source.kind).toBe("continual-evolve");
	});

	it("contains a follow-up failure instead of throwing", () => {
		const { ctx, warn } = fakeCtx();
		const agent = {
			id: "session-x",
			followup: () => {
				throw new Error("inbox full");
			},
		} as unknown as Agent;

		expect(() => notifyAutoReview(ctx, agent, result(), 6)).not.toThrow();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain("inbox full");
	});
});

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

	it("labels an unknown entry kind with the kind itself", () => {		const notice = buildGateNotice(
			result({
				appliedEdits: [{ id: "x1", action: "create", kind: "prompt", title: "P", content: "c", applied: true }],
			}),
			3,
		);
		expect(notice).toContain("提示词");
		const foreign = buildGateNotice(
			result({
				appliedEdits: [{ id: "x2", action: "create", kind: "mystery" as never, title: "M", content: "c", applied: true }],
			}),
			3,
		);
		expect(foreign).toContain("mystery「M」（x2）");
	});

	it("contains a non-Error follow-up failure instead of throwing", () => {
		const warn = vi.fn();
		const ctx = { logger: () => ({ warn }) } as unknown as Parameters<typeof notifyMemoryExtraction>[0];
		const agent = { id: "s", followup: () => { throw "string failure"; } } as unknown as Agent;
		expect(() => notifyAutoReview(ctx, agent, result(), 2)).not.toThrow();
		expect(() => notifyMemoryExtraction(ctx, agent, { outcome: "noop", turns: 0, searches: 0, durationMs: 0 })).not.toThrow();
		expect(warn).toHaveBeenCalledTimes(2);
		expect(warn.mock.calls[1][0]).toContain("string failure");
	});
});
