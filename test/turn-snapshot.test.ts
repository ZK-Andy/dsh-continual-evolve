import { describe, expect, it } from "vitest";
import {
	captureTurnSnapshot,
	containsDirectMemoryWrite,
	evaluateSnapshotEligibility,
	isInternalAgent,
	sliceTurnSnapshot,
} from "../src/turn-snapshot.js";
import type { Context } from "@deepseek-ai/cordis";

function user(seq: number, text: string, source: Record<string, unknown> = { kind: "user" }): Record<string, unknown> {
	return { type: "user/message", seq, data: { content: [{ type: "text", text }], source } };
}

function assistant(seq: number, text: string): Record<string, unknown> {
	return { type: "assistant/message", seq, data: { content: [{ type: "text", text }] } };
}

function ctxWithEvents(events: unknown[]): Context {
	return { sessionQuery: { readSurface: async () => ({ events }) } } as unknown as Context;
}

const agent = { id: "session-snapshot", session: { header: {} } } as never;

describe("snapshot eligibility", () => {
	it("accepts real user prose and ignores synthetic/model-only text", () => {
		expect(evaluateSnapshotEligibility([user(1, "请记住这个长期约定")])).toMatchObject({ eligible: true, userText: "请记住这个长期约定" });
		expect(evaluateSnapshotEligibility([user(1, "足够长的用户内容", { kind: "user", synthetic: true })])).toMatchObject({ eligible: false, reason: "no-user-prose" });
		expect(evaluateSnapshotEligibility([user(1, "足够长的用户内容", { kind: "goal-continuation" })])).toMatchObject({ eligible: false, reason: "no-user-prose" });
	});

	it("rejects empty, short, internal, and direct-memory-write snapshots", () => {
		expect(evaluateSnapshotEligibility([])).toMatchObject({ eligible: false, reason: "no-new-events" });
		expect(evaluateSnapshotEligibility([user(1, "好")])).toMatchObject({ eligible: false, reason: "no-user-prose" });
		expect(evaluateSnapshotEligibility([user(1, "足够长的用户内容")], true)).toMatchObject({ eligible: false, reason: "internal-agent" });
		const direct = { type: "tool/call", data: { name: "evolve_add" } };
		expect(containsDirectMemoryWrite([direct])).toBe(true);
		expect(evaluateSnapshotEligibility([user(1, "足够长的用户内容"), direct])).toMatchObject({ eligible: false, reason: "direct-memory-write" });
	});

	it("uses a lexical threshold per direct user text part, with CJK segmentation", () => {
		expect(evaluateSnapshotEligibility([user(1, "one two")])).toMatchObject({ eligible: false, reason: "no-user-prose" });
		expect(evaluateSnapshotEligibility([user(1, "one two three")])).toMatchObject({ eligible: true });
		expect(evaluateSnapshotEligibility([user(1, "好"), user(2, "谢谢")])).toMatchObject({ eligible: false, reason: "no-user-prose" });
		expect(evaluateSnapshotEligibility([user(1, "请记住这个长期约定")])).toMatchObject({ eligible: true });
	});

	it("recognizes DSH internal-agent headers", () => {
		expect(isInternalAgent({ session: { header: { origin: "subagent" } } } as never)).toBe(true);
		expect(isInternalAgent({ session: { header: { origin: "internal" } } } as never)).toBe(true);
		expect(isInternalAgent(agent)).toBe(false);
	});
});

describe("captureTurnSnapshot", () => {
	it("uses a durable seq cursor and returns only rows after it", async () => {
		const first = await captureTurnSnapshot(ctxWithEvents([user(1, "第一条约定"), assistant(2, "收到")]), agent, {
			turn: 1,
			reason: "turn_snapshot",
			maxChars: 2000,
		});
		expect(first.cursor).toBe("seq:2");
		expect(first.events).toHaveLength(2);
		expect(first.eligible).toBe(true);
		expect(first.sourceSeqs).toEqual([1]);

		const second = await captureTurnSnapshot(ctxWithEvents([user(1, "第一条约定"), assistant(2, "收到"), user(3, "第二条约定")]), agent, {
			turn: 2,
			reason: "turn_snapshot",
			cursor: first.cursor,
			maxChars: 2000,
		});
		expect(second.cursor).toBe("seq:3");
		expect(second.events).toEqual([user(3, "第二条约定")]);
		expect(second.trajectory).toBe("user: 第二条约定");
		expect(second.sourceSeqs).toEqual([3]);
	});

	it("falls back to an index cursor for surfaces without seq", async () => {
		const snapshot = await captureTurnSnapshot(ctxWithEvents([
			{ type: "user/message", data: { content: [{ type: "text", text: "第一条约定" }], source: { kind: "user" } } },
			{ type: "user/message", data: { content: [{ type: "text", text: "第二条约定" }], source: { kind: "user" } } },
		]), {
			id: "session-index",
			session: { header: {} },
		} as never, {
			turn: 1,
			reason: "turn_snapshot",
			maxChars: 2000,
		});
		expect(snapshot.cursor).toBe("index:2");
	});

	it("slices a full retry snapshot to only evidence after a phase checkpoint", async () => {
		const full = await captureTurnSnapshot(ctxWithEvents([
			user(1, "第一条已由 memory agent 处理"),
			assistant(2, "收到"),
			user(3, "第二条在 review 失败后新增"),
		]), agent, { turn: 2, reason: "turn_snapshot", maxChars: 2000 });
		const sliced = sliceTurnSnapshot(full, "seq:2");
		expect(sliced.cursor).toBe("seq:3");
		expect(sliced.events).toEqual([user(3, "第二条在 review 失败后新增")]);
		expect(sliced.trajectory).toBe("user: 第二条在 review 失败后新增");
	});

	it("does not double-slice a no-sequence snapshot captured after the shared index cursor", async () => {
		const noSeqUser = (text: string): Record<string, unknown> => ({
			type: "user/message",
			data: { content: [{ type: "text", text }], source: { kind: "user" } },
		});
		const first = await captureTurnSnapshot(ctxWithEvents([noSeqUser("第一条无 seq 约定")]), agent, {
			turn: 1,
			reason: "turn_snapshot",
			maxChars: 2000,
		});
		const second = await captureTurnSnapshot(ctxWithEvents([noSeqUser("第一条无 seq 约定"), noSeqUser("第二条无 seq 新证据")]), agent, {
			turn: 2,
			reason: "turn_snapshot",
			cursor: first.cursor,
			maxChars: 2000,
		});
		const sliced = sliceTurnSnapshot(second, first.cursor);
		expect(sliced.events).toEqual([noSeqUser("第二条无 seq 新证据")]);
		expect(sliced.trajectory).toBe("user: 第二条无 seq 新证据");
	});
});
