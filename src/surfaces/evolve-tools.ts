/**
 * The unified model-facing tools: `evolve_write` (one write path for every
 * managed object, `kind` selects the object) and `evolve_read` (one read
 * path). Kind-specific logic lives once in `./evolve-memory.js`,
 * `./evolve-skills.js`, and `./evolve-prompts.js`; this file only
 * dispatches on `kind`.
 *
 * Definitions are hand-built to the shape `ctx.tools.register` consumes
 * (standard JSON Schema with a root-level `required` array — the
 * raw-register path forwards `parameters` to the API verbatim, where
 * property-level `required: true` is invalid, docs/FAQ.md #2). Host API
 * shapes are declared locally, per the architecture standard; the plugin
 * imports nothing from DSH at runtime.
 */
import { readMemoryRecords, writeMemoryRecord } from "./evolve-memory.js";
import { readPromptRecords, writePromptRecord } from "./evolve-prompts.js";
import { readSkillRecords, writeSkillRecord } from "./evolve-skills.js";
import { stringField } from "./evolve-fields.js";
import { cwdOf } from "../services/agent.js";
import type { MemoryStore } from "../store.js";

/** Minimal slice of the host tools service. */
export interface ToolsService {
	register(definition: unknown): unknown;
}

/** Minimal tool execution context (duck-typed host surface). */
export interface ToolExec {
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

/**
 * The calling agent's session id (provenance for the ledger).
 * @param exec - The host tool execution context.
 * @returns The session id, or undefined when the host carries none.
 */
export function sessionIdOf(exec: ToolExec): string | undefined {
	const id = (exec as { agent?: { id?: unknown } } | undefined)?.agent?.id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Managed object kinds the unified tools speak. */
export const EVOLVE_KINDS = ["memory", "skill", "prompt"] as const;
/** A managed object kind. */
export type EvolveKind = (typeof EVOLVE_KINDS)[number];

/** Whether `kind` names a managed object. */
function isEvolveKind(value: unknown): value is EvolveKind {
	return value === "memory" || value === "skill" || value === "prompt";
}

/** The user-facing noun for a kind (tool replies and errors). */
function kindNoun(kind: EvolveKind): string {
	return kind === "memory" ? "记忆" : kind === "skill" ? "技能" : "提示词补充";
}

const EVOLVE_WRITE_PARAMETERS = {
	type: "object",
	properties: {
		kind: {
			type: "string",
			enum: ["memory", "skill", "prompt"],
			description: "管理对象：memory 持久记忆 / skill 可复用技能 / prompt 提示词补充（本工作区）。",
		},
		action: {
			type: "string",
			enum: ["create", "update", "delete", "move-to-global"],
			description:
				"create 新建；update 更新已有条目（只给要改的字段）；delete 删除；move-to-global 把本项目技能手动搬到全局（仅 skill 可用）。",
		},
		scope: {
			type: "string",
			enum: ["project", "global"],
			description: "skill update/delete 的目标分区（默认 project；memory 忽略此字段）。",
		},
		id: {
			type: "string",
			description: "短横线小写标识。update/delete/move-to-global 必填；create 可省略（从 title 推导）。",
		},
		type: {
			type: "string",
			enum: ["user", "feedback", "reference"],
			description: "记忆类型（仅 kind=memory 时有效；feedback 正文必带 **Why:** 与 **How to apply:** 两行）。",
		},
		title: { type: "string", description: "短标题（create 必填）。" },
		description: { type: "string", description: "一句话触发钩子（create 必填）。" },
		body: { type: "string", description: "正文（create 必填；update 时传新正文整体替换）。" },
	},
	required: ["kind", "action"],
	additionalProperties: false,
} as const;

const EVOLVE_READ_PARAMETERS = {
	type: "object",
	properties: {
		kind: {
			type: "string",
			enum: ["memory", "skill", "prompt"],
			description: "管理对象：memory 持久记忆 / skill 可复用技能（同名时项目遮蔽全局）/ prompt 提示词补充（本工作区）。",
		},
		id: { type: "string", description: "按 id 直取一条的完整内容。" },
		query: { type: "string", description: "关键词检索（不传 id 时生效；不传 query 则列目录）。" },
		limit: { type: "number", description: "检索/列出的最大条数，默认 3，上限 10。" },
	},
	required: ["kind"],
	additionalProperties: false,
} as const;

/** Arguments the unified write executor accepts (workspace already resolved). */
export interface EvolveWriteArgs {
	kind: string;
	action: string;
	scope?: string | undefined;
	id?: string | undefined;
	type?: string | undefined;
	title?: string | undefined;
	description?: string | undefined;
	body?: string | undefined;
}

/** Arguments the unified read executor accepts (workspace already resolved). */
export interface EvolveReadArgs {
	kind: string;
	id?: string | undefined;
	query?: string | undefined;
	limit?: unknown;
}

/**
 * Run one unified write against the store (workspace already resolved).
 * @param store - The open central store.
 * @param workspaceId - The calling session's workspace partition.
 * @param sessionId - The calling session id, for ledger provenance.
 * @param args - The kind-dispatched write arguments.
 * @returns The human-facing result text (same wording as the old tools).
 */
export function executeEvolveWrite(
	store: MemoryStore,
	workspaceId: string,
	sessionId: string | undefined,
	args: EvolveWriteArgs,
): string {
	if (!isEvolveKind(args.kind)) {
		return `不支持的 kind ${JSON.stringify(args.kind)}：仅支持 memory / skill / prompt。`;
	}
	if (args.kind === "memory") {
		return writeMemoryRecord(store, workspaceId, sessionId, args);
	}
	if (args.kind === "skill") {
		return writeSkillRecord(store, workspaceId, sessionId, args);
	}
	return writePromptRecord(store, workspaceId, sessionId, args);
}

/**
 * Run one unified read against the store (workspace already resolved).
 * @param store - The open central store.
 * @param workspaceId - The calling session's workspace partition.
 * @param args - The kind-dispatched read arguments.
 * @returns The human-facing result text (same wording as the old tools).
 */
export function executeEvolveRead(store: MemoryStore, workspaceId: string, args: EvolveReadArgs): string {
	if (!isEvolveKind(args.kind)) {
		return `不支持的 kind ${JSON.stringify(args.kind)}：仅支持 memory / skill / prompt。`;
	}
	if (args.kind === "memory") {
		return readMemoryRecords(store, workspaceId, args);
	}
	if (args.kind === "skill") {
		return readSkillRecords(store, workspaceId, args);
	}
	return readPromptRecords(store, workspaceId, args);
}

/**
 * Register the unified tools and return a disposer that removes them.
 * @param tools - The host tools service.
 * @param store - The open central store.
 * @returns A disposer that removes both tools.
 */
export function registerEvolveTools(tools: ToolsService, store: MemoryStore): () => void {
	const disposers: unknown[] = [];
	disposers.push(
		tools.register(
			textTool(
				"evolve_write",
				"写入一条管理对象（kind=memory 持久记忆 / kind=skill 可复用技能 / kind=prompt 提示词补充）。用户明确要求记住、忘掉、沉淀技能或补充提示时使用；记忆与提示词补充按当前工作区分区存储，技能只在本项目创建（move-to-global 手动搬到全局），由插件代码校验后落库。",
				EVOLVE_WRITE_PARAMETERS,
				async (args, exec) => {
					if (!isEvolveKind(args.kind)) {
						return `错误：kind 必须是 memory / skill / prompt 之一。`;
					}
					const cwd = cwdOf(exec.agent);
					if (cwd === undefined) {
						return `错误：当前会话没有可用的工作区路径，无法写入${kindNoun(args.kind)}。`;
					}
					return executeEvolveWrite(store, cwd, sessionIdOf(exec), {
						kind: args.kind,
						action: typeof args.action === "string" ? args.action : "",
						scope: stringField(args.scope),
						id: stringField(args.id),
						type: stringField(args.type),
						title: stringField(args.title),
						description: stringField(args.description),
						body: stringField(args.body),
					});
				},
			),
		),
	);
	disposers.push(
		tools.register(
			textTool(
				"evolve_read",
				"读取一条管理对象：按 id 取完整正文，或按关键词检索（kind=memory 只看本工作区；kind=skill 看本项目与全局，同名时项目遮蔽全局；kind=prompt 只看本工作区）。",
				EVOLVE_READ_PARAMETERS,
				async (args, exec) => {
					if (!isEvolveKind(args.kind)) {
						return `错误：kind 必须是 memory / skill / prompt 之一。`;
					}
					const cwd = cwdOf(exec.agent);
					if (cwd === undefined) {
						return `错误：当前会话没有可用的工作区路径，无法读取${kindNoun(args.kind)}。`;
					}
					return executeEvolveRead(store, cwd, {
						kind: args.kind,
						id: stringField(args.id),
						query: stringField(args.query),
						limit: args.limit,
					});
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
