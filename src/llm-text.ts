/**
 * Unified LLM text call: a shared streaming-text helper used by the review
 * gate, planner, and wrap-up assessor. Eliminates ~120 lines of duplicated
 * BlockAssembler + finish-state-check + text-extraction boilerplate.
 *
 * Every caller needs the same sequence:
 *   provider/model validation → stream → assemble → check finish → extract text
 * This module owns that sequence; callers keep only their prompt construction
 * and JSON parsing.
 */
import type { Context } from "@deepseek-ai/cordis";
import { BlockAssembler, createUserMessage, ReasoningEffortId, type Message, type TokenUsage } from "@deepseek-ai/dsh-llm";
import { EVOLVE_MESSAGE_SOURCE } from "./message-source.js";

/** Terminal outcome of one shared direct LLM call. */
export type StreamTextOutcome = "success" | "max-tokens" | "error" | "aborted" | "empty";

/** Provider usage and terminal result observed after the stream settles. */
export interface StreamTextObservation {
	usage?: TokenUsage;
	outcome: StreamTextOutcome;
}

/** Diagnostic observer invoked before streamText returns or throws. */
export type StreamTextUsageObserver = (observation: StreamTextObservation) => void;

export interface StreamTextOptions {
	provider: string;
	model: string;
	system: string;
	prompt: string;
	maxTokens?: number;
	signal?: AbortSignal | undefined;
	/**
	 * Route A session prefix: session-derived messages sent before the
	 * trailing caller message so providers with prompt caching can serve
	 * the shared context at cache-read price. Empty/omitted keeps the
	 * legacy single-message request.
	 */
	prefixMessages?: readonly Message[];
	/**
	 * Observe the provider-reported usage and terminal outcome after the
	 * stream settles. The callback runs before success/error return and is
	 * diagnostic-only: throwing from it never changes the model call result.
	 */
	onUsage?: StreamTextUsageObserver;
}

/**
 * Stream a single-turn text completion through `ctx.llm`. Forces
 * `reasoningEffort: off` so the model spends its budget on the answer,
 * not visible thinking (reasoning models otherwise produce zero text
 * blocks — the exact failure recorded in FAQ #7).
 *
 * @returns The concatenated text blocks from the response.
 * @throws On provider error, abort, max-token truncation, or empty output.
 */
export async function streamText(ctx: Context, opts: StreamTextOptions): Promise<string> {
	const assembler = new BlockAssembler();
	let outcome: StreamTextOutcome = "error";
	try {
		for await (const chunk of ctx.llm.stream({
			provider: opts.provider,
			model: opts.model,
			system: opts.system,
			messages: [
				...(opts.prefixMessages ?? []),
				createUserMessage({
					content: [{ type: "text", text: opts.prompt }],
					source: EVOLVE_MESSAGE_SOURCE,
				}),
			],
			reasoningEffort: ReasoningEffortId("off"),
			maxTokens: opts.maxTokens ?? 8000,
			...(opts.signal ? { signal: opts.signal } : {}),
		})) {
			assembler.push(chunk);
		}
		const finish = assembler.finish;
		if (finish.kind === "error") {
			outcome = "error";
			throw new Error(`evolve: LLM call failed: ${(finish as { failure?: { message?: string } }).failure?.message ?? "unknown"}`);
		}
		if (finish.kind === "aborted") {
			outcome = "aborted";
			throw new Error("evolve: LLM call aborted");
		}
		if (finish.kind === "max-tokens") {
			outcome = "max-tokens";
			throw new Error("evolve: LLM output budget exhausted (max-tokens)");
		}
		const text = assembler
			.blocks()
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		if (text.length === 0) {
			outcome = "empty";
			throw new Error("evolve: LLM produced no text output");
		}
		outcome = "success";
		return text;
	} finally {
		try {
			opts.onUsage?.({ ...(assembler.usage ? { usage: assembler.usage } : {}), outcome });
		} catch {
			// Usage observation is diagnostic; its failure must not alter the model call.
		}
	}
}
