/**
 * The model-facing memory tools: `memory_write` (the explicit write path
 * through the store's gates) and `memory_read` (bodies and search — the
 * injected index carries hooks only).
 *
 * The definitions are hand-built to the shape `ctx.tools.register` consumes
 * (the same object the host's `defineTool` would emit): standard JSON Schema
 * with a root-level `required` array — the raw-register path forwards
 * `parameters` to the API verbatim, where property-level `required: true`
 * is invalid (docs/FAQ.md #2). Host API shapes are declared locally, per the
 * architecture standard; the plugin imports nothing from DSH at runtime.
 */
import { cwdOf } from "./memory-section.js";
import type { MemoryStore } from "./store.js";

/** Minimal slice of the host tools service. */
export interface ToolsService {
	register(definition: unknown): unknown;
}

/** Minimal tool execution context (duck-typed host surface). */
interface ToolExec {
	agent?: unknown;
}

/** A registered tool definition, exactly as the host's `defineTool` emits. */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	output: {
		schema: Record<string, unknown>;
		render(args: unknown, value: { text?: string }): { type: string; text: string }[];
	};
	execute(args: Record<string, unknown>, exec: ToolExec): Promise<{ text: string }>;
}

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

/** The calling agent's session id (provenance for the ledger). */
function sessionIdOf(exec: ToolExec): string | undefined {
	const id = (exec as { agent?: { id?: unknown } } | undefined)?.agent?.id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

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
 */
export function registerMemoryTools(tools: ToolsService, store: MemoryStore): () => void {
	const disposers: unknown[] = [];
	disposers.push(
		tools.register(
			textTool(
				"memory_write",
				"写入持久记忆（create 新建 / update 更新 / delete 删除）。用户明确要求记住或忘记时使用；记忆按当前工作区分区存储，由插件代码校验后落库。",
				MEMORY_WRITE_PARAMETERS,
				async (args, exec) => {
					const cwd = cwdOf(exec.agent);
					if (cwd === undefined) {
						return "错误：当前会话没有可用的工作区路径，无法写入记忆。";
					}
					const [outcome] = store.applyProposals(
						{ workspaceId: cwd, trigger: "explicit", sessionId: sessionIdOf(exec) },
						[
							{
								action: args.action as "create" | "update" | "delete",
								id: typeof args.id === "string" ? args.id : undefined,
								type: typeof args.type === "string" ? args.type : undefined,
								title: typeof args.title === "string" ? args.title : undefined,
								description: typeof args.description === "string" ? args.description : undefined,
								body: typeof args.body === "string" ? args.body : undefined,
							},
						],
					);
					if (outcome === undefined || !outcome.ok) {
						return `写入被门禁拒绝，记忆未落盘：${outcome?.reason ?? "未知原因"}`;
					}
					if (outcome.action === "delete") {
						return `已删除记忆 \`${outcome.id}\`。旧内容保留在审计账本中，可由用户恢复。`;
					}
					return `已${outcome.action === "create" ? "写入" : "更新"}记忆 \`${outcome.id}\`（本工作区）。下次会话的注入索引会包含它。`;
				},
			),
		),
	);
	disposers.push(
		tools.register(
			textTool(
				"memory_read",
				"读取持久记忆：按 id 取一条的完整正文，或按关键词检索本工作区的记忆（注入的索引只有钩子，需要正文时用它）。",
				MEMORY_READ_PARAMETERS,
				async (args, exec) => {
					const cwd = cwdOf(exec.agent);
					if (cwd === undefined) {
						return "错误：当前会话没有可用的工作区路径，无法读取记忆。";
					}
					const limit = clampLimit(args.limit);
					if (typeof args.id === "string" && args.id.length > 0) {
						const record = store.get(cwd, args.id);
						return record === undefined ? `没有找到 id 为 "${args.id}" 的记忆。` : formatRecord(record);
					}
					const query = typeof args.query === "string" ? args.query : "";
					const records = query.length > 0 ? store.search(cwd, query, limit) : store.list(cwd).slice(0, limit);
					if (records.length === 0) {
						return query.length > 0 ? `没有匹配 "${query}" 的记忆。` : "本工作区还没有记忆。";
					}
					return records.map(formatRecord).join("\n\n---\n\n");
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

function clampLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return 3;
	}
	return Math.min(10, Math.max(1, Math.floor(value)));
}

/** Full record text: header line, then the body the index omitted. */
function formatRecord(record: {
	id: string;
	title: string;
	type: string;
	description: string;
	body: string;
	updatedAt: string;
	status: string;
}): string {
	return [
		`# ${record.title}`,
		`id: ${record.id} ｜ 类型: ${record.type} ｜ 状态: ${record.status} ｜ 更新: ${record.updatedAt}`,
		`钩子: ${record.description}`,
		"",
		record.body,
	].join("\n");
}
