/**
 * Model-facing evolve_* tools. The model supplies content; every guarantee
 * (validation, snapshot, versioning, history, rollback) is code-enforced in
 * the engine. `global: true` is required explicitly for cross-session edits.
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { HarnessScope, RefinementEdit, RefinementKind } from "./types.js";
import type { EvolutionEngine } from "./service.js";
import { formatHarnessStateForPrompt } from "./render.js";
import { requireGlobalApproval } from "./approval.js";
import { CONFLICT_WARN_SCORE, buildConflictNotice, mostSimilarEntry } from "./promotion.js";
import { entrySourceOf } from "./source.js";
import { getUsageCount, loadUsage } from "./usage.js";
import { buildEvolveCompleteEvent, emitEvolveComplete } from "./evolve-event.js";

const SCOPES: HarnessScope[] = ["local", "global"];

/** Minimal structural view of the tool execution context (agent is optional). */
interface ToolExec {
	agent?: { id: string; session?: { events?: readonly unknown[] } };
}

/** Accept both the boolean tool parameter (`global: true`) and the string form. */
export function scopeOf(value: unknown, fallback: HarnessScope): HarnessScope {
	return value === "global" || value === true ? "global" : fallback;
}

/** The calling agent's session id; tools always run inside an agent scope. */
function sessionIdOf(exec: ToolExec): string | undefined {
	return exec.agent?.id;
}

function textResult(text: string) {
	return { text };
}

export interface ToolGateOptions {
	requireGlobalApproval: boolean;
}

export function registerEvolveTools(ctx: Context, engine: EvolutionEngine, opts: ToolGateOptions): void {
	ctx.tools.register(
		defineTool({
			name: "evolve_list",
			description:
				"List the continual harness state (prompt notes, memories, skills, subagent specs) for the current session (local) or across sessions (global).",
			parameters: {
				scope: {
					type: "string",
					enum: SCOPES,
					description: "Which store to list: 'local' (default) or 'global'.",
				},
			},
			output: {
				schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text ?? "" }],
			},
			execute: async (args, exec) => {
				const scope = scopeOf(args.scope, "local");
				const state = engine.load(scope, sessionIdOf(exec));
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
			name: "evolve_add",
			description:
				"Create one harness entry (prompt/memory/skill/subagent). Executable skills require reference {type:python, import, callable} and an arguments contract; guidance skills (skill_kind=guidance) are SKILL.md documents — recurring multi-step workflows — and must NOT carry a reference. Snapshot, version, and history are handled automatically.",
			parameters: {
				kind: { type: "string", enum: ["prompt", "memory", "skill", "subagent"], required: true, description: "Entry kind." },
				title: { type: "string", required: true, description: "Stable title." },
				content: { type: "string", required: true, description: "Entry body." },
				path: { type: "string", description: "Optional grouping path." },
				skill_kind: { type: "string", enum: ["executable", "guidance"], description: "For skills: executable (python reference, default) or guidance (SKILL.md document, no reference)." },
				reference: { type: "object", additionalProperties: true, description: "For executable skills: {type:'python', import, callable}." },
				arguments: { type: "object", additionalProperties: true, description: "For executable skills: accepted input contract." },
				global: { type: "boolean", description: "Set true to write the cross-session store (requires human approval; only for durable, reusable lessons)." },
			},
			output: {
				schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text ?? "" }],
			},
			execute: async (args, exec) => {
				const scope = scopeOf(args.global, "local");
				if (scope === "global" && opts.requireGlobalApproval) {
					// Informed approval: surface a similarity hit against the
					// existing global store BEFORE the human decides — the
					// engine's write-time guard still has the final say.
					const globalState = engine.load("global", undefined);
					const hit = mostSimilarEntry(Object.values(globalState.entries[args.kind as RefinementKind]), args.title ?? "", args.content ?? "", CONFLICT_WARN_SCORE);
					const conflictNote = hit ? ` ⚠️ ${buildConflictNotice(hit)}——建议改用 evolve_update` : "";
					await requireGlobalApproval(ctx, exec.agent, exec.signal, `evolve_add ${args.kind} "${args.title}" → 跨会话全局 store${conflictNote}`);
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
				return textResult(applyEditsText(engine, scope, sessionIdOf(exec), [edit], exec.agent));
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
				global: { type: "boolean", description: "Set true to edit the cross-session store (requires human approval)." },
			},
			output: {
				schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text ?? "" }],
			},
			execute: async (args, exec) => {
				const scope = scopeOf(args.global, "local");
				if (scope === "global" && opts.requireGlobalApproval) {
					await requireGlobalApproval(ctx, exec.agent, exec.signal, `evolve_update ${args.kind}:${args.id} → 跨会话全局 store`);
				}
				const edit: RefinementEdit = { action: "update", kind: args.kind as RefinementKind, id: args.id };
				if (args.title !== undefined) edit.title = args.title;
				if (args.content !== undefined) edit.content = args.content;
				return textResult(applyEditsText(engine, scope, sessionIdOf(exec), [edit], exec.agent));
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "evolve_delete",
			description: "Delete one harness entry by id.",
			parameters: {
				kind: { type: "string", enum: ["prompt", "memory", "skill", "subagent"], required: true },
				id: { type: "string", required: true },
				global: { type: "boolean", description: "Set true to edit the cross-session store (requires human approval)." },
			},
			output: {
				schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text ?? "" }],
			},
			execute: async (args, exec) => {
				const scope = scopeOf(args.global, "local");
				if (scope === "global" && opts.requireGlobalApproval) {
					await requireGlobalApproval(ctx, exec.agent, exec.signal, `evolve_delete ${args.kind}:${args.id} → 跨会话全局 store`);
				}
				const edit: RefinementEdit = { action: "delete", kind: args.kind as RefinementKind, id: args.id };
				return textResult(applyEditsText(engine, scope, sessionIdOf(exec), [edit], exec.agent));
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "evolve_rollback",
			description: "Deterministically revert a previous refinement by its id (from evolve_list history or the /evolve command).",
			parameters: {
				refinementId: { type: "string", required: true, description: "The refinement id to roll back." },
				global: { type: "boolean", description: "Set true to roll back a cross-session refinement." },
			},
			output: {
				schema: { type: "object", additionalProperties: false, properties: { text: { type: "string", required: true } } },
				render: (_args, value) => [{ type: "text", text: value.text ?? "" }],
			},
			execute: async (args, exec) => {
				const scope = scopeOf(args.global, "local");
				const result = engine.rollback(scope, sessionIdOf(exec), args.refinementId);
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
	sessionId: string | undefined,
	edits: RefinementEdit[],
	agent?: ToolExec["agent"],
): string {
	const result = engine.apply(
		scope,
		sessionId,
		{
			summary: "Direct tool edit",
			rationale: "Model-invoked single edit via evolve_* tool.",
			expectedOutcome: "Entry is created, updated, or deleted as requested.",
			edits,
		},
		agent
			? {
					scope,
					...(entrySourceOf(agent, sessionId) ? { source: entrySourceOf(agent, sessionId) } : {}),
				}
			: { scope },
	);
	const applied = result.appliedEdits.filter((e) => e.applied);
	const failed = result.appliedEdits.filter((e) => !e.applied);
	// Gap C4: emit structured evolve_complete event for third-party consumers.
	if (applied.length > 0 && sessionId) {
		emitEvolveComplete(engine.baseDir, buildEvolveCompleteEvent(result, "manual_tool", sessionId));
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
