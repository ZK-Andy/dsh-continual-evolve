/**
 * Tests for the unified LLM text call helper (llm-text.ts): text extraction
 * on success and every finish-state error branch (error / aborted /
 * max-tokens / no text output). A fake `ctx.llm.stream` drives the
 * BlockAssembler protocol with canned chunk lists (fate.test.ts pattern).
 */
import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import { streamText, type StreamTextOptions } from "../src/llm-text.js";

const BASE_OPTS: StreamTextOptions = {
	provider: "test-provider",
	model: "test-model",
	system: "system prompt",
	prompt: "user prompt",
};

/** A fake llm.stream yielding a canned chunk list, verbatim. */
function llmWith(chunks: StreamChunk[]): Context["llm"] {
	return {
		stream: async function* () {
			for (const chunk of chunks) {
				yield chunk;
			}
		},
	} as unknown as Context["llm"];
}

function ctxWith(chunks: StreamChunk[]): Context {
	return { llm: llmWith(chunks) } as unknown as Context;
}

/** A complete text block (block-start + deltas + block-end) as a chunk list. */
function textBlock(text: string, index = 0): StreamChunk[] {
	return [
		{ type: "block-start", index, blockType: "text" },
		{ type: "text-delta", index, text },
		{ type: "block-end", index, block: { type: "text", text } },
	];
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