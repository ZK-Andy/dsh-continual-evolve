/**
 * The model-facing memory tools: `memory_write` (the explicit write path
 * through the store's gates) and `memory_read` (bodies and search — the
 * injected index carries hooks only).
 *
 * P3 shape: thin shims over the unified `evolve_*` core
 * (`./evolve-tools.js`) — names, schemas, and reply texts stay identical so
 * existing callers observe no change; every call forwards with
 * `kind: "memory"`. The canonical logic (gates, reads, formatting) lives in
 * the core exactly once.
 *
 * The definitions are hand-built to the shape `ctx.tools.register` consumes
 * (the same object the host's `defineTool` would emit): standard JSON Schema
 * with a root-level `required` array — the raw-register path forwards
 * `parameters` to the API verbatim, where property-level `required: true`
 * is invalid (docs/FAQ.md #2). Host API shapes are declared locally, per the
 * architecture standard; the plugin imports nothing from DSH at runtime.
 */
import { cwdOf } from "./memory-section.js";
import { executeEvolveRead, executeEvolveWrite, sessionIdOf, type ToolDefinition, type ToolsService } from "./evolve-tools.js";
import type { MemoryStore } from "./store.js";

export type { ToolsService, ToolDefinition };
export type { ToolExec } from "./evolve-tools.js";

const MEMORY_WRITE_PARAMETERS = {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: ["create", "update", "delete"],
			description: "create 新建记忆；update 更新已有条目（只给要改的字段）；delete 删除条目。",
		},
		id: {
			type: "string",
			description: "短横线小写标识（kebab slug）。update/delete 必填；create 可省略（从 title 推导，中文标题会得到哈希后缀）。",
		},
		type: {
			type: "string",
			enum: ["user", "feedback", "reference"],
			description: "记忆类型：user 用户画像与环境事实；feedback 用户纠正/确认的做法规则（正文必带 **Why:** 与 **How to apply:** 两行）；reference 未来会用的资源指针。",
		},
		title: { type: "string", description: "短标题（create 必填）。" },
		description: {
			type: "string",
			description: "一句话相关性钩子——决定未来会话会不会想起这条记忆（create 必填）。",
		},
		body: { type: "string", description: "正文（create 必填；update 时传新正文整体替换）。" },
	},
	required: ["action"],
	additionalProperties: false,
} as const;

const MEMORY_READ_PARAMETERS = {
	type: "object",
	properties: {
		id: { type: "string", description: "按 id 直取一条记忆的完整内容。" },
		query: { type: "string", description: "关键词检索（不传 id 时生效；不传 query 则列出最近记忆）。" },
		limit: { type: "number", description: "检索/列出的最大条数，默认 3，上限 10。" },
	},
	additionalProperties: false,
} as const;

/**
 * Register the memory tools and return a disposer that removes them (the
 * host may return one; call only the functions among whatever comes back).
 * @param tools - The host tools service.
 * @param store - The open central store.
 * @returns A disposer that removes both shim tools.
 */
export function registerMemoryTools(tools: ToolsService, store: MemoryStore): () => void {
	const disposers: unknown[] = [];
	disposers.push(
		tools.register({
			name: "memory_write",
			description:
				"写入持久记忆（create 新建 / update 更新 / delete 删除）。用户明确要求记住或忘记时使用；记忆按当前工作区分区存储，由插件代码校验后落库。",
			parameters: MEMORY_WRITE_PARAMETERS,
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
						return "错误：当前会话没有可用的工作区路径，无法写入记忆。";
					}
					return executeEvolveWrite(store, cwd, sessionIdOf(exec), {
						kind: "memory",
						action: typeof args.action === "string" ? args.action : "",
						id: typeof args.id === "string" ? args.id : undefined,
						type: typeof args.type === "string" ? args.type : undefined,
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
			name: "memory_read",
			description: "读取持久记忆：按 id 取一条的完整正文，或按关键词检索本工作区的记忆（注入的索引只有钩子，需要正文时用它）。",
			parameters: MEMORY_READ_PARAMETERS,
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
						return "错误：当前会话没有可用的工作区路径，无法读取记忆。";
					}
					return executeEvolveRead(store, cwd, {
						kind: "memory",
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
