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
import {
	BlockAssembler,
	createUserMessage,
	type LlmResolvedModelInfo,
	type Message,
	type ReasoningEffortId,
	type TokenUsage,
} from "@deepseek-ai/dsh-llm";
import { EVOLVE_MESSAGE_SOURCE } from "./message-source.js";

/** Terminal outcome of one shared direct LLM call. */
export type StreamTextOutcome = "success" | "max-tokens" | "error" | "aborted" | "empty";

/** Provider usage and terminal result observed after the stream settles. */
export interface StreamTextObservation {
	usage?: TokenUsage;
	outcome: StreamTextOutcome;
	/** Exact capability-derived effort used for this call; absent when no metadata was exposed. */
	reasoningEffort?: ReasoningEffortId;
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

const CLOSED_REASONING_EFFORTS = new Set(["disabled", "off", "none"]);

/**
 * Select the lowest reasoning effort an exact model advertises.
 *
 * An enabled effort wins over a declared closing effort. The adapter-preferred
 * first enabled effort is the lowest enabled level it exposes; a closing effort
 * is only a fallback when the model publishes no enabled level. No capability
 * list means no caller-supplied effort.
 *
 * @param modelInfo - exact resolved-model metadata, when the provider exposes it.
 * @returns The selected provider-owned effort id, or `undefined` when unknown.
 */
export function selectLowestReasoningEffort(modelInfo: Pick<LlmResolvedModelInfo, "reasoning"> | undefined): ReasoningEffortId | undefined {
	const efforts = modelInfo?.reasoning?.efforts;
	if (efforts !== undefined && !Array.isArray(efforts)) {
		throw new Error("evolve: invalid model reasoning metadata");
	}
	if (!efforts || efforts.length === 0) return undefined;
	for (const effort of efforts) {
		if (typeof effort?.id !== "string") {
			throw new Error("evolve: invalid model reasoning metadata");
		}
	}
	return efforts.find((effort) => !CLOSED_REASONING_EFFORTS.has(effort.id))?.id ?? efforts[0]?.id;
}

async function resolveReasoningEffort(ctx: Context, opts: StreamTextOptions): Promise<ReasoningEffortId | undefined> {
	// The current DSH host exposes this method. Keep a capability-less test or
	// older host usable by treating the absent query as unknown metadata.
	if (typeof ctx.llm.resolveModelInfo !== "function") return undefined;
	const modelInfo = await ctx.llm.resolveModelInfo(opts.provider, opts.model);
	return selectLowestReasoningEffort(modelInfo);
}

/**
 * Stream a single-turn text completion through `ctx.llm`. The request uses the
 * exact provider/model's lowest advertised reasoning effort, omitting the field
 * when the model exposes no reasoning metadata.
 *
 * @returns The concatenated text blocks from the response.
 * @throws On provider error, abort, max-token truncation, or empty output.
 */
export async function streamText(ctx: Context, opts: StreamTextOptions): Promise<string> {
	const assembler = new BlockAssembler();
	let outcome: StreamTextOutcome = "error";
	let reasoningEffort: ReasoningEffortId | undefined;
	try {
		reasoningEffort = await resolveReasoningEffort(ctx, opts);
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
			...(reasoningEffort === undefined ? {} : { reasoningEffort }),
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
			opts.onUsage?.({
				...(assembler.usage ? { usage: assembler.usage } : {}),
				outcome,
				...(reasoningEffort === undefined ? {} : { reasoningEffort }),
			});
		} catch {
			// Usage observation is diagnostic; its failure must not alter the model call.
		}
	}
}
