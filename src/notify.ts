/**
 * Auto-review visibility: the gate used to work fully in the background —
 * the user never saw a decision, a persisted entry, or the token spend. This
 * module queues a short follow-up turn after an approved gate run so the
 * user SEES what was persisted, how to inspect it, and how to roll it back.
 *
 * The notice is a `continual-evolve`-sourced user message (`agent.followup`),
 * so it is rendered in the session transcript like any other input and the
 * agent answers with a one-line confirmation. It never fakes tool or assistant
 * events, so session replay, the ordered surface, and derived history stay
 * untouched: the notice is a plain `user/message` carrying this plugin's own
 * source kind.
 *
 * Every mechanical property stays in code: the notice text is built from the
 * applied refinement result, never from model text.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { EVOLVE_MESSAGE_SOURCE } from "./message-source.js";
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
				source: EVOLVE_MESSAGE_SOURCE,
			}),
		);
	} catch (cause) {
		ctx
			.logger("continual-evolve")
			.warn(`auto-review notice failed for ${agent.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
}

/** Unified extraction receipt: one shape for applied / declined / no-op. */
export interface MemoryReceipt {
	outcome: "applied" | "declined" | "noop";
	/** Applied refinement batches (one per scope) for applied outcomes. */
	results?: RefinementResult[];
	/** Scopes the human explicitly declined. */
	declinedScopes?: string[];
	/** Extractor loop turns / manifest searches / wall time. */
	turns: number;
	searches: number;
	durationMs: number;
}

/**
 * Compose the user-visible memory receipt from applied refinement batches
 * (never model text): every landed memory edit with its rollback command.
 * No-op and declined-only outcomes render one quiet line each — a foreground
 * notice for zero landed edits would be nagging, so callers only queue
 * follow-ups for applied outcomes.
 */
export function buildMemoryReceipt(receipt: MemoryReceipt): string {
	const seconds = (receipt.durationMs / 1000).toFixed(1);
	const stats = `${receipt.turns} 轮推理 / ${receipt.searches} 次检索 / ${seconds}s`;
	if (receipt.outcome === "noop") {
		return `🧠 记忆提取：本轮无可沉淀的持久事实（no-op，${stats}），未写入任何条目。`;
	}
	const results = receipt.results ?? [];
	const declinedScopes = receipt.declinedScopes ?? [];
	if (receipt.outcome === "declined" || results.length === 0) {
		const scopes = declinedScopes.join("、") || "持久化作用域";
		return `🧠 记忆提取：${scopes}的写入未获批准，已跳过（${stats}），未写入任何条目。`;
	}
	const applied = results.flatMap((result) => result.appliedEdits.filter((edit) => edit.applied));
	const lines = applied.slice(0, 12).map((edit) => `- 记忆「${edit.title ?? edit.id}」（${edit.id}）`);
	if (applied.length > 12) lines.push(`- …另有 ${applied.length - 12} 条（见 /evolve history）`);
	const declined = declinedScopes.length > 0 ? `\n另有作用域${declinedScopes.join("、")}未经批准（已跳过）。` : "";
	const rollbacks = [...new Set(results.map((result) => result.id))].map((id) => `/evolve rollback ${id}`).join("；");
	return [
		`🧠 记忆提取：本轮沉淀 ${applied.length} 条记忆（${results.length} 个作用域批次，${stats}）：`,
		lines.length > 0 ? lines.join("\n") : "（无条目成功应用）",
		declined,
		`回看：/evolve recall <关键词>；回滚：${rollbacks}`,
		"请用一句话简短确认即可，不要调用任何工具。",
	]
		.filter((part) => part !== "")
		.join("\n");
}

/**
 * Queue the memory receipt follow-up. Same containment as the gate notice:
 * notification failure only logs. Callers gate on applied outcomes — no-op
 * and declined-only runs stay audit-only (reviews.jsonl) and never wake
 * the agent.
 */
export function notifyMemoryExtraction(ctx: Context, agent: Agent, receipt: MemoryReceipt): void {
	try {
		agent.followup(
			createUserMessage({
				content: [{ type: "text", text: buildMemoryReceipt(receipt) }],
				source: EVOLVE_MESSAGE_SOURCE,
			}),
		);
	} catch (cause) {
		ctx
			.logger("continual-evolve")
			.warn(`memory receipt notice failed for ${agent.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
}
