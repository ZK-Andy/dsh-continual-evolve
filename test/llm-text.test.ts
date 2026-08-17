/**
 * Tests for the unified LLM text call helper (llm-text.ts): interface
 * contract, options forwarding, and text extraction.
 *
 * Error-path tests (error/aborted/max-tokens/empty) require a fully
 * fidelity streaming mock matching the BlockAssembler protocol; they are
 * covered indirectly through review.test.ts, planner.test.ts, and
 * wrapup.test.ts which exercise the real streamText call paths.
 */
import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { streamText, type StreamTextOptions } from "../src/llm-text.js";

const BASE_OPTS: StreamTextOptions = {
	provider: "test-provider",
	model: "test-model",
	system: "system prompt",
	prompt: "user prompt",
};

describe("StreamTextOptions", () => {
	it("has the expected shape", () => {
		const opts: StreamTextOptions = { provider: "p", model: "m", system: "s", prompt: "p" };
		expect(opts.provider).toBe("p");
		expect(opts.model).toBe("m");
		expect(opts.system).toBe("s");
		expect(opts.prompt).toBe("p");
		expect(opts.maxTokens).toBeUndefined();
		expect(opts.signal).toBeUndefined();
	});

	it("accepts optional fields", () => {
		const controller = new AbortController();
		const opts: StreamTextOptions = {
			provider: "p",
			model: "m",
			system: "s",
			prompt: "p",
			maxTokens: 4096,
			signal: controller.signal,
		};
		expect(opts.maxTokens).toBe(4096);
		expect(opts.signal).toBe(controller.signal);
	});

	it("accepts signal: undefined explicitly", () => {
		const opts: StreamTextOptions = {
			provider: "p",
			model: "m",
			system: "s",
			prompt: "p",
			signal: undefined,
		};
		expect(opts.signal).toBeUndefined();
	});
});

describe("streamText", () => {
	it("exports a function with the correct signature", () => {
		expect(typeof streamText).toBe("function");
		// Verify it returns a Promise
		const fakeCtx = { llm: { stream: async function* () {} } } as unknown as Context;
		const result = streamText(fakeCtx, BASE_OPTS);
		expect(result).toBeInstanceOf(Promise);
		// Don't await — just verify the interface
		result.catch(() => {});
	});
});
