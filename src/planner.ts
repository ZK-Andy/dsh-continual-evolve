/**
 * The LLM planning pass. Given the current harness state, refinement history,
 * and optional instructions, a direct model call produces a JSON proposal
 * which is parsed (truncation-aware) and validated by the pure core.
 *
 * The call routes through `ctx.llm` with the calling agent's own
 * provider/model so the plan uses the same model the session runs on.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { HarnessState, RefinementProposal, RefinementResult } from "./types.js";
import { parseProposal } from "./plan.js";
import { formatHarnessStateForPrompt, historyForPrompt } from "./render.js";
import { recentUserText } from "./inject.js";
import { skillQualityGuide } from "./skillquality.js";
import { streamText } from "./llm-text.js";

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
- Skill entries are authored to the DSH skill quality standard
  (skill-creator, distilled from the official deepseek-harness 11 skills;
  the full facts are provided in the <skill_quality_standard> block below):
  only for a REAL trigger scenario grounded in the trajectory
  (who, in what real task, what signal) — never invent one to pad the store;
  never duplicate the official 11 skills or existing entries; content is a
  SKILL.md document (frontmatter routing with "use when / do not use when"
  description, boundary declaration, prerequisites and exclusions, layered
  information, verifiable completion criteria). Self-check every proposed
  skill against the 7 structural features and state the result in its
  reason field.
- Repeated multi-step workflows (session start/end routines, recurring
  wrap-up or handoff procedures) may be proposed as guidance skills:
  kind=skill, skill_kind="guidance", content = a SKILL.md document (no
  python reference — executable skills keep requiring reference +
  arguments). Only propose with repeated evidence in the trajectory, never
  for one-off flows. Guidance skills materialize as discoverable SKILL.md
  files under <skillsRoot>/<kebab-name>/SKILL.md and are always offered to
  the user for a decision before they land.
- Local edits are session-scoped; global edits persist across sessions.
- Gap C2: EVERY edit MUST include a "blastRadius" field indicating how broadly
  the edit applies: "general" (cross-project tactical rule, applies everywhere),
  "project" (valid for the current project/repo), or "session" (one-off,
  specific to this session's context). The review gate validates that
  local-scope edits use "session" or "project", and global-scope edits use
  "general" or "project". When in doubt, prefer narrower blast radius.
- Ground every edit in evidence: the session trajectory (recent direct user
  messages) is provided when available; prefer edits backed by it over
  speculation, and never invent preferences the user did not express.
- Stale entries (superseded by newer ones, never referenced in recent
  trajectories, obsolete facts): propose action "archive" instead of
  "delete" — archive hides the entry from injection while keeping its data
  restorable; it requires only kind + id.
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
      "skill_kind": "executable|guidance (optional; skill kind only — guidance = SKILL.md document without reference)",
      "metadata": {},
      "reason": "why this edit is useful",
      "blastRadius": "general|project|session"
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
	/**
	 * Skills root to read the skill-creator template facts from
	 * (`<root>/skill-creator/references/template.md`). When omitted or the
	 * skills are not installed, the builtin distilled quality guide is
	 * injected instead — the skill standard is always present.
	 */
	skillsRoot?: string;
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

	// The skill quality standard is always present: the skill-creator
	// template facts when installed, the builtin distilled guide otherwise
	// (~1KB — planning is low-frequency, and the standard keeps skill
	// proposals from drifting off the quality bar).
	const qualityGuide = skillQualityGuide(options.skillsRoot);

	const userPrompt = [
		`<current_harness_state>\n${formatHarnessStateForPrompt(state)}\n</current_harness_state>`,
		`<refinement_history>\n${historyForPrompt(history)}\n</refinement_history>`,
		`<scope_policy>\n${scopeInstruction}\n</scope_policy>`,
		trajectory ? `<session_trajectory>\n${trajectory}\n</session_trajectory>` : "",
		`<skill_quality_standard>\n${qualityGuide.text}\n</skill_quality_standard>`,
		options.instructions ? `<user_instructions>\n${options.instructions}\n</user_instructions>` : "",
		"Return only JSON edits. If no useful edit is justified, return an empty edits array with a rationale.",
	]
		.filter(Boolean)
		.join("\n\n");

	const text = await streamText(ctx, {
		provider: agent.options.provider,
		model: agent.options.model,
		system: PLANNER_SYSTEM_PROMPT,
		prompt: userPrompt,
		maxTokens: options.maxOutputTokens ?? 8000,
		signal: options.signal,
	});
	return parseProposal(text);
}
