/**
 * The model-facing skill tools: `skill_write` (the explicit write path
 * through the store's gates, plus the manual move to the global scope) and
 * `skill_read` (bodies and search across the project partition and the
 * global scope, project shadowing global on name collisions).
 *
 * Skills are created in the project only — global rows arise solely from an
 * explicit `move-to-global`. There is no promotion mechanism: no counters,
 * no confidence, no automation. Definitions are hand-built to the shape
 * `ctx.tools.register` consumes (standard JSON Schema with a root-level
 * `required` array, docs/FAQ.md #2). Host API shapes are declared locally;
 * the plugin imports nothing from DSH at runtime.
 */
import { cwdOf } from "./memory-section.js";
import { skillUsagePartition } from "./skill-rules.js";
import type { MemoryStore, SkillRecord } from "./store.js";
import type { ToolsService, ToolDefinition } from "./memory-tools.js";

export type { ToolsService, ToolDefinition };

function textTool(
	name: string,
	description: string,
	parameters: Record<string, unknown>,
	execute: (args: Record<string, unknown>, exec: ToolExec) => Promise<string>,
): ToolDefinition {
	return {
		name,
		description,
		parameters,
		output: {
			schema: {
				type: "object",
				properties: { text: { type: "string", description: "结果说明" } },
				required: ["text"],
				additionalProperties: false,
			},
			render: (_args, value) => [{ type: "text", text: value.text ?? "" }],
		},
		execute: async (args, exec) => ({ text: await execute(args, exec) }),
	};
}

/** Minimal tool execution context (duck-typed host surface). */
interface ToolExec {
	agent?: unknown;
}

/** The calling agent's session id (provenance for the ledger). */
function sessionIdOf(exec: ToolExec): string | undefined {
	const id = (exec as { agent?: { id?: unknown } } | undefined)?.agent?.id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

const SKILL_WRITE_PARAMETERS = {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: ["create", "update", "delete", "move-to-global"],
			description:
				"create 在本项目新建技能；update 更新已有技能（只给要改的字段）；delete 删除技能；move-to-global 把本项目技能手动搬到全局（项目侧归档，没有自动晋升）。",
		},
		scope: {
			type: "string",
			enum: ["project", "global"],
			description: "update/delete 的目标分区（默认 project；全局行只可显式指定 global 更新或删除）。",
		},
		id: {
			type: "string",
			description: "短横线小写标识。update/delete/move-to-global 必填；create 可省略（从 title 推导，中文标题会得到哈希后缀）。",
		},
		title: { type: "string", description: "短标题（create 必填）。" },
		description: {
			type: "string",
			description: "一句话触发钩子——决定未来会话会不会想起这个技能（create 必填，会进 SKILL.md 的 description）。",
		},
		body: { type: "string", description: "技能正文（create 必填；update 时传新正文整体替换）。" },
	},
	required: ["action"],
	additionalProperties: false,
} as const;

const SKILL_READ_PARAMETERS = {
	type: "object",
	properties: {
		id: { type: "string", description: "按 id 直取一条技能的完整内容（同名时项目遮蔽全局）。" },
		query: { type: "string", description: "关键词检索（不传 id 时生效；不传 query 则列出本项目与全局技能）。" },
		limit: { type: "number", description: "检索/列出的最大条数，默认 3，上限 10。" },
	},
	additionalProperties: false,
} as const;

/**
 * Register the skill tools and return a disposer that removes them (the
 * host may return one; call only the functions among whatever comes back).
 */
export function registerSkillTools(tools: ToolsService, store: MemoryStore): () => void {
	const disposers: unknown[] = [];
	disposers.push(
		tools.register(
			textTool(
				"skill_write",
				"写入可复用的技能（create 新建 / update 更新 / delete 删除 / move-to-global 手动搬到全局）。用户明确要求沉淀技能时使用；技能只在本项目创建，全局只接受手动搬家，由插件代码校验后落库并物化为 SKILL.md。",
				SKILL_WRITE_PARAMETERS,
				async (args, exec) => {
					const cwd = cwdOf(exec.agent);
					if (cwd === undefined) {
						return "错误：当前会话没有可用的工作区路径，无法写入技能。";
					}
					const action = args.action as "create" | "update" | "delete" | "move-to-global";
					const { outcomes, warnings } = store.applySkillProposals(
						{ workspaceId: cwd, trigger: "explicit", sessionId: sessionIdOf(exec) },
						[
							{
								action,
								scope: typeof args.scope === "string" ? args.scope : undefined,
								id: typeof args.id === "string" ? args.id : undefined,
								title: typeof args.title === "string" ? args.title : undefined,
								description: typeof args.description === "string" ? args.description : undefined,
								body: typeof args.body === "string" ? args.body : undefined,
							},
						],
					);
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
				},
			),
		),
	);
	disposers.push(
		tools.register(
			textTool(
				"skill_read",
				"读取技能：按 id 取一条的完整内容，或按关键词检索本项目与全局的技能（同名时项目遮蔽全局，只返回项目那条）。",
				SKILL_READ_PARAMETERS,
				async (args, exec) => {
					const cwd = cwdOf(exec.agent);
					if (cwd === undefined) {
						return "错误：当前会话没有可用的工作区路径，无法读取技能。";
					}
					const limit = clampLimit(args.limit);
					if (typeof args.id === "string" && args.id.length > 0) {
						const found = readWithScope(store, cwd, args.id);
						if (found === undefined) {
							return `没有找到 id 为 "${args.id}" 的技能。`;
						}
						// Consulted set: a body served by id means the model opened
						// it for the task at hand. Search/list hits are noise
						// and stay uncounted; human card previews never count.
						store.recordSkillUse(skillUsagePartition(found.scope, cwd), found.record.id, found.scope);
						return formatSkill(found.record, found.scope);
					}
					const query = typeof args.query === "string" ? args.query : "";
					const merged = query.length > 0 ? searchWithScope(store, cwd, query, limit) : listWithScope(store, cwd, limit);
					if (merged.length === 0) {
						return query.length > 0 ? `没有匹配 "${query}" 的技能。` : "本项目和全局都还没有技能。";
					}
					return merged.map((entry) => formatSkill(entry.record, entry.scope)).join("\n\n---\n\n");
				},
			),
		),
	);
	return () => {
		for (const disposer of disposers) {
			if (typeof disposer === "function") {
				disposer();
			}
		}
	};
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

function clampLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 3;
	}
	return Math.min(10, Math.max(1, Math.floor(value)));
}

/** Full skill text: header line with scope, then the body. */
function formatSkill(record: { id: string; title: string; description: string; body: string; updatedAt: string; status: string }, scope: string): string {
	return [`# ${record.title}`, `id: ${record.id} ｜ 范围: ${scope === "global" ? "全局" : "本项目"} ｜ 状态: ${record.status} ｜ 更新: ${record.updatedAt}`, `钩子: ${record.description}`, "", record.body].join("\n");
}
