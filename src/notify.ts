/**
 * Auto-review visibility: the gate used to work fully in the background —
 * the user never saw a decision, a persisted entry, or the token spend. This
 * module queues a short follow-up turn after an approved gate run so the
 * user SEES what was persisted, how to inspect it, and how to roll it back.
 *
 * The notice is a plugin-sourced user message (`agent.followup`), so it is
 * rendered in the session transcript like any other input and the agent
 * answers with a one-line confirmation. It never fakes tool or assistant
 * events, so session replay, the ordered surface, and derived history stay
 * untouched: the notice is a plain `user/message` with a plugin source.
 *
 * Every mechanical property stays in code: the notice text is built from the
 * applied refinement result, never from model text.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { RefinementResult } from "./types.js";

/**
 * Compose the user-visible gate notice from an applied refinement result.
 * Lists every successfully applied edit (kind + title + id) and the rollback
 * command; failed edits are summarized in one line so nothing is hidden.
 */
export function buildGateNotice(result: RefinementResult, turnsSinceLastReview: number): string {
	const applied = result.appliedEdits.filter((edit) => edit.applied);
	const failed = result.appliedEdits.filter((edit) => !edit.applied);
	const kindLabel: Record<string, string> = { prompt: "提示词", memory: "记忆", skill: "技能", subagent: "子代理" };
	const lines = applied.map((edit) => `- ${kindLabel[edit.kind] ?? edit.kind}「${edit.title ?? edit.id}」（${edit.id}）`);
	const linesText = lines.length > 0 ? lines.join("\n") : "（无条目成功应用）";
	const failedText = failed.length > 0 ? `\n另有 ${failed.length} 条编辑未应用。` : "";
	return [
		`🔎 自动进化门禁：会话第 ${turnsSinceLastReview} 回合检查完成，本次沉淀 ${applied.length} 条条目：`,
		linesText,
		failedText,
		`查看全部条目：/evolve list；回滚本次沉淀：/evolve rollback ${result.id}`,
		"请用一句话简短确认即可，不要调用任何工具。",
	]
		.filter((part) => part !== "")
		.join("\n");
}

/**
 * Queue the follow-up notice turn for the agent. Failure is contained: a
 * broken notification must never break the gate path that already recorded
 * the decision in reviews.jsonl.
 */
export function notifyAutoReview(ctx: Context, agent: Agent, result: RefinementResult, turnsSinceLastReview: number): void {
	try {
		agent.followup(
			createUserMessage({
				content: [{ type: "text", text: buildGateNotice(result, turnsSinceLastReview) }],
				source: { kind: "plugin", plugin: "dsh-continual-evolve" },
			}),
		);
	} catch (cause) {
		ctx
			.logger("continual-evolve")
			.warn(`auto-review notice failed for ${agent.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
}
