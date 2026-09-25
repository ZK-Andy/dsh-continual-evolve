/**
 * Dedicated background memory extraction agent.
 *
 * This is the DSH counterpart of ZCode's project-memory agent loop. It keeps
 * an independent request history, exposes only a frozen memory manifest and a
 * structured proposal tool, and never writes state itself. Every accepted edit
 * is handed to EvolutionEngine so scope approval, snapshots, versioning,
 * rollback, and audit remain mandatory.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
	createAssistantMessage,
	createToolResultMessage,
	createUserMessage,
	type ContentBlock,
	type Message,
	type RequestMessage,
	type ToolCallBlock,
	type ToolSchema,
} from "@deepseek-ai/dsh-llm";
import { requestScopeApproval, type ScopeApprovalDecision } from "./approval.js";
import { streamModelTurn, type LlmSessionId } from "./llm-text.js";
import { EVOLVE_MESSAGE_SOURCE } from "./message-source.js";
import { extractJsonObject, parseJsonCandidate } from "./plan.js";
import { buildPrefixMessages, detectPlannerRoute, resolvePrefixCache, type PrefixCacheOptions } from "./prefix-cache.js";
import { compactText } from "./render.js";
import { buildConflictNotice, CONFLICT_WARN_SCORE, mostSimilarEntry } from "./promotion.js";
import { EvolutionApplyPostCommitError, type EvolutionEngine } from "./service.js";
import { tokenize } from "./search.js";
import { createTokenUsageObserver, type TokenUsageTarget } from "./token-usage.js";
import type { EntrySource, HarnessEntry, HarnessScope, HarnessState, RefinementEdit, RefinementProposal, RefinementResult } from "./types.js";
import { isArchived, isMemoryType, MEMORY_TYPE_KEY, slug } from "./types.js";
import { validateBlastRadiusScope, validateEdit } from "./validate.js";

/** ZCode parity: the extractor may inspect memory and propose at most five times. */
export const MEMORY_AGENT_MAX_TURNS = 5;
/** Bound one proposal so approval text and engine compensation stay reviewable. */
export const MEMORY_AGENT_MAX_EDITS = 20;

/** The complete tool-name allowlist exposed by the memory agent. */
export const MEMORY_AGENT_TOOL_NAMES = ["memory_search", "memory_propose"] as const;
export type MemoryAgentToolName = (typeof MEMORY_AGENT_TOOL_NAMES)[number];

/** One frozen memory entry visible to the extractor for the whole run. */
export type MemoryManifestEntry = HarnessEntry;

/** A memory-only edit with an explicit persistence target. */
export type ScopedMemoryEdit = RefinementEdit & {
	kind: "memory";
	targetScope: HarnessScope;
};

/** Structured result returned by `memory_propose`. */
export interface MemoryExtractionProposal extends Omit<RefinementProposal, "edits"> {
	edits: ScopedMemoryEdit[];
}

/** Baseline states captured before the first extractor model turn. */
export interface MemoryScopeBaselines {
	local: HarnessState;
	project?: HarnessState;
	global: HarnessState;
}

/** Result of one bounded extractor loop. */
export interface MemoryAgentRun {
	proposal: MemoryExtractionProposal;
	turns: number;
	searches: number;
}

/** Scoped results after the proposal crosses the governed engine boundary. */
export interface MemoryApplicationResult {
	results: RefinementResult[];
	declinedScopes: HarnessScope[];
}

/** Provider-facing schemas for the closed memory-only tool set. */
export const MEMORY_AGENT_TOOL_SCHEMAS: readonly ToolSchema[] = [
	{
		name: "memory_search",
		description: "Read full content from the frozen memory manifest. This is the only data-reading tool available to the memory extractor.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				query: { type: "string", description: "Keywords, title text, scope:id, or content terms to retrieve." },
			},
			required: ["query"],
		},
	},
	{
		name: "memory_propose",
		description: "Finish extraction with one auditable memory-only proposal. An empty edits array is a valid no-op.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				summary: { type: "string" },
				rationale: { type: "string" },
				expectedOutcome: { type: "string" },
				edits: {
					type: "array",
					maxItems: MEMORY_AGENT_MAX_EDITS,
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							action: { type: "string", enum: ["create", "update", "delete", "archive"] },
							kind: { type: "string", enum: ["memory"] },
							targetScope: { type: "string", enum: ["local", "project", "global"] },
							blastRadius: { type: "string", enum: ["general", "project", "session"] },
							id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
							title: { type: "string" },
							content: { type: "string" },
							path: { type: "string" },
							metadata: {
								type: "object",
								additionalProperties: false,
								properties: { memoryType: { type: "string", enum: ["user", "feedback", "project", "reference"] } },
							},
							reason: { type: "string" },
						},
						required: ["action", "kind", "targetScope", "blastRadius"],
					},
				},
			},
			required: ["summary", "rationale", "expectedOutcome", "edits"],
		},
	},
];

/** Instructions for the dedicated loop; model text is always untrusted. */
export const MEMORY_AGENT_SYSTEM_PROMPT = `You are the dedicated background memory extraction agent for a continual-evolution harness.

You receive only an incremental conversation checkpoint and a frozen manifest of existing memory entries. Your entire job is to decide whether this checkpoint contains a durable fact worth remembering. Never propose prompt notes, skills, subagent specs, code changes, or general conversation summaries.

Rules:
- Use memory_search before creating when the manifest may already cover the topic. Update an existing entry instead of creating a near-duplicate.
- Every memory entry contains exactly one fact. Classify it with metadata.memoryType = user | feedback | project | reference.
- feedback and project memories must state the fact, Why it matters, and How to apply it next time.
- Never invent a user preference. Ground every proposal in the supplied conversation evidence and existing memory.
- Every edit must have kind=memory, an explicit targetScope, and a coherent blastRadius.
- targetScope=local is session staging. project persists within the current repository. global persists across projects. project/global require human approval before application.
- update/delete/archive must name an existing id from the same targetScope. Prefer archive over delete when the fact is obsolete but should remain restorable.
- Do not remember: code structure or file paths re-readable from the repository; git history, diffs, commit hashes, or CI logs; content already written in project instruction files; temporary session state, one-off debugging trails, or current task progress; model-only speculation without conversation evidence.
- You cannot read or write source files, call agents, use MCP, use the network, or mutate the harness directly. memory_propose is the only finish tool and never writes state itself.
- If no durable memory is justified, call memory_propose with edits=[].
- Always finish by calling memory_propose. Do not return unproposed prose.`;

/** Build the frozen memory manifest from a merged harness view. */
export function buildMemoryManifest(state: HarnessState): MemoryManifestEntry[] {
	return Object.values(state.entries.memory)
		.map((entry) => ({ ...entry, metadata: { ...entry.metadata }, reference: {}, arguments: {} }))
		.sort((a, b) => manifestOrder(a).localeCompare(manifestOrder(b), "en"));
}

/** Render a bounded manifest index; full bodies remain available through memory_search. */
export function formatMemoryManifest(entries: readonly MemoryManifestEntry[], maxChars = 8000): string {
	if (entries.length === 0) return "No saved memory entries yet.";
	const lines: string[] = [];
	let used = 0;
	for (const entry of entries) {
		const type = isMemoryType(entry.metadata[MEMORY_TYPE_KEY]) ? entry.metadata[MEMORY_TYPE_KEY] : "untyped";
		const archived = isArchived(entry) ? ", archived" : "";
		const line = `- [${entry.scope}:${entry.id}] ${entry.title} (memoryType=${type}, path=${entry.path}${archived}): ${compactText(entry.content, 240)}`;
		if (used + line.length + 1 > maxChars) break;
		lines.push(line);
		used += line.length + 1;
	}
	const omitted = entries.length - lines.length;
	if (omitted > 0) lines.push(`- +${omitted} more entries; use memory_search with a narrower query.`);
	return lines.join("\n");
}

/** Rank frozen manifest entries with CJK-aware token overlap and stable tie-breaking. */
export function searchMemoryManifest(
	entries: readonly MemoryManifestEntry[],
	query: string,
	maxResults = 8,
): MemoryManifestEntry[] {
	const queryTokens = new Set(tokenize(query));
	if (queryTokens.size === 0) return [];
	return entries
		.map((entry) => {
			const title = tokenize(entry.title);
			const body = tokenize(`${entry.content} ${entry.path} ${String(entry.metadata[MEMORY_TYPE_KEY] ?? "")}`);
			let score = 0;
			for (const token of queryTokens) {
				if (title.includes(token)) score += 2;
				if (body.includes(token)) score += 1;
			}
			if (`${entry.scope}:${entry.id}`.toLowerCase() === query.trim().toLowerCase()) score += 100;
			return { entry, score };
		})
		.filter((hit) => hit.score > 0)
		.sort((a, b) => b.score - a.score || manifestOrder(a.entry).localeCompare(manifestOrder(b.entry), "en"))
		.slice(0, maxResults)
		.map((hit) => hit.entry);
}

/** Inputs for one bounded background memory extraction loop. */
export interface MemoryAgentOptions {
	provider: string;
	model: string;
	sessionId?: LlmSessionId;
	manifest: readonly MemoryManifestEntry[];
	trajectory: string;
	trajectoryEvents?: readonly unknown[];
	prefixCache?: PrefixCacheOptions;
	maxOutputTokens?: number;
	signal?: AbortSignal;
	tokenUsage?: TokenUsageTarget;
}

/**
 * Run the dedicated loop against a frozen manifest.
 *
 * @throws On provider failure, abort, malformed tool arguments, policy denial,
 * a non-memory proposal, or exhaustion of the bounded internal turn budget.
 */
export async function runMemoryAgent(ctx: Context, options: MemoryAgentOptions): Promise<MemoryAgentRun> {
	const events = options.trajectoryEvents ?? [];
	const routing = resolvePrefixCache(options.prefixCache);
	const route = detectPlannerRoute(events, routing.mode);
	const prefixMessages: Message[] = route === "A"
		? buildPrefixMessages(events, { provider: options.provider, model: options.model, maxChars: routing.maxChars })
		: [];
	const conversation = prefixMessages.length > 0 ? "" : `<conversation>\n${options.trajectory}\n</conversation>`;
	const prompt = [
		`<memory_manifest>\n${formatMemoryManifest(options.manifest)}\n</memory_manifest>`,
		conversation,
		"Search before deciding, then call memory_propose with the complete memory-only proposal. Empty edits is a valid no-op.",
	]
		.filter(Boolean)
		.join("\n\n");
	const messages: RequestMessage[] = [
		...prefixMessages,
		createUserMessage({
			content: [{ type: "text", text: prompt }],
			source: EVOLVE_MESSAGE_SOURCE,
		}),
	];

	let searches = 0;
	for (let turn = 1; turn <= MEMORY_AGENT_MAX_TURNS; turn += 1) {
		options.signal?.throwIfAborted();
		const blocks = await streamModelTurn(ctx, {
			provider: options.provider,
			model: options.model,
			...(options.sessionId ? { sessionId: options.sessionId } : {}),
			system: MEMORY_AGENT_SYSTEM_PROMPT,
			messages,
			tools: MEMORY_AGENT_TOOL_SCHEMAS,
			requireTextOrToolCall: true,
			maxTokens: options.maxOutputTokens ?? 4096,
			...(options.signal ? { signal: options.signal } : {}),
			...(options.tokenUsage
				? { onUsage: createTokenUsageObserver(options.tokenUsage, "memory", options.provider, options.model) }
				: {}),
		});
		const hasText = blocks.some((block) => block.type === "text" && block.text.length > 0);
		const hasToolCall = blocks.some((block) => block.type === "tool-call");
		if (!hasText && !hasToolCall) throw new Error("memory agent produced no model output");
		messages.push(createAssistantMessage({
			content: blocks,
			source: { provider: options.provider, model: options.model },
		}));
		const toolCalls = blocks.filter((block): block is ToolCallBlock => block.type === "tool-call");
		if (toolCalls.length === 0) {
			const text = textOf(blocks);
			return {
				proposal: parseMemoryExtractionProposal(extractJsonObject(text), options.manifest),
				turns: turn,
				searches,
			};
		}
		let proposal: MemoryExtractionProposal | undefined;
		for (const call of toolCalls) {
			const execution = executeMemoryTool(call, options.manifest);
			if (call.name === "memory_search") searches += 1;
			proposal ??= execution.proposal;
			messages.push(createToolResultMessage({
				callId: call.id,
				content: [{ type: "text", text: execution.text }],
				isError: execution.isError,
			}));
		}
		if (proposal) return { proposal, turns: turn, searches };
	}
	throw new Error(`memory agent exhausted ${MEMORY_AGENT_MAX_TURNS} internal turns without a valid proposal`);
}

/** Strictly parse and policy-check the structured `memory_propose` payload. */
export function parseMemoryExtractionProposal(
	value: unknown,
	manifest: readonly MemoryManifestEntry[],
): MemoryExtractionProposal {
	const record = asRecord(value);
	if (!record) throw new Error("memory proposal must be an object");
	const summary = requiredString(record["summary"], "summary");
	const rationale = requiredString(record["rationale"], "rationale");
	const expectedOutcome = requiredString(record["expectedOutcome"], "expectedOutcome");
	if (!Array.isArray(record["edits"])) throw new Error("memory proposal edits must be an array");
	if (record["edits"].length > MEMORY_AGENT_MAX_EDITS) {
		throw new Error(`memory proposal exceeds ${MEMORY_AGENT_MAX_EDITS} edits`);
	}
	const byScopeId = new Map(manifest.map((entry) => [`${entry.scope}:${entry.id}`, entry]));
	const edits = record["edits"].map((raw, index) => parseScopedMemoryEdit(raw, index, byScopeId));
	return { summary, rationale, expectedOutcome, edits };
}

export interface ApplyMemoryProposalOptions {
	agent: Agent;
	baselines: MemoryScopeBaselines;
	projectKey?: string;
	requireApproval: boolean;
	source?: EntrySource;
	signal?: AbortSignal;
	/** Outer cursor used to scope reusable approval decisions. */
	decisionCursor?: string;
	/** Prior decisions for the same cursor and exact scoped proposal. */
	scopeDecisions?: Readonly<Record<string, ScopeApprovalDecision>>;
	/** Persist each decision before a later scope can fail. */
	onScopeDecision?: (key: string, decision: ScopeApprovalDecision) => void;
}

/**
 * Render the authoritative persistent-scope diff shown to the human. Model
 * prose is retained only as an explicitly untrusted summary; actions, targets,
 * content previews, memory types, and conflict warnings come from code.
 */
export function renderMemoryApprovalDetails(
	proposal: MemoryExtractionProposal,
	scope: "project" | "global",
	state: HarnessState,
	maxChars = 6000,
): string {
	const edits = proposal.edits.filter((candidate) => candidate.targetScope === scope);
	const details = edits.map((edit) => {
		const before = edit.id ? state.entries.memory[edit.id] : undefined;
		const title = edit.title ?? before?.title ?? "(existing title unchanged)";
		const path = edit.path ?? before?.path ?? "(path unchanged)";
		const content = edit.content ?? (edit.action === "update" ? "(content unchanged)" : "(no content field)");
		const type = edit.metadata?.[MEMORY_TYPE_KEY] ?? before?.metadata[MEMORY_TYPE_KEY] ?? "untyped";
		const candidates = Object.values(state.entries.memory).filter((entry) => entry.id !== edit.id);
		const hit = edit.action === "create" || edit.action === "update"
			? mostSimilarEntry(candidates, edit.title ?? before?.title ?? "", edit.content ?? before?.content ?? "", CONFLICT_WARN_SCORE)
			: undefined;
		const conflict = hit ? `; conflict: ${compactText(buildConflictNotice(hit), 120)}` : "";
		const targetId = edit.id === undefined ? "(new)" : JSON.stringify(edit.id);
		return {
			target: `- ${edit.action} ${scope}:${targetId} — ${compactText(title, 80)}`,
			detail: `  path=${compactText(path, 60)}; memoryType=${String(type)}; content=${compactText(content, 100)}${conflict}`,
		};
	});
	let titleLimit = 80;
	let targets = details.map((detail) => detail.target.replace(/ — .*$/, ` — ${compactText(detail.target.split(" — ")[1] ?? "", titleLimit)}`));
	let base = ["edits to approve:", ...targets].join("\n");
	while (base.length > maxChars && titleLimit > 20) {
		titleLimit = Math.floor(titleLimit / 2);
		targets = details.map((detail) => `- ${detail.target.split(" — ")[0]} — ${compactText(detail.target.split(" — ")[1] ?? "", titleLimit)}`);
		base = ["edits to approve:", ...targets].join("\n");
	}
	if (base.length > maxChars) throw new Error(`memory approval diff exceeds ${maxChars} characters`);
	const output = [base];
	const summary = `model summary (untrusted): ${compactText(proposal.summary, 180)}`;
	if ([...output, summary].join("\n").length <= maxChars) output.push(summary);
	for (const detail of details) {
		const line = detail.detail;
		if ([...output, line].join("\n").length <= maxChars) output.push(line);
	}
	if ([...output, "  (additional previews omitted; every target is listed above)"].join("\n").length <= maxChars) {
		output.push("  (additional previews omitted; every target is listed above)");
	}
	return output.join("\n");
}

function memoryScopeDecisionKey(cursor: string, scope: HarnessScope, edits: readonly ScopedMemoryEdit[]): string {
	return `${cursor}:${scope}:${JSON.stringify(edits.map(stripTargetScope))}`;
}

class MemoryApplyBatchError extends Error {
	constructor(message: string, readonly result?: RefinementResult, readonly scope?: HarnessScope, readonly storeId?: string) {
		super(message);
	}
}

/**
 * Apply one accepted proposal through the only mutation engine. All persistent
 * approvals are resolved before the first write, so an unavailable approval
 * boundary cannot leave a partially applied batch. Explicit rejection is a
 * no-op for that scope; service/question failures remain retryable errors.
 */
export async function applyMemoryExtractionProposal(
	ctx: Context,
	engine: EvolutionEngine,
	proposal: MemoryExtractionProposal,
	options: ApplyMemoryProposalOptions,
): Promise<MemoryApplicationResult> {
	const scopeOrder = ["local", "project", "global"] as const;
	const editsByScope = new Map<HarnessScope, ScopedMemoryEdit[]>();
	for (const scope of scopeOrder) {
		const edits = proposal.edits.filter((edit) => edit.targetScope === scope);
		if (edits.length > 0) editsByScope.set(scope, edits);
	}
	if (editsByScope.has("project") && !options.projectKey) {
		throw new Error("memory agent cannot target project scope without a resolved project key");
	}

	const approvedScopes = new Set<HarnessScope>();
	const declinedScopes: HarnessScope[] = [];
	for (const scope of ["project", "global"] as const) {
		if (!editsByScope.has(scope)) continue;
		if (!options.requireApproval) {
			approvedScopes.add(scope);
			continue;
		}
		const baseline = options.baselines[scope];
		if (!baseline) throw new Error(`memory agent has no ${scope} baseline`);
		const decisionKey = options.decisionCursor === undefined
			? undefined
			: memoryScopeDecisionKey(options.decisionCursor, scope, proposal.edits.filter((edit) => edit.targetScope === scope));
		const previous = decisionKey === undefined ? undefined : options.scopeDecisions?.[decisionKey];
		if (previous === "approved") {
			approvedScopes.add(scope);
			continue;
		}
		if (previous === "declined") {
			declinedScopes.push(scope);
			continue;
		}
		const approved = await requestScopeApproval(
			ctx,
			options.agent,
			options.signal,
			scope,
			renderMemoryApprovalDetails(proposal, scope, baseline),
		);
		if (decisionKey !== undefined) options.onScopeDecision?.(decisionKey, approved);
		if (approved === "approved") approvedScopes.add(scope);
		else declinedScopes.push(scope);
	}

	const results: RefinementResult[] = [];
	const applied: Array<{ scope: HarnessScope; storeId: string | undefined; result: RefinementResult }> = [];
	try {
		for (const scope of scopeOrder) {
			const edits = editsByScope.get(scope);
			if (!edits) continue;
			if (scope !== "local" && !approvedScopes.has(scope)) continue;
			options.signal?.throwIfAborted();
			const storeId = scope === "local" ? options.agent.id : scope === "project" ? options.projectKey : undefined;
			const baseline = options.baselines[scope];
			if (!baseline) throw new Error(`memory agent has no ${scope} baseline`);
			const result = engine.apply(
				scope,
				storeId,
				{
					summary: proposal.summary,
					rationale: proposal.rationale,
					expectedOutcome: proposal.expectedOutcome,
					edits: prepareMemoryEdits(edits, baseline),
				},
				{
					scope,
					baselineState: baseline,
					...(options.source ? { source: options.source } : {}),
				},
			);
			const failed = result.appliedEdits.filter((edit) => !edit.applied);
			if (failed.length > 0) {
				throw new MemoryApplyBatchError(
					`${scope} batch ${result.id} left ${failed.length} edit(s) unapplied: ${failed.map((edit) => edit.error ?? "unknown").join("; ")}`,
					result,
					scope,
					storeId,
				);
			}
			results.push(result);
			applied.push({ scope, storeId, result });
		}
		return { results, declinedScopes };
	} catch (cause) {
		const attempted = [...applied];
		if (cause instanceof MemoryApplyBatchError && cause.result && cause.scope) {
			attempted.push({ scope: cause.scope, storeId: cause.storeId, result: cause.result });
		} else if (cause instanceof EvolutionApplyPostCommitError) {
			attempted.push({ scope: cause.scope, storeId: cause.storeId, result: cause.result });
		}
		const rollbackErrors: string[] = [];
		for (const item of attempted.reverse()) {
			try {
				const rollback = engine.rollbackResult(item.scope, item.storeId, item.result);
				const failed = rollback.appliedEdits.filter((edit) => !edit.applied);
				if (failed.length > 0) rollbackErrors.push(`${item.scope}:${item.result.id} left ${failed.length} rollback edit(s) unapplied`);
			} catch (rollbackCause) {
				rollbackErrors.push(`${item.scope}:${item.result.id} rollback failed: ${rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause)}`);
			}
		}
		const suffix = rollbackErrors.length > 0 ? `; compensation errors: ${rollbackErrors.join("; ")}` : "; prior memory writes were rolled back";
		throw new Error(`memory agent apply failed: ${cause instanceof Error ? cause.message : String(cause)}${suffix}`);
	}
}

function executeMemoryTool(
	call: ToolCallBlock,
	manifest: readonly MemoryManifestEntry[],
): { proposal?: MemoryExtractionProposal; text: string; isError: boolean } {
	if (!(MEMORY_AGENT_TOOL_NAMES as readonly string[]).includes(call.name)) {
		return { text: `tool denied: only ${MEMORY_AGENT_TOOL_NAMES.join(" and ")} are available`, isError: true };
	}
	try {
		const args = parseJsonCandidate(call.arguments.trim() || "{}");
		if (call.name === "memory_search") {
			const record = asRecord(args);
			const query = record ? requiredString(record["query"], "query") : "";
			const matches = searchMemoryManifest(manifest, query).map(manifestResult);
			return { text: JSON.stringify({ matches }), isError: false };
		}
		return { proposal: parseMemoryExtractionProposal(args, manifest), text: JSON.stringify({ accepted: true }), isError: false };
	} catch (cause) {
		return {
			text: `tool error: ${cause instanceof Error ? cause.message : String(cause)}`,
			isError: true,
		};
	}
}

function parseScopedMemoryEdit(
	raw: unknown,
	index: number,
	byScopeId: ReadonlyMap<string, MemoryManifestEntry>,
): ScopedMemoryEdit {
	const record = asRecord(raw);
	if (!record) throw new Error(`memory edit ${index} must be an object`);
	const action = requiredString(record["action"], `edits[${index}].action`);
	if (!isOneOf(action, ["create", "update", "delete", "archive"] as const)) {
		throw new Error(`memory edit ${index} has unsupported action ${action}`);
	}
	if (record["kind"] !== "memory") throw new Error(`memory edit ${index} must have kind=memory`);
	const targetScope = requiredString(record["targetScope"], `edits[${index}].targetScope`);
	if (!isOneOf(targetScope, ["local", "project", "global"] as const)) {
		throw new Error(`memory edit ${index} has unsupported targetScope ${targetScope}`);
	}
	const blastRadius = requiredString(record["blastRadius"], `edits[${index}].blastRadius`);
	if (!isOneOf(blastRadius, ["general", "project", "session"] as const)) {
		throw new Error(`memory edit ${index} has unsupported blastRadius ${blastRadius}`);
	}
	const blastError = validateBlastRadiusScope(targetScope, blastRadius);
	if (blastError) throw new Error(`memory edit ${index}: ${blastError}`);
	if (record["reference"] !== undefined || record["arguments"] !== undefined || record["skill_kind"] !== undefined) {
		throw new Error(`memory edit ${index} cannot carry skill-only fields`);
	}
	const edit: ScopedMemoryEdit = {
		action,
		kind: "memory",
		targetScope,
		blastRadius,
	};
	for (const field of ["id", "title", "content", "path", "reason"] as const) {
		const fieldValue = record[field];
		if (fieldValue !== undefined) {
			if (typeof fieldValue !== "string") throw new Error(`memory edit ${index}.${field} must be a string`);
			edit[field] = fieldValue;
		}
	}
	if (record["metadata"] !== undefined) {
		const metadata = asRecord(record["metadata"]);
		if (!metadata) throw new Error(`memory edit ${index}.metadata must be an object`);
		const unexpected = Object.keys(metadata).filter((key) => key !== MEMORY_TYPE_KEY);
		if (unexpected.length > 0) {
			throw new Error(`memory edit ${index}.metadata contains engine-owned or unsupported keys: ${unexpected.join(", ")}`);
		}
		edit.metadata = { ...metadata };
	}
	if (action === "create" && edit.id && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(edit.id)) {
		throw new Error(`memory edit ${index}.id contains unsupported identifier characters`);
	}
	const before = edit.id ? byScopeId.get(`${targetScope}:${edit.id}`) : undefined;
	if (action !== "create" && !before) {
		throw new Error(`memory edit ${index} ${action} target does not exist in ${targetScope}: ${edit.id ?? "(missing id)"}`);
	}
	if (action === "create" && edit.id && before) {
		throw new Error(`memory edit ${index} create duplicates ${targetScope}:${edit.id}; use update instead`);
	}
	const validationError = validateEdit(edit, edit.id ?? slug(edit.title ?? "memory", "memory"), targetScope, before);
	if (validationError) throw new Error(`memory edit ${index}: ${validationError}`);
	return edit;
}

function prepareMemoryEdits(edits: readonly ScopedMemoryEdit[], baseline: HarnessState): RefinementEdit[] {
	return edits.map((edit) => {
		const plain = stripTargetScope(edit);
		if (plain.action !== "update" || plain.metadata === undefined || plain.id === undefined) return plain;
		const before = baseline.entries.memory[plain.id];
		return before ? { ...plain, metadata: { ...before.metadata, ...plain.metadata } } : plain;
	});
}

function stripTargetScope(edit: ScopedMemoryEdit): RefinementEdit {
	const { targetScope: _targetScope, ...plain } = edit;
	return plain;
}

function manifestResult(entry: MemoryManifestEntry): Record<string, unknown> {
	return {
		scope: entry.scope,
		id: entry.id,
		title: entry.title,
		content: entry.content,
		path: entry.path,
		memoryType: entry.metadata[MEMORY_TYPE_KEY],
		archived: isArchived(entry),
	};
}

function manifestOrder(entry: MemoryManifestEntry): string {
	const scope = entry.scope === "global" ? "0" : entry.scope === "project" ? "1" : "2";
	return `${scope}:${entry.id}:${entry.title}`;
}

function textOf(blocks: readonly ContentBlock[]): string {
	return blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
	return value;
}

function isOneOf<const T extends readonly string[]>(value: string, values: T): value is T[number] {
	return (values as readonly string[]).includes(value);
}
