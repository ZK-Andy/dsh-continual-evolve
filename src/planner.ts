/**
 * The LLM planning pass. Given the current harness state, refinement history,
 * and optional instructions, a direct model call produces a JSON proposal
 * which is parsed (truncation-aware) and validated by the pure core.
 *
 * The call routes through `ctx.llm` with the calling agent's own
 * provider/model so the plan uses the same model the session runs on.
 */
import type { Context } from "@deepseek-ai/cordis";
import { BlockAssembler, createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { HarnessState, RefinementProposal, RefinementResult } from "./types.js";
import { parseProposal } from "./plan.js";
import { formatHarnessStateForPrompt, historyForPrompt } from "./render.js";
import { recentUserText } from "./inject.js";

export const PLANNER_SYSTEM_PROMPT = `You are the /evolve continual harness subsystem.

Your job is to improve the editable continual harness state. Instead of
summarizing the conversation you emit precise Create, Update, or Delete edits
to reusable state: prompt notes, memories, skills, and subagent specs.

Rules:
- The base system prompt is immutable and MUST NOT be rewritten (never edit id "base_system_prompt").
- Prefer small evidence-backed edits. If no useful edit is justified, return an empty edits array.
- prompt = narrow behavioral policy addendums; memory = durable facts/preferences/failures;
  skill = repeatable procedures (must carry a python reference {type:"python", import, callable}
  and an arguments object); subagent = reusable delegation roles.
- Local edits are session-scoped; global edits persist across sessions.
- Ground every edit in evidence: the session trajectory (recent direct user
  messages) is provided when available; prefer edits backed by it over
  speculation, and never invent preferences the user did not express.
- Output JSON only, exactly this shape:
{
  "summary": "one sentence",
  "rationale": "why these edits are justified by the evidence",
  "expectedOutcome": "what should improve and how to validate it",
  "edits": [
    {
      "action": "create|update|delete",
      "kind": "prompt|memory|skill|subagent",
      "id": "stable id for update/delete, optional for create",
      "title": "required for create/update except delete",
      "content": "required for create/update except delete",
      "path": "optional grouping path",
      "reference": {"type":"python","import":"pkg.mod","callable":"fn"} ,
      "arguments": {"name": {"type":"string","required":true,"description":"..."}},
      "metadata": {},
      "reason": "why this edit is useful"
    }
  ]
}`;

export interface PlanOptions {
	agent: Agent;
	state: HarnessState;
	history: readonly RefinementResult[];
	instructions?: string;
	/**
	 * Explicit session-trajectory text (recent direct user messages). When
	 * omitted, it is extracted from the agent's own session log via
	 * `recentUserText` — the same extraction the injection ranking uses — so
	 * every planning call is grounded in what the user actually said.
	 */
	trajectory?: string;
	global?: boolean;
	signal?: AbortSignal;
	maxOutputTokens?: number;
}

export async function planWithLlm(ctx: Context, options: PlanOptions): Promise<RefinementProposal> {
	const { agent, state, history } = options;
	if (!agent.options.provider || !agent.options.model) {
		throw new Error("evolve: the calling agent has no provider/model route to plan with");
	}
	const scopeInstruction = options.global
		? "Requested scope: global. Only propose stable cross-session lessons, durable preferences, reusable skills/subagents, or explicitly project-qualified facts."
		: "Requested scope: local. Prefer session-scoped edits for current task progress; global entries are read-only context — do not propose update/delete for them.";

	// Ground the plan in the caller's session: the trajectory block is the
	// most recent direct user messages ("" when none qualify — the block is
	// then omitted entirely, keeping an empty trajectory zero-cost).
	const trajectory = options.trajectory ?? recentUserText(agent);

	const userPrompt = [
		`<current_harness_state>\n${formatHarnessStateForPrompt(state)}\n</current_harness_state>`,
		`<refinement_history>\n${historyForPrompt(history)}\n</refinement_history>`,
		`<scope_policy>\n${scopeInstruction}\n</scope_policy>`,
		trajectory ? `<session_trajectory>\n${trajectory}\n</session_trajectory>` : "",
		options.instructions ? `<user_instructions>\n${options.instructions}\n</user_instructions>` : "",
		"Return only JSON edits. If no useful edit is justified, return an empty edits array with a rationale.",
	]
		.filter(Boolean)
		.join("\n\n");

	const assembler = new BlockAssembler();
	for await (const chunk of ctx.llm.stream({
		provider: agent.options.provider,
		model: agent.options.model,
		system: PLANNER_SYSTEM_PROMPT,
		messages: [
			createUserMessage({
				content: [{ type: "text", text: userPrompt }],
				source: { kind: "plugin", plugin: "dsh-continual-evolve" },
			}),
		],
		// Force non-reasoning output: the proposal must be pure JSON text.
		reasoningEffort: ReasoningEffortId("off"),
		maxTokens: options.maxOutputTokens ?? 8000,
		...(options.signal ? { signal: options.signal } : {}),
	})) {
		assembler.push(chunk);
	}
	throwOnFinishError(assembler.finish);
	const blocks = assembler.blocks();
	const text = blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	if (text.length === 0) {
		throw new Error("evolve: planner produced no text output");
	}
	return parseProposal(text);
}

/** Surface terminal stream states as errors so the caller never sees a silent partial plan. */
function throwOnFinishError(finish: { kind: string; failure?: { message?: string } }): void {
	switch (finish.kind) {
		case "stop":
		case "tool-calls":
			return;
		case "max-tokens":
			throw new Error("evolve: planner output budget exhausted (max-tokens)");
		case "aborted":
			throw new Error("evolve: planner call aborted");
		case "error":
			throw new Error(`evolve: planner call failed: ${finish.failure?.message ?? "unknown error"}`);
	}
}
