/**
 * The model-facing skill tools: `skill_write` (the explicit write path
 * through the store's gates, plus the manual move to the global scope) and
 * `skill_read` (bodies and search across the project partition and the
 * global scope, project shadowing global on name collisions).
 *
 * P3 shape: thin shims over the unified `evolve_*` core
 * (`./evolve-tools.js`) — names, schemas, and reply texts stay identical so
 * existing callers observe no change; every call forwards with
 * `kind: "skill"`. The canonical logic lives in the core exactly once.
 *
 * Skills are created in the project only — global rows arise solely from an
 * explicit `move-to-global`. There is no promotion mechanism: no counters,
 * no confidence, no automation. Definitions are hand-built to the shape
 * `ctx.tools.register` consumes (standard JSON Schema with a root-level
 * `required` array, docs/FAQ.md #2). Host API shapes are declared locally;
 * the plugin imports nothing from DSH at runtime.
 */
import { cwdOf } from "./memory-section.js";
import { executeEvolveRead, executeEvolveWrite, sessionIdOf, type ToolDefinition, type ToolsService } from "./evolve-tools.js";
import type { MemoryStore } from "./store.js";

export type { ToolsService, ToolDefinition };

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
 * @param tools - The host tools service.
 * @param store - The open central store.
 * @returns A disposer that removes both shim tools.
 */
export function registerSkillTools(tools: ToolsService, store: MemoryStore): () => void {
	const disposers: unknown[] = [];
	disposers.push(
		tools.register({
			name: "skill_write",
			description:
				"写入可复用的技能（create 新建 / update 更新 / delete 删除 / move-to-global 手动搬到全局）。用户明确要求沉淀技能时使用；技能只在本项目创建，全局只接受手动搬家，由插件代码校验后落库并物化为 SKILL.md。",
			parameters: SKILL_WRITE_PARAMETERS,
			output: {
				schema: {
					type: "object",
					properties: { text: { type: "string", description: "结果说明" } },
					required: ["text"],
					additionalProperties: false,
				},
				render: (_args: unknown, value: { text?: string }) => [{ type: "text", text: value.text ?? "" }],
			},
			execute: async (args: Record<string, unknown>, exec: { agent?: unknown }) => ({
				text: (() => {
					const cwd = cwdOf(exec.agent);
					if (cwd === undefined) {
						return "错误：当前会话没有可用的工作区路径，无法写入技能。";
					}
					return executeEvolveWrite(store, cwd, sessionIdOf(exec), {
						kind: "skill",
						action: typeof args.action === "string" ? args.action : "",
						scope: typeof args.scope === "string" ? args.scope : undefined,
						id: typeof args.id === "string" ? args.id : undefined,
						title: typeof args.title === "string" ? args.title : undefined,
						description: typeof args.description === "string" ? args.description : undefined,
						body: typeof args.body === "string" ? args.body : undefined,
					});
				})(),
			}),
		} satisfies ToolDefinition),
	);
	disposers.push(
		tools.register({
			name: "skill_read",
			description: "读取技能：按 id 取一条的完整内容，或按关键词检索本项目与全局的技能（同名时项目遮蔽全局，只返回项目那条）。",
			parameters: SKILL_READ_PARAMETERS,
			output: {
				schema: {
					type: "object",
					properties: { text: { type: "string", description: "结果说明" } },
					required: ["text"],
					additionalProperties: false,
				},
				render: (_args: unknown, value: { text?: string }) => [{ type: "text", text: value.text ?? "" }],
			},
			execute: async (args: Record<string, unknown>, exec: { agent?: unknown }) => ({
				text: (() => {
					const cwd = cwdOf(exec.agent);
					if (cwd === undefined) {
						return "错误：当前会话没有可用的工作区路径，无法读取技能。";
					}
					return executeEvolveRead(store, cwd, {
						kind: "skill",
						id: typeof args.id === "string" ? args.id : undefined,
						query: typeof args.query === "string" ? args.query : undefined,
						limit: args.limit,
					});
				})(),
			}),
		} satisfies ToolDefinition),
	);
	return () => {
		for (const disposer of disposers) {
			if (typeof disposer === "function") {
				disposer();
			}
		}
	};
}
