/**
 * The automatic /evolve review gate: a cheap model call that decides whether
 * the current trajectory justifies running the planner. Runs on a turn
 * interval (and, in a later step, at compaction). The gate is deliberately
 * small (bounded input, small output budget) — it only answers
 * "should we refine?", never "what should we edit?".
 */
import type { Context } from "@deepseek-ai/cordis";
import { BlockAssembler, createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { HarnessState, RefinementResult } from "./types.js";
import { extractJsonObject } from "./plan.js";
import { formatHarnessStateForPrompt, historyForPrompt } from "./render.js";

export interface AutoRefineReview {
	shouldRefine: boolean;
	rationale: string;
	instructions?: string;
}

export type AutoRefineReason = "turn_interval" | "compact";

export interface AutoRefineReviewContext {
	reason: AutoRefineReason;
	turnsSinceLastReview: number;
}

export interface ReviewOptions {
	agent: Agent;
	state: HarnessState;
	history: readonly RefinementResult[];
	context: AutoRefineReviewContext;
	/** Serialized trajectory text; when absent the gate is skipped by the caller. */
	trajectory?: string;
	signal?: AbortSignal;
	budgetTokens?: number;
}

export const AUTO_REVIEW_SYSTEM_PROMPT = `You are the automatic /evolve review gate.

Decide whether this checkpoint should run /evolve. Auto /evolve writes local
harness state by default, so approve when the trajectory contains evidence
useful to this session's future turns: a repeated failure, a reusable tactic,
a repeated delegation role, a durable fact or preference, a user correction
that should persist, or a narrow behavioral policy.

The current harness state below includes GLOBAL entries (scope=global) plus
this session's local entries (scope=local). When a topic is already covered
by a global entry, do NOT approve a local duplicate of it — decline and say
in the rationale that the topic is already covered globally.

Reject one-off noise, unsupported hypotheses, transient tool outputs, and
requests that carry no reusable content.

Stale local entries (superseded, long-unused, obsolete facts) are a valid
refine target: approve with instructions naming the entry ids, and tell the
planner to archive them (archive hides from injection, data stays restorable)
rather than delete.

Skill-related trajectories (the evidence concerns creating or improving a
skill entry) are judged against the DSH skill quality standard (skill-audit
dimensions: frontmatter routing, the 7 structural features, paragraph
skeleton, no duplication of the official 11 skills or covered skills).
Approve only when the trajectory shows a REAL trigger scenario and the
resulting skill would meet the standard; otherwise decline and say in the
rationale what must improve — drafting follows skill-creator, and the
planner receives the standard as its <skill_quality_standard> block.

Return JSON only:
{
  "shouldRefine": true|false,
  "rationale": "short reason",
  "instructions": "optional concise instructions for /evolve if shouldRefine is true"
}`;

/** Parse the gate's JSON reply. */
export function parseAutoRefineReview(text: string): AutoRefineReview {
	const value = extractJsonObject(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("auto-refine review JSON must be an object");
	}
	const record = value as Record<string, unknown>;
	const review: AutoRefineReview = {
		shouldRefine: record["shouldRefine"] === true,
		rationale: typeof record["rationale"] === "string" ? record["rationale"] : "No rationale provided.",
	};
	if (typeof record["instructions"] === "string" && record["instructions"].length > 0) {
		review.instructions = record["instructions"];
	}
	return review;
}

/** Serialize surface events to bounded role-prefixed text. */
export function serializeSurface(events: readonly unknown[], maxChars: number): string {
	const lines: string[] = [];
	for (const raw of events) {
		if (typeof raw !== "object" || raw === null) continue;
		const event = raw as { type?: unknown; data?: { content?: unknown } };
		const role = event.type === "user/message" ? "user" : event.type === "assistant/message" ? "assistant" : null;
		if (role === null) continue;
		const content = event.data?.content;
		if (!Array.isArray(content)) continue;
		const text = content
			.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
			.map((block) => block.text ?? "")
			.filter(Boolean)
			.join(" ");
		if (text.length > 0) {
			lines.push(`${role}: ${text}`);
		}
	}
	const joined = lines.join("\n");
	return joined.length <= maxChars ? joined : joined.slice(-maxChars);
}

export async function reviewAutoRefine(ctx: Context, options: ReviewOptions): Promise<AutoRefineReview> {
	const { agent, state, history } = options;
	if (!agent.options.provider || !agent.options.model) {
		throw new Error("evolve: no provider/model route for the review gate");
	}
	if (!options.trajectory || options.trajectory.length === 0) {
		throw new Error("evolve: review gate has no trajectory to judge");
	}
	const userPrompt = [
		`<trigger>\n${options.context.reason}; ${options.context.turnsSinceLastReview} turns since the last review\n</trigger>`,
		`<current_harness_state>\n${formatHarnessStateForPrompt(state)}\n</current_harness_state>`,
		`<refinement_history>\n${historyForPrompt(history)}\n</refinement_history>`,
		`<conversation>\n${options.trajectory}\n</conversation>`,
		"Return shouldRefine=true when the trajectory contains evidence useful to this session's future turns. Prefer local edits; do not ask for global refinement here.",
	].join("\n\n");

	const assembler = new BlockAssembler();
	for await (const chunk of ctx.llm.stream({
		provider: agent.options.provider,
		model: agent.options.model,
		system: AUTO_REVIEW_SYSTEM_PROMPT,
		messages: [
			createUserMessage({
				content: [{ type: "text", text: userPrompt }],
				source: { kind: "plugin", plugin: "dsh-continual-evolve" },
			}),
		],
		// Force non-reasoning output so the model spends its budget on the JSON
		// answer, not on visible thinking (reasoning models otherwise produce
		// zero text blocks — the exact failure recorded in reviews.jsonl).
		reasoningEffort: ReasoningEffortId("off"),
		maxTokens: options.budgetTokens ?? 8000,
		...(options.signal ? { signal: options.signal } : {}),
	})) {
		assembler.push(chunk);
	}
	const finish = assembler.finish;
	if (finish.kind === "error") {
		throw new Error(`evolve: review gate call failed: ${(finish as { failure?: { message?: string } }).failure?.message ?? "unknown"}`);
	}
	if (finish.kind === "aborted") {
		throw new Error("evolve: review gate call aborted");
	}
	if (finish.kind === "max-tokens") {
		throw new Error("evolve: review gate output budget exhausted (max-tokens)");
	}
	const text = assembler
		.blocks()
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	if (text.length === 0) {
		throw new Error("evolve: review gate produced no text");
	}
	return parseAutoRefineReview(text);
}
