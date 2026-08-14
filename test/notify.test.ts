/**
 * Tests for the auto-review visibility notice: the notice text is built from
 * the applied refinement result (never model text), and the follow-up queue
 * is error-contained so a broken notification never breaks the gate path.
 */
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { buildGateNotice, notifyAutoReview } from "../src/notify.js";
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
		const message = followup.mock.calls[0][0] as { content: Array<{ type: string; text: string }>; source: { kind: string; plugin: string } };
		expect(message.content[0].type).toBe("text");
		expect(message.content[0].text).toContain("记忆「T」（mem_a）");
		expect(message.source.kind).toBe("plugin");
		expect(message.source.plugin).toBe("dsh-continual-evolve");
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
