/**
 * The automatic /evolve review gate: a cheap model call that decides whether
 * the current trajectory justifies running the planner. Runs on a turn
 * interval (and, in a later step, at compaction). The gate is deliberately
 * small (bounded input, small output budget) — it only answers
 * "should we refine?", never "what should we edit?".
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { HarnessState, RefinementResult } from "./types.js";
import { extractJsonObject } from "./plan.js";
import { formatHarnessStateForPrompt, historyForPrompt } from "./render.js";
import { streamText } from "./llm-text.js";

export interface AutoRefineReview {
	shouldRefine: boolean;
	rationale: string;
	instructions?: string;
}

export type AutoRefineReason = "turn_interval" | "compact" | "goal_blocked";

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
	/** Gap C1: optional provider/model override for the review gate (cheaper model). */
	overrideProvider?: string;
	overrideModel?: string;
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

Repeated multi-step workflows (session start/end routines, recurring
wrap-up or handoff procedures) are a valid refine target: approve with
instructions telling the planner to propose a guidance skill (kind=skill,
skill_kind=guidance — a SKILL.md document, no python reference). Only
propose when the same workflow recurs in the trajectory — never for
one-off flows. Auto-created skills are always offered to the user for a
decision before they land; the gate never writes a skill silently.

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
	const provider = options.overrideProvider ?? agent.options.provider;
	const model = options.overrideModel ?? agent.options.model;
	if (!provider || !model) {
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

	const text = await streamText(ctx, {
		provider,
		model,
		system: AUTO_REVIEW_SYSTEM_PROMPT,
		prompt: userPrompt,
		maxTokens: options.budgetTokens ?? 8000,
		signal: options.signal,
	});
	return parseAutoRefineReview(text);
}
