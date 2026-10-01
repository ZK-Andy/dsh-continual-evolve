/**
 * Model-facing evolve_* tools. The model supplies content; every guarantee
 * (validation, snapshot, versioning, history, rollback) is code-enforced in
 * the engine. `global: true` is required explicitly for cross-session edits.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { RecordLanguagePreference } from "./record-language.js";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { HarnessScope, RefinementEdit, RefinementKind } from "./types.js";
import { MEMORY_TYPE_KEY } from "./types.js";
import type { EvolutionEngine } from "./service.js";
import { projectKeyOf } from "./project.js";
import { formatHarnessStateForPrompt } from "./render.js";
import { requireGlobalApproval } from "./approval.js";
import { CONFLICT_WARN_SCORE, buildConflictNotice, mostSimilarEntry } from "./promotion.js";
import { entrySourceOf } from "./source.js";
import { formatRecallResult, recallMemories } from "./recall.js";
import { getUsageCount, loadUsage } from "./usage.js";
import { buildEvolveCompleteEvent, emitEvolveComplete } from "./evolve-event.js";
import { DEFAULT_REVIEWS_RETAIN } from "./store.js";

const SCOPES: HarnessScope[] = ["local", "project", "global"];

/**
 * Accept the string form (`scope: "project"`) with the legacy boolean tool
 * parameter (`global: true`) as fallback. `scope` wins when both are given.
 */
export function scopeOf(value: unknown, fallback: HarnessScope): HarnessScope {
	if (value === "global" || value === true) {
		return "global";
	}
	if (value === "project") {
		return "project";
	}
	return fallback;
}

/** The calling agent's session id; tools always run inside an agent scope. */
function sessionIdOf(exec: ToolRunContext): string | undefined {
	return exec.agent?.id;
}

/**
 * Collect the target ids for an evolve_delete call: legacy single `id`
 * plus the batch `ids` array, de-duplicated in first-seen order. Throws
 * loudly when neither carries an id — a silent no-op delete would look
 * like success while deleting nothing.
 *
 * @throws when both `id` and `ids` are absent or empty.
 */
export function collectDeleteIds(id: unknown, ids: unknown): string[] {
	const collected: string[] = [];
	if (typeof id === "string" && id.length > 0) collected.push(id);
	if (Array.isArray(ids)) {
		for (const item of ids) {
			if (typeof item === "string" && item.length > 0 && !collected.includes(item)) {
				collected.push(item);
			}
		}
	}
	if (collected.length === 0) {
		throw new Error("evolve_delete requires id or a non-empty ids array");
	}
	return collected;
}

/**
 * The store id a scope reads/writes: session id for local, derived project
 * key for project, undefined for global. Throws for project when the
 * session cwd is unavailable — fail loud instead of writing local-by-mistake.
 */
function storeIdFor(scope: HarnessScope, exec: ToolRunContext): string | undefined {
	if (scope === "local") {
		return sessionIdOf(exec);
	}
	if (scope === "project") {
		const key = projectKeyOf(exec.agent);
		if (!key) {
			throw new Error("project scope needs the session cwd (unavailable for this agent) — use local or global instead");
		}
		return key;
	}
	return undefined;
}

/** Human-approval gate shared by global and project writes (both cross-session). */
function needsApproval(scope: HarnessScope): boolean {
	return scope === "global" || scope === "project";
}

/** Store label used in approval prompts. */
function storeLabel(scope: HarnessScope): string {
	return scope === "project" ? "本项目跨会话 store" : "跨会话全局 store";
}

function textResult(text: string) {
	return { text };
}

export interface ToolGateOptions {
	requireGlobalApproval: boolean;
	/**
	 * Plugin `recordLanguage` preference for the approval dialog copy;
	 * `auto`/absent defers to the durable client preference and the session's
	 * own user text (see `approval.ts`).
	 */
	recordLanguage?: RecordLanguagePreference;
}

export function registerEvolveTools(ctx: Context, engine: EvolutionEngine, opts: ToolGateOptions): void {
	ctx.tools.register(
		defineTool({
			name: "evolve_list",
			description: "List the harness state (prompt notes, memories, skills, subagent specs) for one store.",
			parameters: {
				scope: {
					type: "string",
					enum: SCOPES,
					description: "'local' (default), 'project', or 'global'.",
				},
			},
			output: {
				schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text ?? "" }],
			},
			execute: async (args, exec) => {
				const scope = scopeOf(args.scope, "local");
				const state = engine.load(scope, storeIdFor(scope, exec));
				const text = formatHarnessStateForPrompt(state);
				// Append injection usage counts (gap B1).
				const usage = loadUsage(engine.baseDir);
				const usageLines: string[] = [];
				for (const kind of Object.keys(state.entries) as RefinementKind[]) {
					for (const entry of Object.values(state.entries[kind])) {
						const count = getUsageCount(usage, kind, entry.id);
						if (count > 0) {
							usageLines.push(`${kind}:${entry.id} — injected ${count}×`);
						}
					}
				}
				if (usageLines.length > 0) {
					return textResult(`${text}\n\n# Injection Usage\n${usageLines.join("\n")}`);
				}
				return textResult(text);
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "evolve_recall",
			description:
				"Read-only targeted recall across the harness stores: filter by query, kind, scope, and memory type; returns full content with version, source, and staleness signals. Prefer this over evolve_list when looking for something specific.",
			parameters: {
				query: { type: "string", description: "Free-text relevance query. Empty → most-recently-updated first." },
				kinds: {
					type: "array",
					items: { type: "string" },
					description: "Entry kinds (default memory only).",
				},
				scopes: {
					type: "array",
					items: { type: "string" },
					description: "Stores to search (default all three).",
				},
				memoryTypes: {
					type: "array",
					items: { type: "string" },
					description: "Memory types: user, feedback, project, reference.",
				},
				limit: { type: "number", description: "Max hits (default 10, max 50)." },
				includeArchived: { type: "boolean", description: "Include archived entries (default false)." },
			},
			output: {
				schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text ?? "" }],
			},
			execute: async (args, exec) => {
				const result = recallMemories(
					engine,
					{ sessionId: sessionIdOf(exec), projectKey: projectKeyOf(exec.agent) ?? undefined },
					{
						...(typeof args.query === "string" ? { query: args.query } : {}),
						...(Array.isArray(args.kinds) ? { kinds: args.kinds as RefinementKind[] } : {}),
						...(Array.isArray(args.scopes) ? { scopes: args.scopes as HarnessScope[] } : {}),
						...(Array.isArray(args.memoryTypes) ? { memoryTypes: args.memoryTypes as ("user" | "feedback" | "project" | "reference")[] } : {}),
						...(typeof args.limit === "number" ? { limit: args.limit } : {}),
						...(typeof args.includeArchived === "boolean" ? { includeArchived: args.includeArchived } : {}),
					},
				);
				return textResult(formatRecallResult(result, typeof args.query === "string" ? args.query : undefined));
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "evolve_add",
			description:
				"Create one harness entry (prompt/memory/skill/subagent). Snapshots, versioning, and audit are automatic.",
			parameters: {
				kind: { type: "string", enum: ["prompt", "memory", "skill", "subagent"], required: true, description: "Entry kind." },
				title: { type: "string", required: true, description: "Stable title." },
				content: { type: "string", required: true, description: "Entry body." },
				path: { type: "string", description: "Optional grouping path." },
				skill_kind: { type: "string", enum: ["executable", "guidance"], description: "Skills: executable (default, needs reference) or guidance (SKILL.md, no reference)." },
				reference: { type: "object", additionalProperties: true, description: "Executable skills: {type:'python', import, callable}." },
				arguments: { type: "object", additionalProperties: true, description: "Executable skills: accepted input contract." },
				memoryType: { type: "string", enum: ["user", "feedback", "project", "reference"], description: "Required for memory (feedback/project need Why + How to apply)." },
				scope: { type: "string", enum: SCOPES, description: "'local' (default), 'project', or 'global'." },
				global: { type: "boolean", description: "Shorthand for scope='global' (requires human approval)." },
			},
			output: {
				schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text ?? "" }],
			},
			execute: async (args, exec) => {
				const scope = scopeOf(args.scope ?? args.global, "local");
				// Resolve first: a project scope without a session cwd fails
				// here, before any human approval question is asked.
				const storeId = storeIdFor(scope, exec);
				if (needsApproval(scope) && opts.requireGlobalApproval) {
					// Informed approval: surface a similarity hit against the
					// target store BEFORE the human decides — the engine's
					// write-time guard still has the final say.
					const targetState = engine.load(scope, storeId);
					const hit = mostSimilarEntry(Object.values(targetState.entries[args.kind as RefinementKind]), args.title ?? "", args.content ?? "", CONFLICT_WARN_SCORE);
					const conflictNote = hit ? ` ⚠️ ${buildConflictNotice(hit)}——建议改用 evolve_update` : "";
					await requireGlobalApproval(ctx, exec.agent, exec.signal, `evolve_add ${args.kind} "${args.title}" → ${storeLabel(scope)}${conflictNote}`, opts.recordLanguage);
				}
				const edit: RefinementEdit = {
					action: "create",
					kind: args.kind as RefinementKind,
					title: args.title,
					content: args.content,
				};
				if (args.path !== undefined) edit.path = args.path;
				if (args.skill_kind !== undefined) edit.skill_kind = args.skill_kind;
				if (args.reference !== undefined) edit.reference = args.reference;
				if (args.arguments !== undefined) edit.arguments = args.arguments;
				if (args.kind === "memory" && args.memoryType !== undefined) {
					edit.metadata = { [MEMORY_TYPE_KEY]: args.memoryType };
				}
				return textResult(applyEditsText(engine, scope, storeId, [edit], exec.agent, sessionIdOf(exec)));
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "evolve_update",
			description: "Update one harness entry by id. Pass only the fields that change.",
			parameters: {
				kind: { type: "string", enum: ["prompt", "memory", "skill", "subagent"], required: true },
				id: { type: "string", required: true, description: "Existing entry id." },
				title: { type: "string" },
				content: { type: "string" },
				memoryType: { type: "string", enum: ["user", "feedback", "project", "reference"], description: "Memory: (re)classify the recall type." },
				scope: { type: "string", enum: SCOPES, description: "'local' (default), 'project', or 'global'." },
				global: { type: "boolean", description: "Shorthand for scope='global' (requires human approval)." },
			},
			output: {
				schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text ?? "" }],
			},
			execute: async (args, exec) => {
				const scope = scopeOf(args.scope ?? args.global, "local");
				const storeId = storeIdFor(scope, exec);
				if (needsApproval(scope) && opts.requireGlobalApproval) {
					await requireGlobalApproval(ctx, exec.agent, exec.signal, `evolve_update ${args.kind}:${args.id} → ${storeLabel(scope)}`, opts.recordLanguage);
				}
				const edit: RefinementEdit = { action: "update", kind: args.kind as RefinementKind, id: args.id };
				if (args.title !== undefined) edit.title = args.title;
				if (args.content !== undefined) edit.content = args.content;
				if (args.memoryType !== undefined) edit.metadata = { [MEMORY_TYPE_KEY]: args.memoryType };
				return textResult(applyEditsText(engine, scope, storeId, [edit], exec.agent, sessionIdOf(exec)));
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "evolve_delete",
			description:
				"Delete harness entries: `id` for one, `ids` for a batch (one refinement, one approval). Ids are addressed verbatim, scope-prefixed or not.",
			parameters: {
				kind: { type: "string", enum: ["prompt", "memory", "skill", "subagent"], required: true },
				id: { type: "string", description: "One entry id (or use ids for a batch)." },
				ids: {
					type: "array",
					items: { type: "string" },
					description: "Entry ids for one batch delete.",
				},
				scope: { type: "string", enum: SCOPES, description: "'local' (default), 'project', or 'global'." },
				global: { type: "boolean", description: "Shorthand for scope='global' (requires human approval)." },
			},
			output: {
				schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text ?? "" }],
			},
			execute: async (args, exec) => {
				const scope = scopeOf(args.scope ?? args.global, "local");
				const storeId = storeIdFor(scope, exec);
				const ids = collectDeleteIds(args.id, args.ids);
				if (needsApproval(scope) && opts.requireGlobalApproval) {
					await requireGlobalApproval(
						ctx,
						exec.agent,
						exec.signal,
						`evolve_delete ${args.kind}:${ids.length > 1 ? `${ids.length} entries (${ids.join(", ")})` : ids[0]} → ${storeLabel(scope)}`,
						opts.recordLanguage,
					);
				}
				const edits: RefinementEdit[] = ids.map((id) => ({ action: "delete", kind: args.kind as RefinementKind, id }));
				return textResult(applyEditsText(engine, scope, storeId, edits, exec.agent, sessionIdOf(exec)));
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "evolve_rollback",
			description: "Deterministically revert a previous refinement by its id (from evolve_list history or /evolve).",
			parameters: {
				refinementId: { type: "string", required: true, description: "Refinement id to roll back." },
				scope: { type: "string", enum: SCOPES, description: "'local' (default), 'project', or 'global'." },
				global: { type: "boolean", description: "Shorthand for scope='global'." },
			},
			output: {
				schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text ?? "" }],
			},
			execute: async (args, exec) => {
				const scope = scopeOf(args.scope ?? args.global, "local");
				const result = engine.rollback(scope, storeIdFor(scope, exec), args.refinementId);
				return textResult(
					`Rolled back ${result.rollbackOf ?? result.id}: ${result.appliedEdits.filter((e) => e.applied).length} edit(s) reverted.`,
				);
			},
		}),
	);
}

function applyEditsText(
	engine: EvolutionEngine,
	scope: HarnessScope,
	storeId: string | undefined,
	edits: RefinementEdit[],
	agent?: ToolRunContext["agent"],
	eventSessionId?: string | undefined,
): string {
	const result = engine.apply(
		scope,
		storeId,
		{
			summary: "Direct tool edit",
			rationale: "Model-invoked single edit via evolve_* tool.",
			expectedOutcome: "Entry is created, updated, or deleted as requested.",
			edits,
		},
		agent
			? {
					scope,
					...(entrySourceOf(agent, eventSessionId ?? storeId) ? { source: entrySourceOf(agent, eventSessionId ?? storeId) } : {}),
				}
			: { scope },
	);
	const applied = result.appliedEdits.filter((e) => e.applied);
	const failed = result.appliedEdits.filter((e) => !e.applied);
	// Gap C4: emit structured evolve_complete event for third-party consumers.
	// The event keys on the live session (not the project store key).
	const eventSession = eventSessionId ?? storeId;
	if (applied.length > 0 && eventSession) {
		emitEvolveComplete(engine.baseDir, buildEvolveCompleteEvent(result, "manual_tool", eventSession), engine.retention?.reviews ?? DEFAULT_REVIEWS_RETAIN);
	}
	const lines = [`refinement ${result.id}: ${applied.length} applied, ${failed.length} failed`];
	for (const e of applied) {
		lines.push(`- ${e.action} ${e.kind}:${e.id} (v${(e.after?.version ?? e.before?.version) ?? "?"})`);
	}
	for (const e of failed) {
		lines.push(`- failed ${e.action} ${e.kind}:${e.id ?? "(computed)"} — ${e.error ?? "unknown error"}`);
	}
	return lines.join("\n");
}
