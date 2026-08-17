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
import { BlockAssembler, createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";

export interface StreamTextOptions {
	provider: string;
	model: string;
	system: string;
	prompt: string;
	maxTokens?: number;
	signal?: AbortSignal | undefined;
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
	for await (const chunk of ctx.llm.stream({
		provider: opts.provider,
		model: opts.model,
		system: opts.system,
		messages: [
			createUserMessage({
				content: [{ type: "text", text: opts.prompt }],
				source: { kind: "plugin", plugin: "dsh-continual-evolve" },
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
		throw new Error(`evolve: LLM call failed: ${(finish as { failure?: { message?: string } }).failure?.message ?? "unknown"}`);
	}
	if (finish.kind === "aborted") {
		throw new Error("evolve: LLM call aborted");
	}
	if (finish.kind === "max-tokens") {
		throw new Error("evolve: LLM output budget exhausted (max-tokens)");
	}
	const text = assembler
		.blocks()
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	if (text.length === 0) {
		throw new Error("evolve: LLM produced no text output");
	}
	return text;
}
