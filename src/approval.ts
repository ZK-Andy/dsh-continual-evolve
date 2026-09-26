/**
 * Human approval gate for persistent-scope evolution edits. Project and
 * global edits require an explicit human "批准" before they are applied;
 * rollbacks (which restore prior recorded state) do not. The engine itself
 * stays a pure library — this is a policy at the boundary.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";

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
 * Copy follows the headline → details → impact shape: the first line names
 * the target store, the middle carries the (truncated) edit summary, and the
 * last line states visibility/reversibility. Option labels stay literal
 * ("批准"/"拒绝") for parser compatibility; human guidance lives in
 * `description`.
 *
 * @param ctx Cordis context carrying the userQuestions service.
 * @param agent Agent prompting the question, if any.
 * @param signal Abort signal for the question, if any.
 * @param scope Target persistent scope.
 * @param what Edit summary; truncated to 300 chars with "…" when longer.
 * @returns "approved" when the user picks "批准", otherwise "declined".
 * @throws When the service is missing or the answer is not unique/explicit.
 */
export async function requestScopeApproval(
	ctx: Context,
	agent: Agent | undefined,
	signal: AbortSignal | undefined,
	scope: "project" | "global",
	what: string,
): Promise<ScopeApprovalDecision> {
	const userQuestions = questionServiceOf(ctx);
	if (!userQuestions) {
		throw new Error("global evolution edits require the userQuestions service (load @deepseek-ai/dsh-user-questions)");
	}
	const storeLabel = scope === "project" ? "本项目跨会话 store" : "跨会话全局 store";
	const compactWhat = what.length > 300 ? `${what.slice(0, 300)}…` : what;
	const impact = scope === "project" ? "影响：仅本项目会话可见，可回滚。" : "影响：所有会话可见，可回滚。";
	const answer = await userQuestions.ask({
		questions: [
			{
				id: "approve-global-evolve",
				question: `写入${storeLabel}？\n${compactWhat}\n${impact}`,
				options: [
					{
						label: "批准",
						description: scope === "project" ? "写入，仅本项目会话可见" : "写入，所有会话可见",
					},
					{ label: "拒绝", description: "不写入，本次跳过" },
				],
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
	const known = selected.filter((label): label is "批准" | "拒绝" => label === "批准" || label === "拒绝");
	if (known.length !== 1 || selected.length !== 1) {
		throw new Error(`evolution approval returned an invalid decision: ${JSON.stringify(selected)}`);
	}
	return known[0] === "批准" ? "approved" : "declined";
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
