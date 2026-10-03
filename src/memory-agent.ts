/**
 * Dedicated background memory extraction agent.
 *
 * This is the DSH counterpart of ZCode's project-memory agent loop. It keeps
 * an independent request history, exposes only a frozen memory manifest and a
 * structured proposal tool, and never writes state itself. Every accepted edit
 * is handed to EvolutionEngine so scope approval, snapshots, versioning,
 * rollback, and audit remain mandatory.
 *
 * Split (2026-10-03 refactor): the manifest view lives in
 * `memory-manifest.ts`, proposal application in `memory-apply.ts`.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import {
	createAssistantMessage,
	createToolResultMessage,
	createUserMessage,
	type Message,
	type RequestMessage,
	type ToolCallBlock,
	type ToolSchema,
} from "@deepseek-ai/dsh-llm";
import { EVOLVE_MESSAGE_SOURCE } from "./message-source.js";
import { asLlmSessionId, streamModelTurn, type LlmSessionId } from "./llm-text.js";
import { formatMemoryManifest, manifestResult, searchMemoryManifest, type MemoryManifestEntry } from "./memory-manifest.js";
import { validateBlastRadiusScope, validateEdit } from "./validate.js";
import { extractJsonObject, parseJsonCandidate } from "./plan.js";
import { buildPrefixMessages, detectPlannerRoute, resolvePrefixCache, type PrefixCacheOptions } from "./prefix-cache.js";
import { createTokenUsageObserver, type TokenUsageTarget } from "./token-usage.js";
import { recordLanguageInstruction, resolveRecordLanguage, type RecordLanguage } from "./record-language.js";
import type { HarnessScope, HarnessState, RefinementEdit, RefinementProposal, RefinementResult } from "./types.js";
import { MEMORY_TYPE_KEY, slug } from "./types.js";

/** ZCode parity: the extractor may inspect memory and propose at most five times. */
export const MEMORY_AGENT_MAX_TURNS = 5;
/** Bound one proposal so approval text and engine compensation stay reviewable. */
export const MEMORY_AGENT_MAX_EDITS = 20;
/**
 * System-prompt size budget (chars): the prompt ships on EVERY extractor
 * turn (up to five per snapshot), so each added line is recurring token
 * spend, not one-off text. Raise this cap only in the same commit that
 * justifies the added lines (regression pressure beats silent bloat).
 */
export const MEMORY_AGENT_SYSTEM_PROMPT_BUDGET_CHARS = 3000;

/** The complete tool-name allowlist exposed by the memory agent. */
export const MEMORY_AGENT_TOOL_NAMES = ["memory_search", "memory_propose"] as const;
export type MemoryAgentToolName = (typeof MEMORY_AGENT_TOOL_NAMES)[number];

/** One frozen memory entry visible to the extractor for the whole run. */

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
- Do not remember: code structure or file paths re-readable from the repository; git history, diffs, commit hashes, or CI logs; content already written in project instruction files; temporary session state, one-off debugging trails, or current task progress; model-only speculation without conversation evidence; an already-applied troubleshooting fix with no recurrence evidence (the fixed state on disk is its own record).
- Be specific enough to act on: prefer a fact that tells the next session what to DO over a summary of what happened. If the fact is obvious from the conversation itself with no future action attached, skip it.
- Save only what is surprising or non-obvious: routine chatter, restated context, and facts with no bearing on future work are no-ops, not memories.
- Granularity examples (vague → reject; sharp → save):
  - "user communicates in Chinese" → "user reads English with effort — write memory and handoff content in Chinese prose".
  - "user works on the desktop project" → "desktop profile loads npm-installed plugin copies — source edits need a release before they take effect".
  - "fixed fcitx5 by setting GTK_IM_MODULE tonight" → reject (one-off applied fix, already on disk, no recurrence evidence).
- You cannot read or write source files, call agents, use MCP, use the network, or mutate the harness directly. memory_propose is the only finish tool and never writes state itself.
- If no durable memory is justified, call memory_propose with edits=[].
- Always finish by calling memory_propose. Do not return unproposed prose.`;

/** Build the frozen memory manifest from a merged harness view. */export interface MemoryAgentOptions {
	provider: string;
	model: string;
	sessionId?: LlmSessionId | string;
	manifest: readonly MemoryManifestEntry[];
	trajectory: string;
	trajectoryEvents?: readonly unknown[];
	prefixCache?: PrefixCacheOptions;
	maxOutputTokens?: number;
	signal?: AbortSignal;
	tokenUsage?: TokenUsageTarget;
	/**
	 * Authoring language for the proposal. Absent → resolved per call
	 * (explicit config upstream, else durable client preference, else
	 * trajectory detection, else `en`).
	 */
	language?: RecordLanguage;
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
	const language = options.language ?? resolveRecordLanguage({ ctx, trajectoryText: options.trajectory });
	const systemPrompt = `${MEMORY_AGENT_SYSTEM_PROMPT}\n\n${recordLanguageInstruction(language)}`;
	for (let turn = 1; turn <= MEMORY_AGENT_MAX_TURNS; turn += 1) {
		options.signal?.throwIfAborted();
		const blocks = await streamModelTurn(ctx, {
			provider: options.provider,
			model: options.model,
			...(options.sessionId ? { sessionId: asLlmSessionId(options.sessionId) } : {}),
			system: systemPrompt,
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



function textOf(blocks: readonly ContentBlock[]): string {
	return blocks
		.map((block) => (block.type === "text" ? block.text : ""))
		.filter((text) => text.length > 0)
		.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
	return value;
}

function isOneOf<const T extends readonly string[]>(value: string, values: T): value is T[number] {
	return (values as readonly string[]).includes(value);
}
