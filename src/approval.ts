/**
 * Human approval gate for persistent-scope evolution edits. Project and
 * global edits require an explicit human "批准" before they are applied;
 * rollbacks (which restore prior recorded state) do not. The engine itself
 * stays a pure library — this is a policy at the boundary.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { approvalCopy, resolveDialogLanguage } from "./copy.js";
import type { RecordLanguage } from "./record-language.js";

export type ScopeApprovalDecision = "approved" | "declined";

export interface QuestionService {
	ask(request: {
		questions: { id: string; question: string; options?: { label: string; description?: string }[] }[];
		agent?: Agent;
		signal?: AbortSignal;
	}): Promise<{ answers?: { id: string; selected?: string[] }[] }>;
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
 * @param ctx Cordis context carrying the userQuestions service.
 * @param agent Agent prompting the question, if any.
 * @param signal Abort signal for the question, if any.
 * @param scope Target persistent scope.
 * @param what Edit summary; truncated to 300 chars with "…" when longer.
 * @param lang Dialog language; absent → resolved per call (durable client
 *             preference, else `en`).
 * @returns "approved" when the user picks the approval label, otherwise "declined".
 * @throws When the service is missing or the answer is not unique/explicit.
 */
export async function requestScopeApproval(
	ctx: Context,
	agent: Agent | undefined,
	signal: AbortSignal | undefined,
	scope: "project" | "global",
	what: string,
	lang?: RecordLanguage,
): Promise<ScopeApprovalDecision> {
	const userQuestions = questionServiceOf(ctx);
	if (!userQuestions) {
		throw new Error("global evolution edits require the userQuestions service (load @deepseek-ai/dsh-user-questions)");
	}
	const copy = approvalCopy(scope, what, lang ?? resolveDialogLanguage(ctx));
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
	const selected = [...new Set(matching[0]?.selected ?? [])];
	const approvals = selected.filter((label) => label === "批准" || label === "Approve");
	const declines = selected.filter((label) => label === "拒绝" || label === "Decline");
	if (approvals.length + declines.length !== 1 || selected.length !== 1) {
		throw new Error(`evolution approval returned an invalid decision: ${JSON.stringify(selected)}`);
	}
	return approvals.length === 1 ? "approved" : "declined";
}

/**
 * Ask the user to approve a global edit. Throws when the service is missing,
 * the user declines, or the question cannot be answered.
 */
export async function requireGlobalApproval(
	ctx: Context,
	agent: Agent | undefined,
	signal: AbortSignal | undefined,
	what: string,
): Promise<void> {
	if ((await requestScopeApproval(ctx, agent, signal, "global", what)) !== "approved") {
		throw new Error("global evolution edit rejected by the user");
	}
}
