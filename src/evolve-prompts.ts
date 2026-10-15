/**
 * The prompt-supplement half of the unified tools: write and read over the
 * `prompts` table (workspace-scoped, no global scope). Called only from the
 * unified dispatcher (`./evolve-tools.js`); prompts have no legacy tool
 * names, so there are no shims — `kind: "prompt"` is the only path.
 */
import type { MemoryStore, PromptRecord } from "./store.js";

/** Write fields the prompt executor accepts (narrowed from the dispatcher). */
export interface PromptWriteFields {
	action: string;
	id?: string | undefined;
	title?: string | undefined;
	description?: string | undefined;
	body?: string | undefined;
}

/** Read fields the prompt executor accepts (narrowed from the dispatcher). */
export interface PromptReadFields {
	id?: string | undefined;
	query?: string | undefined;
	limit?: unknown;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Run one prompt write against the store (workspace already resolved).
 * @param store - The open central store.
 * @param workspaceId - The calling session's workspace partition.
 * @param sessionId - The calling session id, for ledger provenance.
 * @param args - The narrowed write fields.
 * @returns The human-facing result text.
 */
export function writePromptRecord(
	store: MemoryStore,
	workspaceId: string,
	sessionId: string | undefined,
	args: PromptWriteFields,
): string {
	if (args.action === "move-to-global") {
		return "写入被门禁拒绝，提示词补充未落盘：move-to-global 仅支持技能，提示词补充无全局分区。";
	}
	const [outcome] = store.applyPromptProposals({ workspaceId, trigger: "explicit", sessionId }, [
		{
			action: args.action as "create" | "update" | "delete",
			id: stringField(args.id),
			title: stringField(args.title),
			description: stringField(args.description),
			body: stringField(args.body),
		},
	]);
	if (outcome === undefined || !outcome.ok) {
		return `写入被门禁拒绝，提示词补充未落盘：${outcome?.reason ?? "未知原因"}`;
	}
	if (outcome.action === "delete") {
		return `已删除提示词补充 \`${outcome.id}\`。旧内容保留在提示词账本中，可由用户恢复。`;
	}
	return `已${outcome.action === "create" ? "写入" : "更新"}提示词补充 \`${outcome.id}\`（本工作区，可经 evolve_read 与卡片取用）。`;
}

/**
 * Run one prompt read against the store (workspace already resolved).
 * @param store - The open central store.
 * @param workspaceId - The calling session's workspace partition.
 * @param args - The narrowed read fields.
 * @returns The human-facing result text.
 */
export function readPromptRecords(store: MemoryStore, workspaceId: string, args: PromptReadFields): string {
	const limit = clampLimit(args.limit);
	if (typeof args.id === "string" && args.id.length > 0) {
		const record = store.getPrompt(workspaceId, args.id);
		if (record === undefined) {
			return `没有找到 id 为 "${args.id}" 的提示词补充。`;
		}
		// Presence heartbeat, same discipline as memories and skills: a body
		// served by id means the model opened it for the task at hand.
		store.recordPromptUse(workspaceId, record.id);
		return formatPromptRecord(record);
	}
	const query = typeof args.query === "string" ? args.query : "";
	const records = query.length > 0 ? store.searchPrompts(workspaceId, query, limit) : store.listPrompts(workspaceId).slice(0, limit);
	if (records.length === 0) {
		return query.length > 0 ? `没有匹配 "${query}" 的提示词补充。` : "本工作区还没有提示词补充。";
	}
	return records.map(formatPromptRecord).join("\n\n---\n\n");
}

function clampLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 3;
	}
	return Math.min(10, Math.max(1, Math.floor(value)));
}

/** Full prompt record text: header line, then the body the index omitted. */
function formatPromptRecord(record: PromptRecord): string {
	return [`# ${record.title}`, `id: ${record.id} ｜ 状态: ${record.status} ｜ 更新: ${record.updatedAt}`, `钩子: ${record.description}`, "", record.body].join(
		"\n",
	);
}
