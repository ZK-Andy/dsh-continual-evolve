/**
 * Prefix-cache routing tests: cache-evidence detection, Route A/B
 * selection, session-prefix reconstruction, and the planner/gate wiring
 * (Route A drops the flat trajectory block and prepends the prefix;
 * Route B keeps the legacy input; an empty prefix falls back to B).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import {
	buildPrefixMessages,
	DEFAULT_PREFIX_MAX_CHARS,
	detectPlannerRoute,
	hasCacheEvidence,
	resolvePrefixCache,
} from "../src/prefix-cache.js";
import { planWithLlm } from "../src/planner.js";
import { reviewAutoRefine } from "../src/review.js";
import type { HarnessState } from "../src/types.js";
import { loadTokenUsage } from "../src/token-usage.js";

const emptyState: HarnessState = {
	schema: 1,
	entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
	refinements: [],
};

const userRow = (seq: number, text: string, source?: { kind: string }) => ({
	type: "user/message",
	seq,
	data: { content: [{ type: "text", text }], source: source ?? { kind: "user" } },
});

const assistantRow = (seq: number, text: string, cacheReadTokens?: number) => ({
	type: "assistant/message",
	seq,
	data: {
		content: [{ type: "text", text }],
		...(cacheReadTokens === undefined ? {} : { usage: { cacheReadTokens } }),
	},
});

describe("hasCacheEvidence", () => {
	it("is true when an assistant message reports cache-read tokens", () => {
		expect(hasCacheEvidence([userRow(1, "hi"), assistantRow(2, "hello", 120)])).toBe(true);
	});

	it("is false without usage, with zero reads, or on an empty log", () => {
		expect(hasCacheEvidence([userRow(1, "hi"), assistantRow(2, "hello")])).toBe(false);
		expect(hasCacheEvidence([assistantRow(1, "hello", 0)])).toBe(false);
		expect(hasCacheEvidence([])).toBe(false);
	});

	it("ignores user-message usage and malformed rows", () => {
		expect(
			hasCacheEvidence([
				{ type: "user/message", seq: 1, data: { usage: { cacheReadTokens: 50 } } },
				null,
				"junk",
				{ type: "assistant/message", seq: 2, data: { usage: { cacheReadTokens: "lots" } } },
			]),
		).toBe(false);
	});
});

describe("resolvePrefixCache / detectPlannerRoute", () => {
	it("defaults to auto with the default budget", () => {
		expect(resolvePrefixCache()).toEqual({ mode: "auto", maxChars: DEFAULT_PREFIX_MAX_CHARS });
		expect(resolvePrefixCache({})).toEqual({ mode: "auto", maxChars: DEFAULT_PREFIX_MAX_CHARS });
	});

	it("rejects a non-positive budget", () => {
		expect(() => resolvePrefixCache({ maxChars: 0 })).toThrow(/positive integer/);
		expect(() => resolvePrefixCache({ maxChars: -5 })).toThrow(/positive integer/);
	});

	it("routes session→A and off→B regardless of evidence", () => {
		expect(detectPlannerRoute([], "session")).toBe("A");
		expect(detectPlannerRoute([assistantRow(1, "hi", 9)], "off")).toBe("B");
	});

	it("auto-detects from cache evidence", () => {
		expect(detectPlannerRoute([assistantRow(1, "hi", 9)])).toBe("A");
		expect(detectPlannerRoute([userRow(1, "hi")])).toBe("B");
		expect(detectPlannerRoute([])).toBe("B");
	});
});

describe("buildPrefixMessages", () => {
	it("maps user/assistant rows to stamped messages in order", () => {
		const messages = buildPrefixMessages([userRow(1, "first"), assistantRow(2, "second", 3)], {
			provider: "p",
			model: "m",
		});
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(messages[0]).toMatchObject({ role: "user", source: { kind: "user" } });
		expect(messages[1]).toMatchObject({ role: "assistant", source: { provider: "p", model: "m" } });
	});

	it("skips injected plugin/tool user rows, empty text, and non-text blocks", () => {
		const messages = buildPrefixMessages(
			[
				userRow(1, "direct"),
				userRow(2, "injected", { kind: "plugin" }),
				{ type: "user/message", seq: 3, data: { content: "tool result", source: { kind: "tool" } } },
				{ type: "user/message", seq: 4, data: { content: [{ type: "text", text: "  " }], source: { kind: "user" } } },
				{ type: "assistant/message", seq: 5, data: { content: [{ type: "tool-call", id: "c1" }] } },
			],
			{ provider: "p", model: "m" },
		);
		expect(messages.map((message) => message.role)).toEqual(["user"]);
	});

	it("caps tail-biased by dropping oldest whole messages", () => {
		const messages = buildPrefixMessages([userRow(1, "aaaa"), userRow(2, "bbbb"), userRow(3, "cccc")], {
			maxChars: 8,
		});
		const texts = messages.map((message) => (message.content[0] as { text: string }).text);
		expect(texts).toEqual(["bbbb", "cccc"]);
	});

	it("keeps the tail of a lone over-budget message", () => {
		const messages = buildPrefixMessages([userRow(1, "abcdef")], { maxChars: 3 });
		const first = messages[0];
		if (first === undefined) throw new Error("expected one prefix message");
		expect((first.content[0] as { text: string }).text).toBe("def");
	});

	it("returns [] when nothing qualifies", () => {
		expect(buildPrefixMessages([], { provider: "p", model: "m" })).toEqual([]);
	});

	it("fails loud when assistant text lacks a provider/model route", () => {
		expect(() => buildPrefixMessages([assistantRow(1, "hi")], {})).toThrow(/provider\/model/);
	});
});

/** A fake llm.stream capturing the full messages array plus the trailing prompt. */
function fakeCtx(): { ctx: Context; captured: { roles: string[]; userPrompt: string } } {
	const captured: { roles: string[]; userPrompt: string } = { roles: [], userPrompt: "" };
	const ctx = {
		llm: {
			stream: async function* (options: { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }) {
				captured.roles = options.messages.map((message) => message.role);
				const last = options.messages[options.messages.length - 1];
				captured.userPrompt = last?.content.find((block) => block.type === "text")?.text ?? "";
				const text = JSON.stringify({ summary: "none", rationale: "thin", expectedOutcome: "none", edits: [] });
				const chunks: StreamChunk[] = [
					{ type: "block-start", index: 0, blockType: "text" },
					{ type: "text-delta", index: 0, text },
					{ type: "block-end", index: 0, block: { type: "text", text } },
					{ type: "usage", usage: { inputTokens: 15, outputTokens: 3, totalTokens: 18 } },
					{ type: "finish", reason: { kind: "stop" } },
				];
				for (const chunk of chunks) {
					yield chunk;
				}
			},
		},
	} as unknown as Context;
	return { ctx, captured };
}

function agentWith(events: unknown[]) {
	return {
		id: "session-main",
		options: { provider: "test-provider", model: "test-model" },
		session: { events },
	} as unknown as Parameters<typeof planWithLlm>[1]["agent"];
}

describe("planner Route A wiring", () => {
	it("prepends the prefix and drops the flat trajectory block on cache evidence", async () => {
		const { ctx, captured } = fakeCtx();
		const agent = agentWith([userRow(1, "first request"), assistantRow(2, "answer", 40), userRow(3, "follow-up")]);
		await planWithLlm(ctx, { agent, state: emptyState, history: [] });
		expect(captured.roles).toEqual(["user", "assistant", "user", "user"]);
		expect(captured.userPrompt).not.toContain("<session_trajectory>");
		expect(captured.userPrompt).toContain("<current_harness_state>");
	});

	it("keeps an explicitly passed trajectory in Route A", async () => {
		const { ctx, captured } = fakeCtx();
		const agent = agentWith([assistantRow(1, "answer", 40)]);
		await planWithLlm(ctx, { agent, state: emptyState, history: [], trajectory: "explicit trajectory" });
		expect(captured.roles.length).toBeGreaterThan(1);
		expect(captured.userPrompt).toContain("<session_trajectory>");
		expect(captured.userPrompt).toContain("explicit trajectory");
	});

	it("stays on Route B without evidence and with mode off", async () => {
		const { ctx, captured } = fakeCtx();
		await planWithLlm(ctx, { agent: agentWith([userRow(1, "hi")]), state: emptyState, history: [] });
		expect(captured.roles).toEqual(["user"]);
		expect(captured.userPrompt).toContain("<session_trajectory>");

		const { ctx: ctx2, captured: captured2 } = fakeCtx();
		const agent = agentWith([userRow(1, "hi"), assistantRow(2, "answer", 40)]);
		await planWithLlm(ctx2, { agent, state: emptyState, history: [], prefixCache: { mode: "off" } });
		expect(captured2.roles).toEqual(["user"]);
	});
});

describe("gate Route A wiring", () => {
	const reviewContext = { reason: "turn_interval" as const, turnsSinceLastReview: 6 };

	it("prepends the prefix, drops flat text, and records exact review usage", async () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-review-token-"));
		try {
			const { ctx, captured } = fakeCtx();
			const agent = agentWith([userRow(1, "did the thing"), assistantRow(2, "done", 12)]);
			await reviewAutoRefine(ctx, {
				agent: agent as unknown as Parameters<typeof reviewAutoRefine>[1]["agent"],
				state: emptyState,
				history: [],
				trajectory: "flat conversation text",
				context: reviewContext,
				tokenUsage: { baseDir: dir, sessionId: "session-main", retain: 10 },
			});
			expect(captured.roles).toEqual(["user", "assistant", "user"]);
			expect(captured.userPrompt).not.toContain("<conversation>");
			expect(captured.userPrompt).not.toContain("flat conversation text");
			expect(loadTokenUsage(dir).records).toEqual([
				expect.objectContaining({ phase: "review", outcome: "success", usage: { inputTokens: 15, outputTokens: 3, totalTokens: 18 } }),
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the flat block on Route B", async () => {
		const { ctx, captured } = fakeCtx();
		const agent = agentWith([userRow(1, "did the thing")]);
		await reviewAutoRefine(ctx, {
			agent: agent as unknown as Parameters<typeof reviewAutoRefine>[1]["agent"],
			state: emptyState,
			history: [],
			trajectory: "flat conversation text",
			context: reviewContext,
		});
		expect(captured.roles).toEqual(["user"]);
		expect(captured.userPrompt).toContain("<conversation>");
	});
});
