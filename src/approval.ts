/**
 * Human approval gate for cross-session (global) evolution edits. Forward
 * edits to the shared global store require an explicit human "批准" before
 * they are applied; rollbacks (which restore prior recorded state) do not.
 * The engine itself stays a pure library — this is a policy at the boundary.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";

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
 * Ask the user to approve a global edit. Throws when the service is missing,
 * the user declines, or the question cannot be answered.
 */
export async function requireGlobalApproval(
	ctx: Context,
	agent: Agent | undefined,
	signal: AbortSignal | undefined,
	what: string,
): Promise<void> {
	const userQuestions = questionServiceOf(ctx);
	if (!userQuestions) {
		throw new Error("global evolution edits require the userQuestions service (load @deepseek-ai/dsh-user-questions)");
	}
	const answer = await userQuestions.ask({
		questions: [
			{
				id: "approve-global-evolve",
				question: `批准写入跨会话全局 store？\n\n${what}`,
				options: [{ label: "批准" }, { label: "拒绝" }],
			},
		],
		...(agent ? { agent } : {}),
		...(signal ? { signal } : {}),
	});
	const item = answer.answers?.find((entry) => entry.id === "approve-global-evolve");
	const approved = item?.selected?.includes("批准") ?? false;
	if (!approved) {
		throw new Error("global evolution edit rejected by the user");
	}
}
