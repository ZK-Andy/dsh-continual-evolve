import { describe, expect, it } from "vitest";
import {
	boundaryCursorOf,
	containsExplicitEvolveWrite,
	countWords,
	evaluateSlice,
	eventsAfterCursor,
	isInternalAgent,
	serializeIncrement,
	seqOfCursor,
} from "../src/services/extraction-surface.js";

function userMessage(seq: number, text: string, extra: Record<string, unknown> = {}): unknown {
	return { seq, type: "user/message", data: { content: text, ...extra } };
}

function assistantMessage(seq: number, text: string): unknown {
	return { seq, type: "assistant/message", data: { content: text } };
}

describe("evaluateSlice", () => {
	it("skips internal agents before anything else", () => {
		const slice = evaluateSlice({ events: [userMessage(1, "hello world today")], internalAgent: true });
		expect(slice.eligible).toBe(false);
		expect(slice.skipReason).toBe("internal-agent");
	});

	it("skips empty increments", () => {
		const slice = evaluateSlice({ events: [], internalAgent: false });
		expect(slice.skipReason).toBe("no-new-events");
	});

	it("skips increments whose only tool calls are explicit evolve writes", () => {
		const events = [
			userMessage(1, "记住我在用 Fedora"),
			{ seq: 2, type: "tool/call", data: { name: "evolve_write" } },
		];
		expect(containsExplicitEvolveWrite(events)).toBe(true);
		expect(evaluateSlice({ events, internalAgent: false }).skipReason).toBe("direct-memory-write");
	});

	it("skips increments without real user prose, counting CJK lexically", () => {
		expect(countWords("好的")).toBeLessThan(3);
		expect(countWords("测试别 mock 数据库")).toBeGreaterThanOrEqual(3);
		const slice = evaluateSlice({ events: [userMessage(1, "好的")], internalAgent: false });
		expect(slice.skipReason).toBe("no-user-prose");
		expect(slice.userText).toBe("好的");
	});

	it("passes a real increment with the user rows' seqs", () => {
		const events = [userMessage(7, "请记住我在 Fedora 上工作"), assistantMessage(8, "好的")];
		const slice = evaluateSlice({ events, internalAgent: false });
		expect(slice.eligible).toBe(true);
		expect(slice.userSeqs).toEqual([7]);
	});
});

describe("cursor mechanics", () => {
	it("selects only rows beyond a seq cursor, keeping seq-less rows", () => {
		const events = [userMessage(1, "a b c"), assistantMessage(5, "x"), { type: "tool/call", data: {} }];
		expect(eventsAfterCursor(events, "seq:1")).toHaveLength(2);
		expect(eventsAfterCursor(events, "seq:5")).toHaveLength(1);
		expect(eventsAfterCursor(events, undefined)).toHaveLength(3);
		// A non-seq cursor means "already consumed positionally": nothing new.
		expect(eventsAfterCursor(events, "index:2")).toEqual([]);
	});

	it("computes the boundary from the highest seq and roundtrips", () => {
		expect(boundaryCursorOf([userMessage(3, "a"), assistantMessage(9, "b")])).toBe("seq:9");
		expect(boundaryCursorOf([{}])).toBe("index:1");
		expect(seqOfCursor("seq:42")).toBe(42);
		expect(seqOfCursor("index:3")).toBeUndefined();
	});
});

describe("serializeIncrement", () => {
	it("keeps user/assistant text, drops synthetic rows and everything else", () => {
		const events = [
			userMessage(1, "真实的用户输入"),
			userMessage(2, "工具结果", { source: { kind: "tool" } }),
			userMessage(3, "仅模型可见", { visibility: "model-only" }),
			{ seq: 4, type: "tool/call", data: { name: "x" } },
			assistantMessage(5, "助手回答"),
		];
		const text = serializeIncrement(events, 4000);
		expect(text).toContain("user: 真实的用户输入");
		expect(text).toContain("assistant: 助手回答");
		expect(text).not.toContain("工具结果");
		expect(text).not.toContain("仅模型可见");
		expect(text).not.toContain("tool/call");
	});

	it("keeps the bounded tail when over budget", () => {
		const events = [userMessage(1, "0123456789"), assistantMessage(2, "abcdefghij")];
		expect(serializeIncrement(events, 12)).toBe(": abcdefghij");
	});

	it("unwraps array content blocks and drops non-text ones", () => {
		const events = [
			{
				seq: 1,
				type: "user/message",
				data: {
					content: [
						"plain string block",
						{ type: "text", text: "typed text block" },
						{ type: "image", url: "x" },
						{ type: "text", text: "hidden", synthetic: true },
						{ type: "text", text: "ignored", ignored: true },
						{ type: "text" },
						null,
					],
				},
			},
		];
		const text = serializeIncrement(events, 4000);
		expect(text).toContain("plain string block");
		expect(text).toContain("typed text block");
		expect(text).not.toContain("hidden");
		expect(text).not.toContain("ignored");
	});

	it("treats non-integer or absent seqs as boundary-less rows", () => {
		const events = [{ seq: 1.5, type: "user/message", data: { content: "x" } }, { seq: "7", type: "user/message", data: { content: "y" } }];
		expect(boundaryCursorOf(events)).toBe("index:2");
	});

	it("names the turn's tools without paths or arguments", () => {
		const events = [
			userMessage(1, "把这条写进某个仓库文件"),
			{ seq: 2, type: "tool/call", data: { name: "read" } },
			{ seq: 3, type: "tool-call", data: { tool: "edit", args: { path: "notes/anything.md" } } },
			{ seq: 4, type: "tool/call", data: { name: "read" } },
		];
		const text = serializeIncrement(events, 4000);
		expect(text.split("\n")[0]).toBe("tools-this-turn: read, edit");
		expect(text).not.toContain("notes/anything.md");
	});

	it("keeps the tools line inside the ceiling when the tail is trimmed", () => {
		const events = [userMessage(1, "0123456789"), { seq: 2, type: "tool/call", data: { name: "edit" } }];
		const text = serializeIncrement(events, 40);
		expect(text.startsWith("tools-this-turn: edit\n")).toBe(true);
		expect(text.length).toBeLessThanOrEqual(40);
	});

	it("truncates an oversized tools line instead of blowing the ceiling", () => {
		const events = [{ seq: 1, type: "tool/call", data: { name: "a".repeat(100) } }];
		expect(serializeIncrement(events, 10)).toHaveLength(10);
	});

	it("survives junk rows and caps the tool list", () => {
		const junk = [null, 42, { type: "tool/call", data: { name: 99 } }];
		const synthetic = { seq: 3, type: "user/message", data: { source: { synthetic: true }, content: "合成注入" } };
		const numericContent = { seq: 4, type: "user/message", data: { content: 7 } };
		const tools = Array.from({ length: 25 }, (_, i) => ({ seq: i + 10, type: "tool/call", data: { name: `t${i}` } }));
		const events = [...junk, synthetic, numericContent, ...tools];

		const text = serializeIncrement(events, 4000);
		expect(text.startsWith("tools-this-turn: t0, t1, ")).toBe(true);
		expect(text).not.toContain("t20");
		expect(text).not.toContain("合成注入");
		expect(boundaryCursorOf(events)).toBe("seq:34");
		expect(containsExplicitEvolveWrite(events)).toBe(false);
		expect(evaluateSlice({ events, internalAgent: false }).skipReason).toBe("no-user-prose");
	});
});

describe("isInternalAgent", () => {
	it("detects subagent and internal origins", () => {
		expect(isInternalAgent({ session: { header: { origin: "subagent" } } })).toBe(true);
		expect(isInternalAgent({ session: { header: { origin: "internal" } } })).toBe(true);
		expect(isInternalAgent({ session: { header: { isSubagent: true } } })).toBe(true);
		expect(isInternalAgent({ session: { header: { origin: "user" } } })).toBe(false);
		expect(isInternalAgent(undefined)).toBe(false);
	});
});
