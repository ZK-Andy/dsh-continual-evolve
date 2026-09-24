/**
 * Tests for the unified LLM text call helper (llm-text.ts): text extraction
 * on success and every finish-state error branch (error / aborted /
 * max-tokens / no text output). A fake `ctx.llm.stream` drives the
 * BlockAssembler protocol with canned chunk lists (fate.test.ts pattern).
 */
import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { ReasoningEffortId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { selectLowestReasoningEffort, streamText, type StreamTextObservation, type StreamTextOptions } from "../src/llm-text.js";

const BASE_OPTS: StreamTextOptions = {
	provider: "test-provider",
	model: "test-model",
	system: "system prompt",
	prompt: "user prompt",
};

/** A fake llm.stream yielding a canned chunk list, verbatim. */
function llmWith(chunks: StreamChunk[], modelInfo?: LlmResolvedModelInfo, requests: GenerateOptions[] = []): Context["llm"] {
	return {
		...(modelInfo === undefined ? {} : { resolveModelInfo: async () => modelInfo }),
		stream: async function* (options: GenerateOptions) {
			requests.push(options);
			for (const chunk of chunks) {
				yield chunk;
			}
		},
	} as unknown as Context["llm"];
}

function ctxWith(chunks: StreamChunk[], modelInfo?: LlmResolvedModelInfo, requests: GenerateOptions[] = []): Context {
	return { llm: llmWith(chunks, modelInfo, requests) } as unknown as Context;
}

/** Exact-model metadata fixture for the capability-derived effort selector. */
function resolvedModelInfo(efforts?: readonly string[]): LlmResolvedModelInfo {
	return {
		provider: BASE_OPTS.provider,
		id: BASE_OPTS.model,
		name: "Test model",
		...(efforts === undefined
			? {}
			: {
					reasoning: {
						efforts: efforts.map((id) => ({ id: ReasoningEffortId(id), name: id })),
					},
				}),
	};
}

/** A complete text block (block-start + deltas + block-end) as a chunk list. */
function textBlock(text: string, index = 0): StreamChunk[] {
	return [
		{ type: "block-start", index, blockType: "text" },
		{ type: "text-delta", index, text },
		{ type: "block-end", index, block: { type: "text", text } },
	];
}

/** One valid provider usage sample; every count is deliberately distinct. */
function usageChunk(): StreamChunk {
	return {
		type: "usage",
		usage: { inputTokens: 10, outputTokens: 3, totalTokens: 18, cacheReadTokens: 5, cacheWriteTokens: 0, reasoningTokens: 1 },
	};
}

describe("streamText success path", () => {
	it("concatenates text blocks across a stream ending with stop", async () => {
		const ctx = ctxWith([...textBlock("hello ", 0), ...textBlock("world", 1), { type: "finish", reason: { kind: "stop" } }]);
		await expect(streamText(ctx, BASE_OPTS)).resolves.toBe("hello \nworld");
	});

	it("returns text even when no explicit finish chunk arrives (defaults to stop)", async () => {
		const ctx = ctxWith(textBlock("lone text"));
		await expect(streamText(ctx, BASE_OPTS)).resolves.toBe("lone text");
	});
});

describe("selectLowestReasoningEffort", () => {
	it("omits absent or empty capability metadata", () => {
		expect(selectLowestReasoningEffort(undefined)).toBeUndefined();
		expect(selectLowestReasoningEffort(resolvedModelInfo([]))).toBeUndefined();
	});

	it("ignores provider default and chooses the first declared non-closing level", () => {
		const info = resolvedModelInfo(["low", "high"]);
		info.reasoning!.defaultEffort = ReasoningEffortId("high");
		expect(selectLowestReasoningEffort(info)).toBe(ReasoningEffortId("low"));
	});

	it("prefers the first enabled level and ignores a closing level", () => {
		expect(selectLowestReasoningEffort(resolvedModelInfo(["low", "none", "high"]))).toBe(ReasoningEffortId("low"));
	});

	it("falls back to a closing level only when no enabled level exists", () => {
		expect(selectLowestReasoningEffort(resolvedModelInfo(["off", "none"]))).toBe(ReasoningEffortId("off"));
	});
});

describe("streamText reasoning effort", () => {
	it("prefers a declared enabled effort over a closing effort for the exact model", async () => {
		const requests: GenerateOptions[] = [];
		const observations: StreamTextObservation[] = [];
		const ctx = ctxWith(
			[...textBlock("done"), { type: "finish", reason: { kind: "stop" } }],
			resolvedModelInfo(["low", "off", "high"]),
			requests,
		);
		await streamText(ctx, { ...BASE_OPTS, onUsage: (value) => observations.push(value) });
		expect(requests[0]).toMatchObject({ provider: BASE_OPTS.provider, model: BASE_OPTS.model, reasoningEffort: ReasoningEffortId("low") });
		expect(observations[0]?.reasoningEffort).toBe(ReasoningEffortId("low"));
	});

	it("uses the first enabled level when the model declares no closing level", async () => {
		const requests: GenerateOptions[] = [];
		const ctx = ctxWith(
			[...textBlock("done"), { type: "finish", reason: { kind: "stop" } }],
			resolvedModelInfo(["low", "medium", "high"]),
			requests,
		);
		await streamText(ctx, BASE_OPTS);
		expect(requests[0]?.reasoningEffort).toBe(ReasoningEffortId("low"));
	});

	it("uses a sole advertised level, including xhigh", async () => {
		const requests: GenerateOptions[] = [];
		const ctx = ctxWith(
			[...textBlock("done"), { type: "finish", reason: { kind: "stop" } }],
			resolvedModelInfo(["xhigh"]),
			requests,
		);
		await streamText(ctx, BASE_OPTS);
		expect(requests[0]?.reasoningEffort).toBe(ReasoningEffortId("xhigh"));
	});

	it("omits reasoningEffort when exact model metadata has no reasoning capability", async () => {
		const requests: GenerateOptions[] = [];
		const ctx = ctxWith([...textBlock("done"), { type: "finish", reason: { kind: "stop" } }], resolvedModelInfo(), requests);
		await streamText(ctx, BASE_OPTS);
		expect(requests[0]).not.toHaveProperty("reasoningEffort");
	});

	it("does not stream or retry when capability resolution fails", async () => {
		let streamCalls = 0;
		const observations: StreamTextObservation[] = [];
		const ctx = {
			llm: {
				resolveModelInfo: async () => {
					throw new Error("capability lookup failed");
				},
				stream: async function* () {
					streamCalls += 1;
					yield* textBlock("unreachable");
				},
			},
		} as unknown as Context;
		await expect(streamText(ctx, { ...BASE_OPTS, onUsage: (value) => observations.push(value) })).rejects.toThrow("capability lookup failed");
		expect(streamCalls).toBe(0);
		expect(observations).toEqual([{ outcome: "error" }]);
	});
});

describe("streamText finish-state errors", () => {
	it("throws a unified error naming the provider failure", async () => {
		const ctx = ctxWith([{ type: "finish", reason: { kind: "error", failure: { message: "provider 500", code: "upstream_error" } } }]);
		await expect(streamText(ctx, BASE_OPTS)).rejects.toThrow(/LLM call failed: provider 500/);
	});

	it("throws on abort with the unified prefix", async () => {
		const ctx = ctxWith([{ type: "finish", reason: { kind: "aborted", failure: { message: "request cancelled", code: "aborted" } } }]);
		await expect(streamText(ctx, BASE_OPTS)).rejects.toThrow(/LLM call aborted/);
	});

	it("throws when the output budget is exhausted (max-tokens)", async () => {
		const ctx = ctxWith([{ type: "finish", reason: { kind: "max-tokens" } }]);
		await expect(streamText(ctx, BASE_OPTS)).rejects.toThrow(/output budget exhausted/);
	});

	it("throws when the stream ends with no text blocks", async () => {
		const ctx = ctxWith([{ type: "finish", reason: { kind: "stop" } }]);
		await expect(streamText(ctx, BASE_OPTS)).rejects.toThrow(/no text output/);
	});

	it("throws when a max-tokens finish is followed by non-text blocks", async () => {
		// A reasoning model may emit only a tool block then hit the budget:
		// the budget error must win over the empty-text check.
		const ctx = ctxWith([
			{ type: "block-start", index: 0, blockType: "tool" },
			{ type: "block-end", index: 0, block: { type: "tool", id: "t", name: "f", arguments: "{}" } },
			{ type: "finish", reason: { kind: "max-tokens" } },
		]);
		await expect(streamText(ctx, BASE_OPTS)).rejects.toThrow(/output budget exhausted/);
	});
});

describe("streamText usage settlement", () => {
	it("observes provider usage exactly once on success", async () => {
		const seen: StreamTextObservation[] = [];
		const ctx = ctxWith([...textBlock("done"), usageChunk(), { type: "finish", reason: { kind: "stop" } }]);
		await expect(streamText(ctx, { ...BASE_OPTS, onUsage: (value) => seen.push(value) })).resolves.toBe("done");
		expect(seen).toEqual([{ usage: { inputTokens: 10, outputTokens: 3, totalTokens: 18, cacheReadTokens: 5, cacheWriteTokens: 0, reasoningTokens: 1 }, outcome: "success" }]);
	});

	for (const testCase of [
		{ name: "provider error", outcome: "error", chunks: [usageChunk(), { type: "finish", reason: { kind: "error", failure: { message: "provider 500", code: "upstream_error" } } } as StreamChunk], error: /LLM call failed/ },
		{ name: "abort", outcome: "aborted", chunks: [usageChunk(), { type: "finish", reason: { kind: "aborted", failure: { message: "cancelled", code: "aborted" } } } as StreamChunk], error: /LLM call aborted/ },
		{ name: "max tokens", outcome: "max-tokens", chunks: [usageChunk(), { type: "finish", reason: { kind: "max-tokens" } } as StreamChunk], error: /output budget exhausted/ },
		{ name: "empty text", outcome: "empty", chunks: [usageChunk(), { type: "finish", reason: { kind: "stop" } } as StreamChunk], error: /no text output/ },
	] as const) {
		it(`observes usage before throwing ${testCase.name}`, async () => {
			const seen: StreamTextObservation[] = [];
			const ctx = ctxWith([...testCase.chunks]);
			await expect(streamText(ctx, { ...BASE_OPTS, onUsage: (value) => seen.push(value) })).rejects.toThrow(testCase.error);
			expect(seen).toHaveLength(1);
			expect(seen[0]?.outcome).toBe(testCase.outcome);
			expect(seen[0]?.usage?.totalTokens).toBe(18);
		});
	}

	it("observes a reasoning-only completion as empty, not success", async () => {
		const seen: StreamTextObservation[] = [];
		const reasoningOnly: StreamChunk[] = [
			{ type: "block-start", index: 0, blockType: "reasoning" },
			{ type: "reasoning-delta", index: 0, text: "private reasoning" },
			{ type: "block-end", index: 0, block: { type: "reasoning", text: "private reasoning" } },
			usageChunk(),
			{ type: "finish", reason: { kind: "stop" } },
		];
		await expect(streamText(ctxWith(reasoningOnly), { ...BASE_OPTS, onUsage: (value) => seen.push(value) })).rejects.toThrow("no text output");
		expect(seen[0]).toMatchObject({ outcome: "empty", usage: { totalTokens: 18 } });
	});

	it("records missing usage without inventing zero", async () => {
		const seen: StreamTextObservation[] = [];
		await streamText(ctxWith([...textBlock("done"), { type: "finish", reason: { kind: "stop" } }]), {
			...BASE_OPTS,
			onUsage: (value) => seen.push(value),
		});
		expect(seen).toEqual([{ outcome: "success" }]);
	});

	it("contains observer failures", async () => {
		const ctx = ctxWith([...textBlock("done"), usageChunk(), { type: "finish", reason: { kind: "stop" } }]);
		await expect(streamText(ctx, { ...BASE_OPTS, onUsage: () => { throw new Error("ledger unavailable"); } })).resolves.toBe("done");
	});

	it("observes an error when the stream throws after usage arrived", async () => {
		const seen: StreamTextObservation[] = [];
		const ctx = {
			llm: {
				stream: async function* () {
					yield usageChunk();
					throw new Error("socket closed");
				},
			},
		} as unknown as Context;
		await expect(streamText(ctx, { ...BASE_OPTS, onUsage: (value) => seen.push(value) })).rejects.toThrow("socket closed");
		expect(seen).toEqual([{ usage: { inputTokens: 10, outputTokens: 3, totalTokens: 18, cacheReadTokens: 5, cacheWriteTokens: 0, reasoningTokens: 1 }, outcome: "error" }]);
	});
});