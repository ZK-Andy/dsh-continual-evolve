/**
 * The memory half of the unified tools: write and read over the `memories`
 * table. Called only from the unified dispatcher (`./evolve-tools.js`).
 * Reply wording preserves the long-standing tool texts.
 */
import { clampLimit, stringField } from "./evolve-fields.js";
import type { MemoryRecord, MemoryStore } from "../store.js";

/** Write fields the memory executor accepts (narrowed from the dispatcher). */
export interface MemoryWriteFields {
	action: string;
	id?: string | undefined;
	type?: string | undefined;
	title?: string | undefined;
	description?: string | undefined;
	body?: string | undefined;
}

/** Read fields the memory executor accepts (narrowed from the dispatcher). */
export interface MemoryReadFields {
	id?: string | undefined;
	query?: string | undefined;
	limit?: unknown;
}

/**
 * The manual promotion fallback (`2026-10-13-memory-tiering-and-promotion`
 * §阶段三): the same shape as a skill's move-to-global — build the global row,
 * archive the project row, one transaction — and it lands on probation unless
 * the user asks for an immediate confirmation, which there is no argument for
 * here: a human moving it *is* the judgement.
 * @param store - The open central store.
 * @param workspaceId - The calling session's workspace partition.
 * @param id - The memory to move.
 * @returns The human-facing result text.
 */
function moveToGlobal(store: MemoryStore, workspaceId: string, id: string | undefined): string {
	if (id === undefined || id.length === 0) {
		return "写入被门禁拒绝，记忆未落盘：move-to-global 需要 id。";
	}
	const outcome = store.promoteMemory(workspaceId, id);
	if (!outcome.ok) {
		return `提级未落地：${outcome.reason ?? "未知原因"}`;
	}
	return `已把记忆 \`${id}\` 提到全局分区（30 天实习期，期间所有工作区可见；有跨项目引用即转正，否则退回本工作区）。`;
}

function fieldsOf(args: MemoryWriteFields): {
	action: string;
	id: string | undefined;
	type: string | undefined;
	title: string | undefined;
	description: string | undefined;
	body: string | undefined;
} {
	return {
		action: args.action,
		id: stringField(args.id),
		type: stringField(args.type),
		title: stringField(args.title),
		description: stringField(args.description),
		body: stringField(args.body),
	};
}

/**
 * Run one memory write against the store (workspace already resolved).
 * @param store - The open central store.
 * @param workspaceId - The calling session's workspace partition.
 * @param sessionId - The calling session id, for ledger provenance.
 * @param args - The narrowed write fields.
 * @returns The human-facing result text.
 */
export function writeMemoryRecord(store: MemoryStore, workspaceId: string, sessionId: string | undefined, args: MemoryWriteFields): string {
	const fields = fieldsOf(args);
	if (fields.action === "move-to-global") {
		return moveToGlobal(store, workspaceId, fields.id);
	}
	const [outcome] = store.applyProposals({ workspaceId, trigger: "explicit", sessionId }, [
		{
			action: fields.action as "create" | "update" | "delete",
			id: fields.id,
			type: fields.type,
			title: fields.title,
			description: fields.description,
			body: fields.body,
		},
	]);
	if (outcome === undefined || !outcome.ok) {
		return `写入被门禁拒绝，记忆未落盘：${outcome?.reason ?? "未知原因"}`;
	}
	if (outcome.action === "delete") {
		return `已删除记忆 \`${outcome.id}\`。旧内容保留在审计账本中，可由用户恢复。`;
	}
	return `已${outcome.action === "create" ? "写入" : "更新"}记忆 \`${outcome.id}\`（本工作区）。下次会话的注入索引会包含它。`;
}

/**
 * Run one memory read against the store (workspace already resolved).
 * @param store - The open central store.
 * @param workspaceId - The calling session's workspace partition.
 * @param args - The narrowed read fields.
 * @returns The human-facing result text.
 */
export function readMemoryRecords(store: MemoryStore, workspaceId: string, args: MemoryReadFields): string {
	const limit = clampLimit(args.limit);
	if (typeof args.id === "string" && args.id.length > 0) {
		const record = store.get(workspaceId, args.id);
		if (record === undefined) {
			return `没有找到 id 为 "${args.id}" 的记忆。`;
		}
		// Presence heartbeat: a body served by id means the model opened it
		// for the task at hand. Search/list hits are noise and stay uncounted.
		store.recordMemoryUse(workspaceId, record.id);
		return formatMemoryRecord(record);
	}
	const query = typeof args.query === "string" ? args.query : "";
	const records = query.length > 0 ? store.search(workspaceId, query, limit) : store.list(workspaceId).slice(0, limit);
	if (records.length === 0) {
		return query.length > 0 ? `没有匹配 "${query}" 的记忆。` : "本工作区还没有记忆。";
	}
	return records.map(formatMemoryRecord).join("\n\n---\n\n");
}

/** Full memory record text: header line, then the body the index omitted. */
function formatMemoryRecord(record: MemoryRecord): string {
	return [
		`# ${record.title}`,
		`id: ${record.id} ｜ 类型: ${record.type} ｜ 状态: ${record.status} ｜ 更新: ${record.updatedAt}`,
		`钩子: ${record.description}`,
		"",
		record.body,
	].join("\n");
}
