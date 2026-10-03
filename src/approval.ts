/**
 * Human approval gate for persistent-scope evolution edits. Project and
 * global edits require an explicit human "批准" before they are applied;
 * rollbacks (which restore prior recorded state) do not. The engine itself
 * stays a pure library — this is a policy at the boundary.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { approvalCopy } from "./copy.js";
import { normalizeRecordLanguage, resolveRecordLanguage, type RecordLanguage, type RecordLanguagePreference } from "./record-language.js";
import { recentUserText, type AgentLike } from "./inject.js";

export { type ScopeApprovalDecision } from "./types.js";
import type { ScopeApprovalDecision } from "./types.js";

/** Labels the approval dialog offers for each decision (parser contract). */
export const APPROVE_LABELS = ["批准", "Approve"] as const;
export const DECLINE_LABELS = ["拒绝", "Decline"] as const;

/**
 * Typed ("Other") answers accepted as an explicit decision once normalized.
 * Deliberately exact: a substring rule would read "不批准" as approval, and a
 * misread decision is far worse than asking the human to click the button.
 */
const TYPED_APPROVALS = new Set(["批准", "approve"]);
const TYPED_DECLINES = new Set(["拒绝", "decline"]);

/** Trim case/quotes/trailing punctuation and a trailing 吧/了 from a typed answer. */
function normalizeTypedAnswer(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/^[\s"'“”「」]+/, "")
		.replace(/[\s"'“”「」。！!，,、]+$/, "")
		.replace(/[吧了]$/, "");
}

/**
 * Read a free-text answer as a decision, or `undefined` when it matches no
 * label exactly. Never guesses.
 */
function typedDecision(custom: unknown): ScopeApprovalDecision | undefined {
	if (typeof custom !== "string") return undefined;
	const normalized = normalizeTypedAnswer(custom);
	if (TYPED_APPROVALS.has(normalized)) return "approved";
	if (TYPED_DECLINES.has(normalized)) return "declined";
	return undefined;
}

export interface QuestionService {
	ask(request: {
		questions: { id: string; question: string; options?: { label: string; description?: string }[] }[];
		agent?: Agent;
		signal?: AbortSignal;
	}): Promise<{ answers?: { id: string; selected?: string[]; custom?: string }[] }>;
}

/**
 * Lazily resolve the userQuestions service from the context.
 * Returns undefined when the service is not loaded — callers decide
 * whether that is an error or a fallback.
 */
export function questionServiceOf(ctx: Context): QuestionService | undefined {
	return (ctx as unknown as { userQuestions?: QuestionService }).userQuestions;
}

/**
 * Ask once for a persistent-scope edit. Only a unique, explicit approval
 * choice is accepted. A missing/ambiguous/unknown answer throws so callers
 * never interpret a lost or malformed dialog as a durable rejection.
 *
 * Copy follows the headline → details → impact shape in the resolved dialog
 * language; labels stay literal per language for parser compatibility.
 *
 * Language resolution runs the full record-language chain — explicit config,
 * then the durable client preference, then the session's own recent user text
 * — because an approval dialog raised from a tool call DOES have a session
 * behind it. Stopping at the durable tier gave a Chinese-speaking user English
 * dialogs whenever the stored preference was unset (2026-10-01).
 *
 * @param ctx Cordis context carrying the userQuestions service.
 * @param agent Agent prompting the question, if any.
 * @param signal Abort signal for the question, if any.
 * @param scope Target persistent scope.
 * @param what Edit summary; truncated to 300 chars with "…" when longer.
 * @param configured Plugin `recordLanguage` preference; `auto`/absent defers
 *                   to the durable preference and the session's user text.
 * @returns "approved" when the user picks the approval label, otherwise "declined".
 * @throws When the service is missing or the answer is not unique/explicit.
 */
export async function requestScopeApproval(
	ctx: Context,
	agent: Agent | undefined,
	signal: AbortSignal | undefined,
	scope: "project" | "global",
	what: string,
	configured?: RecordLanguagePreference,
): Promise<ScopeApprovalDecision> {
	const userQuestions = questionServiceOf(ctx);
	if (!userQuestions) {
		throw new Error("global evolution edits require the userQuestions service (load @deepseek-ai/dsh-user-questions)");
	}
	const lang: RecordLanguage =
		normalizeRecordLanguage(configured) ??
		resolveRecordLanguage({ ctx, trajectoryText: recentUserText(agent as AgentLike | undefined) });
	const copy = approvalCopy(scope, what, lang);
	const answer = await userQuestions.ask({
		questions: [
			{
				id: "approve-global-evolve",
				question: copy.question,
				options: copy.options,
			},
		],
		...(agent ? { agent } : {}),
		...(signal ? { signal } : {}),
	});
	const matching = answer.answers?.filter((entry) => entry.id === "approve-global-evolve") ?? [];
	if (matching.length !== 1 || !Array.isArray(matching[0]?.selected)) {
		throw new Error("evolution approval returned no unique explicit decision");
	}
	const entry = matching[0]!;
	const selected = [...new Set(entry.selected)];
	if (selected.length === 0) {
		// A typed "Other" answer counts only when it matches a dialog label
		// exactly; anything fuzzier stays an error, so a lost or ambiguous
		// reply is never recorded as a durable rejection.
		const typed = typedDecision(entry.custom);
		if (typed !== undefined) {
			return typed;
		}
		throw new Error(
			`evolution approval needs one clicked option (${APPROVE_LABELS.join("/")} or ${DECLINE_LABELS.join("/")}) — a typed reply cannot serve as a decision`,
		);
	}
	if (selected.length !== 1) {
		throw new Error(`evolution approval returned an invalid decision: ${JSON.stringify(selected)}`);
	}
	const label = selected[0]!;
	if ((APPROVE_LABELS as readonly string[]).includes(label)) {
		return "approved";
	}
	if ((DECLINE_LABELS as readonly string[]).includes(label)) {
		return "declined";
	}
	throw new Error(`evolution approval returned an unknown decision label: ${JSON.stringify(label)}`);
}

/**
 * Ask the user to approve a global edit. Throws when the service is missing,
 * the user declines, or the question cannot be answered.
 *
 * @param configured Plugin `recordLanguage` preference (see {@link requestScopeApproval}).
 */
export async function requireGlobalApproval(
	ctx: Context,
	agent: Agent | undefined,
	signal: AbortSignal | undefined,
	what: string,
	configured?: RecordLanguagePreference,
): Promise<void> {
	if ((await requestScopeApproval(ctx, agent, signal, "global", what, configured)) !== "approved") {
		throw new Error("global evolution edit rejected by the user");
	}
}
