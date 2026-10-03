/**
 * Session wrap-up: the lifecycle exit for a session's local harness entries.
 *
 * When a session ends, its local entries default to orphans: a later session
 * (not on the parentSession chain) never sees them, and nothing promotes or
 * archives them — the exploration results effectively "die" with the session.
 * Wrap-up gives those entries a real exit:
 *
 * - cross-session-reusable content is classified `promote` and moved into the
 *   global store (through the human approval gate — global is a governed
 *   resource, exactly like skill proposals);
 * - session-specific / superseded / already-covered content is classified
 *   `archive` (hidden from injection, data stays restorable, rollbackable);
 * - everything else is kept.
 *
 * Division of labor is deliberate: the mechanical audit proposes, the LLM
 * classifies, the user approves, the code applies deterministically. The
 * apply-side guard (`filterPromotable`) re-checks global coverage at apply
 * time so a stale classification can never write a duplicate global entry.
 *
 * Split (2026-10-03 refactor): the candidate domain lives in
 * `wrapup-candidates.ts`, the proposal builders in `wrapup-proposals.ts`;
 * this module owns the bounded LLM assessment call. Moved symbols are
 * re-exported here so the public surface stays on one module.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { asLlmSessionId, streamText } from "./llm-text.js";
import { createTokenUsageObserver, type TokenUsageTarget } from "./token-usage.js";
import { recordLanguageInstruction, resolveRecordLanguage, type RecordLanguage } from "./record-language.js";
import { compactText } from "./render.js";
import { candidateKey, parseWrapupAssessment, type WrapupAssessment, type WrapupCandidate } from "./wrapup-candidates.js";

export * from "./wrapup-candidates.js";
export * from "./wrapup-proposals.js";

export const WRAPUP_ASSESS_SYSTEM_PROMPT = `You are the /evolve session wrap-up assessor.
A session is ending and its local harness entries need a fate. Classify each
listed entry exactly once:

- "promote" — the content is a stable, durable, CROSS-SESSION reusable lesson:
  a durable user preference, a project-level fact or convention, a reusable
  procedure or skill. Future sessions would benefit from seeing it.
- "archive" — the content is session-specific task progress, one-off noise,
  superseded or obsolete, or already covered by the global store (note
  "covered globally" in the reason), or stale (old + never injected — note
  "stale (injectionCount=0, recency low)" in the reason), or CONTRADICTED —
  newer evidence in the trajectory or the global store disproves or overrides
  the entry's content (note what contradicts it in the reason).
- "keep" — still actively useful to this session, or genuinely uncertain.

Rules:
- CONTRADICTED: when evidence contradicts an entry, set "contradicted": true
  on that item (besides the verdict). Entries marked "(contradicted N×
  before)" were contradicted in earlier assessments — prefer "archive" for
  them unless you have concrete evidence the content is valid again.
- When an entry is marked "covered globally" in the listing, prefer "archive"
  or "keep" over "promote" — promoting a duplicate gains nothing.
- When an entry is marked "stale" (injectionCount=0 and low recency), prefer
  "archive" — the entry has never been used and is old, so it is unlikely to
  be needed again. Only "keep" if the content is clearly valuable despite low
  usage (e.g. a safety policy that rarely triggers but is critical).
- Do not promote local task state, work-in-progress notes, or content tied to
  one session's ephemeral details.
- Memory entries carry a recall type (user/feedback/project/reference): a
  memory WITHOUT one cannot be promoted (the guard skips it) — verdict such
  entries "keep" (or "archive" when they qualify) rather than "promote".
- Skills: only "promote" a skill entry that is a genuinely reusable procedure
  meeting the DSH skill quality standard; one-off workflows are "archive" or
  "keep".
- SPLIT PROMOTION: when an entry mixes a stable, cross-session-reusable part
  WITH session-specific snapshot details, do NOT promote it whole. Instead
  give verdict "archive" WITH a "promote" sub-object holding a CLEANED
  version of only the durable part (a stable title + the persistent facts,
  stripped of dates/states/one-off figures). Ephemeral snapshot content stays
  out of the sub-object — it is left behind in the archive. A sub-object is
  only meaningful on "archive" verdicts.

Return JSON only:
{
  "rationale": "one or two sentences",
  "items": [
    {"key": "memory:foo", "verdict": "promote|archive|keep", "reason": "why"},
    {"key": "memory:bar", "verdict": "archive", "reason": "why", "contradicted": true,
     "promote": {"title": "cleaned stable title", "content": "cleaned durable part only"}}
  ]
}
Only keys from the provided list are allowed; any entry you omit defaults to "keep".`;

export interface AssessOptions {
	/** Output token budget for the assessment call. */
	maxOutputTokens?: number;
	/** Abort signal forwarded to the model call. */
	signal?: AbortSignal;
	/** Direct-call token ledger destination; phase is selected by the caller. */
	tokenUsage?: TokenUsageTarget;
	/** Ledger phase for this classifier call (manual wrapup or automatic fate). */
	tokenUsagePhase?: "wrapup" | "fate";
	/**
	 * Authoring language for verdict reasons. Absent → resolved per call
	 * (durable client preference, else `en`; the assessor sees candidate
	 * snapshots, not user text, so there is no detection tier here).
	 */
	language?: RecordLanguage;
}

/**
 * Ask the model to classify the audited local candidates. Routes through the
 * calling agent's own provider/model (same model the session runs on), with
 * reasoning disabled so the output budget goes to the JSON verdicts.
 */
export async function assessLocalEntries(
	ctx: Context,
	agent: Agent,
	candidates: readonly WrapupCandidate[],
	options: AssessOptions = {},
): Promise<WrapupAssessment> {
	if (candidates.length === 0) {
		return { items: [], rationale: "No local candidates to assess." };
	}
	if (!agent.options.provider || !agent.options.model) {
		throw new Error("evolve: no provider/model route for the wrap-up assessor");
	}
		const candidateText = candidates
			.map((candidate) => {
				const key = candidateKey(candidate.kind, candidate.id);
				const covered = candidate.coveredGlobally ? " (covered globally)" : "";
				const stale = candidate.stale ? ` (stale: injectionCount=${candidate.injectionCount}, recency low)` : "";
				const negated = candidate.negativeCount > 0 ? ` (contradicted ${candidate.negativeCount}× before)` : "";
				const hints =
					candidate.globalHints.length > 0
						? ` | global≈${candidate.globalHints.map((hint) => hint.id + ":" + hint.title).join(", ")}`
						: "";
				return `- ${key} [${candidate.path}, v${candidate.version}] "${candidate.title}"${covered}${stale}${negated}${hints}: ${compactText(candidate.content, 220)}`;
			})
			.join("\n");
	const userPrompt = [
		`A local session is wrapping up. Classify each entry below for its fate.`,
		`<local_entries>\n${candidateText}\n</local_entries>`,
		"Return only JSON. Every item must reference one of the keys above.",
	].join("\n\n");

	const text = await streamText(ctx, {
		provider: agent.options.provider,
		model: agent.options.model,
		sessionId: asLlmSessionId(agent.id),
		system: `${WRAPUP_ASSESS_SYSTEM_PROMPT}\n\n${recordLanguageInstruction(options.language ?? resolveRecordLanguage({ ctx }))}`,
		prompt: userPrompt,
		maxTokens: options.maxOutputTokens ?? 4096,
		signal: options.signal,
		...(options.tokenUsage
			? {
					onUsage: createTokenUsageObserver(
						options.tokenUsage,
						options.tokenUsagePhase ?? "wrapup",
						agent.options.provider,
						agent.options.model,
					),
				}
			: {}),
	});
	return parseWrapupAssessment(text, candidates);
}
