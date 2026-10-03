/**
 * Memory-extraction visibility: the extractor works in the background —
 * the user would never see a persisted entry or the token spend. This
 * module queues a short follow-up turn after an applied extraction moment
 * so the user SEES what was persisted, how to inspect it, and how to roll
 * it back.
 *
 * The receipt is a `continual-evolve`-sourced user message (`agent.followup`),
 * so it is rendered in the session transcript like any other input and the
 * agent answers with a one-line confirmation. It never fakes tool or assistant
 * events, so session replay, the ordered surface, and derived history stay
 * untouched: the receipt is a plain `user/message` carrying this plugin's own
 * source kind.
 *
 * Every mechanical property stays in code: the receipt text is built from the
 * applied refinement batches, never from model text.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { EVOLVE_MESSAGE_SOURCE } from "./message-source.js";
import type { RefinementResult } from "./types.js";

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
