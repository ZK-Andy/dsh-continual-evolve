/**
 * Memory proposal application: take the extractor's structured proposal and
 * land it through the governed path — per-scope human approval (unique,
 * explicit, fail-loud), credential screening, conflict notices, engine
 * apply with baseline checks, decline recording, and cross-scope
 * compensation on partial failure.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { EntrySource, HarnessScope, HarnessState, RefinementEdit, RefinementResult } from "./types.js";
import { MEMORY_TYPE_KEY } from "./types.js";
import { requestScopeApproval, type ScopeApprovalDecision } from "./approval.js";
import {
	fingerprintMemoryBatch,
	isDeclinedRepeat,
	loadDeclinedMemory,
	recordDeclinedMemory,
} from "./declines.js";
import { compactText } from "./render.js";
import { buildConflictNotice, CONFLICT_WARN_SCORE, mostSimilarEntry } from "./promotion.js";
import { EvolutionApplyPostCommitError, type EvolutionEngine } from "./service.js";
import type { MemoryApplicationResult, MemoryExtractionProposal, MemoryScopeBaselines, ScopedMemoryEdit } from "./memory-agent.js";
import type { RecordLanguagePreference } from "./record-language.js";

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
	/** Plugin `recordLanguage` preference for the approval dialog copy. */
	recordLanguage?: RecordLanguagePreference;
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
		const scopeEdits = proposal.edits.filter((edit) => edit.targetScope === scope);
		const fingerprint = fingerprintMemoryBatch(scope, scopeEdits);
		if (isDeclinedRepeat(loadDeclinedMemory(engine.baseDir), scope, fingerprint)) {
			ctx.logger("continual-evolve").info(`memory ${scope} proposal repeat-suppressed (declined before, no popup)`);
			declinedScopes.push(scope);
			continue;
		}
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
			options.recordLanguage,
		);
		if (decisionKey !== undefined) options.onScopeDecision?.(decisionKey, approved);
		if (approved === "approved") approvedScopes.add(scope);
		else {
			declinedScopes.push(scope);
			try {
				recordDeclinedMemory(engine.baseDir, scope, scopeEdits, compactText(scopeEdits[0]?.title ?? proposal.summary, 120));
			} catch (error) {
				ctx.logger("continual-evolve").warn(`declined-memory ledger write failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
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
