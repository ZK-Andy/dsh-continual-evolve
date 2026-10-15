/**
 * The skill half of the unified tools: write and read over the `skills`
 * table (project partition plus the global `""` partition, project
 * shadowing global). Called only from the unified dispatcher
 * (`./evolve-tools.js`). Reply wording preserves the long-standing tool texts.
 */
import { skillUsagePartition } from "../services/skill-rules.js";
import { clampLimit, stringField } from "./evolve-fields.js";
import type { MemoryStore, SkillRecord } from "../store.js";

/** Write fields the skill executor accepts (narrowed from the dispatcher). */
export interface SkillWriteFields {
	action: string;
	scope?: string | undefined;
	id?: string | undefined;
	title?: string | undefined;
	description?: string | undefined;
	body?: string | undefined;
}

/** Read fields the skill executor accepts (narrowed from the dispatcher). */
export interface SkillReadFields {
	id?: string | undefined;
	query?: string | undefined;
	limit?: unknown;
}

/**
 * Run one skill write against the store (workspace already resolved).
 * @param store - The open central store.
 * @param workspaceId - The calling session's workspace partition.
 * @param sessionId - The calling session id, for ledger provenance.
 * @param args - The narrowed write fields.
 * @returns The human-facing result text.
 */
export function writeSkillRecord(store: MemoryStore, workspaceId: string, sessionId: string | undefined, args: SkillWriteFields): string {
	const action = args.action as "create" | "update" | "delete" | "move-to-global";
	const { outcomes, warnings } = store.applySkillProposals({ workspaceId, trigger: "explicit", sessionId }, [
		{
			action,
			scope: stringField(args.scope),
			id: stringField(args.id),
			title: stringField(args.title),
			description: stringField(args.description),
			body: stringField(args.body),
		},
	]);
	const outcome = outcomes[0];
	if (outcome === undefined || !outcome.ok) {
		return `写入被门禁拒绝，技能未落盘：${outcome?.reason ?? "未知原因"}`;
	}
	const warningText = warnings.length > 0 ? `（文件投影告警：${warnings.map((w) => w.warning).join("；")}）` : "";
	if (outcome.action === "delete") {
		return `已删除技能 \`${outcome.id}\`。旧内容保留在技能账本中，可由用户恢复。${warningText}`;
	}
	if (outcome.action === "move-to-global") {
		return `已把技能 \`${outcome.id}\` 手动搬到全局（本项目侧已归档）。重启后所有工作区可用。${warningText}`;
	}
	return `已${outcome.action === "create" ? "写入" : "更新"}技能 \`${outcome.id}\`（本项目，重启后本工作区可用）。${warningText}`;
}

/**
 * Run one skill read against the store (workspace already resolved).
 * @param store - The open central store.
 * @param workspaceId - The calling session's workspace partition.
 * @param args - The narrowed read fields.
 * @returns The human-facing result text.
 */
export function readSkillRecords(store: MemoryStore, workspaceId: string, args: SkillReadFields): string {
	const limit = clampLimit(args.limit);
	if (typeof args.id === "string" && args.id.length > 0) {
		const found = readWithScope(store, workspaceId, args.id);
		if (found === undefined) {
			return `没有找到 id 为 "${args.id}" 的技能。`;
		}
		// Consulted set: a body served by id means the model opened it for
		// the task at hand. Search/list hits are noise and stay uncounted;
		// human card previews never count.
		store.recordSkillUse(skillUsagePartition(found.scope, workspaceId), found.record.id, found.scope);
		return formatSkill(found.record, found.scope);
	}
	const query = typeof args.query === "string" ? args.query : "";
	const merged = query.length > 0 ? searchWithScope(store, workspaceId, query, limit) : listWithScope(store, workspaceId, limit);
	if (merged.length === 0) {
		return query.length > 0 ? `没有匹配 "${query}" 的技能。` : "本项目和全局都还没有技能。";
	}
	return merged.map((entry) => formatSkill(entry.record, entry.scope)).join("\n\n---\n\n");
}

/** Full skill text: header line with scope, then the body. */
function formatSkill(
	record: { id: string; title: string; description: string; body: string; updatedAt: string; status: string },
	scope: string,
): string {
	return [
		`# ${record.title}`,
		`id: ${record.id} ｜ 范围: ${scope === "global" ? "全局" : "本项目"} ｜ 状态: ${record.status} ｜ 更新: ${record.updatedAt}`,
		`钩子: ${record.description}`,
		"",
		record.body,
	].join("\n");
}

/** One skill row with the scope it was read from (shadowing resolved). */
interface ScopedSkill {
	record: SkillRecord;
	scope: "project" | "global";
}

/** Project-first read: a project row shadows the global row of the same id. */
function readWithScope(store: MemoryStore, workspaceId: string, id: string): ScopedSkill | undefined {
	const project = store.getSkill(workspaceId, id);
	if (project !== undefined && project.status !== "archived") {
		return { record: project, scope: "project" };
	}
	const global = store.getSkill("", id);
	if (global !== undefined && global.status !== "archived") {
		return { record: global, scope: "global" };
	}
	return undefined;
}

/** Scope-merged search: project wins on id collisions, global fills the rest. */
function searchWithScope(store: MemoryStore, workspaceId: string, query: string, limit: number): ScopedSkill[] {
	const seen = new Set<string>();
	const merged: ScopedSkill[] = [];
	for (const record of store.searchSkills(workspaceId, query, limit)) {
		if (seen.has(record.id)) {
			continue;
		}
		seen.add(record.id);
		merged.push({ record, scope: "project" });
	}
	if (merged.length < limit) {
		for (const record of store.searchSkills("", query, limit)) {
			if (seen.has(record.id)) {
				continue;
			}
			seen.add(record.id);
			merged.push({ record, scope: "global" });
		}
	}
	return merged.slice(0, limit);
}

/** Scope-merged listing: project rows first, then global rows. */
function listWithScope(store: MemoryStore, workspaceId: string, limit: number): ScopedSkill[] {
	const merged: ScopedSkill[] = store
		.listSkills(workspaceId)
		.slice(0, limit)
		.map((record) => ({ record, scope: "project" as const }));
	if (merged.length < limit) {
		const seen = new Set(merged.map((entry) => entry.record.id));
		for (const record of store.listSkills("")) {
			if (merged.length >= limit) {
				break;
			}
			if (seen.has(record.id)) {
				continue;
			}
			seen.add(record.id);
			merged.push({ record, scope: "global" as const });
		}
	}
	return merged;
}
