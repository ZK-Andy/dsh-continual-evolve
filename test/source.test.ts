/**
 * Trajectory citation tests: extracting the seqs of recent direct user
 * messages from a duck-typed session log, and building apply citations.
 */
import { describe, expect, it } from "vitest";
import type { AgentLike } from "../src/inject.js";
import { MAX_SOURCE_MESSAGES, entrySourceOf, recentUserSeqs } from "../src/source.js";

function agentWith(events: unknown[]): AgentLike {
	return { id: "session-main", session: { events } };
}

const userRow = (seq: number, content = "hi") => ({
	type: "user/message",
	seq,
	data: { content: [{ type: "text", text: content }], source: { kind: "user" } },
});

describe("recentUserSeqs", () => {
	it("returns the seqs of the most recent direct user messages in log order", () => {
		const agent = agentWith([userRow(10), { type: "assistant/message", seq: 11, data: {} }, userRow(12), userRow(13)]);
		expect(recentUserSeqs(agent)).toEqual([10, 12, 13]);
	});

	it("skips non-user sources (injected plugin context, tool results)", () => {
		const agent = agentWith([
			userRow(10),
			{ type: "user/message", seq: 11, data: { content: "injected", source: { kind: "plugin", plugin: "x" } } },
			{ type: "user/message", seq: 12, data: { content: "tool result", source: { kind: "tool" } } },
		]);
		expect(recentUserSeqs(agent)).toEqual([10]);
	});

	it("caps the number of cited messages", () => {
		const events = Array.from({ length: 6 }, (_, i) => userRow(100 + i));
		expect(recentUserSeqs(agentWith(events))).toHaveLength(MAX_SOURCE_MESSAGES);
		expect(recentUserSeqs(agentWith(events), { maxMessages: 2 })).toEqual([104, 105]);
	});

	it("returns [] for agents without a readable log", () => {
		expect(recentUserSeqs(undefined)).toEqual([]);
		expect(recentUserSeqs({ id: "s" })).toEqual([]);
		expect(recentUserSeqs(agentWith([{ type: "assistant/message", seq: 1, data: {} }]))).toEqual([]);
	});
});

describe("entrySourceOf", () => {
	it("builds a citation with the session id and seqs", () => {
		expect(entrySourceOf(agentWith([userRow(7)]), "session-main")).toEqual({ sessionId: "session-main", seqs: [7] });
	});

	it("builds a session-only citation when no user messages qualify", () => {
		expect(entrySourceOf(agentWith([]), "session-main")).toEqual({ sessionId: "session-main" });
	});

	it("returns undefined without a session id", () => {
		expect(entrySourceOf(agentWith([userRow(7)]), undefined)).toBeUndefined();
		expect(entrySourceOf(undefined, undefined)).toBeUndefined();
	});
});
