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
	const answer = await userQuestions.ask({
		questions: [
			{
				id: "approve-global-evolve",
				question: `批准写入${storeLabel}？\n\n${what}`,
				options: [{ label: "批准" }, { label: "拒绝" }],
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
