/**
 * The dedicated memory extraction phase: one bounded ZCode-style loop over a
 * scheduler snapshot. Owns its request loop, frozen manifest, scope approval
 * bookkeeping, and the phase-specific memory checkpoint that advances after a
 * successful/no-op outcome — memory failures leave the boundary retryable.
 *
 * Triggered only by the low-frequency moments wired in `listener.ts`;
 * per-turn extraction was removed with the 2026-10-03 B verdict.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { EvolutionEngine } from "./service.js";
import { notifyMemoryExtraction } from "./notify.js";
import { mergeHarnessStates } from "./state.js";
import { projectKeyOf } from "./project.js";
import { buildEvolveCompleteEvent, emitEvolveComplete } from "./evolve-event.js";
import { compareReviewCursors, sliceTurnSnapshot, type TurnSnapshot } from "./turn-snapshot.js";
import { matchDeclinedTrajectory } from "./declines.js";
import {
	runMemoryAgent,
	type MemoryScopeBaselines,
} from "./memory-agent.js";
import { applyMemoryExtractionProposal } from "./memory-apply.js";
import { buildMemoryManifest } from "./memory-manifest.js";
import type { HarnessState, ScopeApprovalDecision } from "./types.js";
import { DEFAULT_REVIEWS_RETAIN } from "./types.js";
import type { PlannerPrefixCacheMode } from "./types.js";
import { resolveRecordLanguage, type RecordLanguagePreference } from "./record-language.js";

export interface GateState {
	turns: number;
	/** Latest successful turn boundary seen by the listener. */
	completedTurn: number;
	/** Latest successful/no-op memory boundary. */
	memoryCheckpoint?: string;
	/** Per-boundary/scope approval decisions retained until the memory phase settles. */
	memoryDecisions: Record<string, ScopeApprovalDecision>;
	lastReviewAt: number;
	/**
	 * Consecutive idle probes that observed the goal phase "blocked".
	 * Reset to 0 by any non-blocked probe and after a triggered moment.
	 */
	goalBlockStreak: number;
}

export interface AutoReviewConfig {
	/** Initial runtime state when no runtime.json exists. */
	enabledByDefault?: boolean;
	/** ZCode-style minimum lexical words in one direct user text part. */
	memoryMinUserWords?: number;
	/** Trajectory slice handed to the extractor, in characters. */
	maxInputChars: number;
	/** Output budget for the extraction loop. */
	budgetTokens: number;
	/** Queue a visible receipt follow-up after an applied goal-blocked moment. */
	notifyOnAutoReview: boolean;
	/**
	 * Optional model override for the extractor (cheaper model).
	 * Format: "provider/model" or just "model" (same provider as the agent).
	 * When absent, the extractor uses the agent's own provider/model.
	 */
	reviewModel?: string;
	/** Dedicated memory-agent writes to project/global require the normal human approval boundary. */
	requireGlobalApproval?: boolean;
	/**
	 * Authoring language for this run's records. Absent/`auto` resolves per
	 * call through the record-language chain (durable client preference,
	 * then trajectory detection, then `en`); `zh`/`en` pin it.
	 */
	recordLanguage?: RecordLanguagePreference;
	/**
	 * Prefix-cache routing for the extraction input. Absent mode → auto-detect;
	 * absent budget → the default prefix budget.
	 */
	prefixCacheMode?: PlannerPrefixCacheMode;
	prefixMaxChars?: number;
	/**
	 * Goal-blocked trigger: after this many CONSECUTIVE idle probes that
	 * observe the session goal in phase "blocked", run one memory extraction
	 * so the blocked encounter is distilled. 0 disables. The streak resets on
	 * any non-blocked probe and after each triggered moment.
	 */
	goalBlockedWrapupTurns: number;
	/**
	 * Storage hygiene (#20): tail lines kept in the shared reviews.jsonl
	 * audit trail. Absent → the store default (readers need a recent
	 * window, not the full past).
	 */
	reviewsRetain?: number;
	/**
	 * Session-close bounded drain: how long a disposed session's in-flight
	 * extraction may settle before its owner signal aborts. Absent → 15s;
	 * 0 restores the legacy immediate abort.
	 */
	sessionCloseDrainMs?: number;
}

export interface ReviewRecord {
	timestamp: string;
	sessionId: string;
	reason: TurnSnapshot["reason"];
	turnsSinceLastReview: number;
	outcome: "approved" | "declined" | "failed" | "assessed" | "deferred" | "skipped" | "armed" | "applied" | "noop";
	rationale?: string;
	refinementId?: string;
	/** P1 extraction stats (§6.7): wall time of the memory phase. */
	durationMs?: number;
	/** Extractor loop turns / manifest searches behind this row. */
	memoryTurns?: number;
	memorySearches?: number;
	/** Applied edit count carried by an applied row. */
	appliedEdits?: number;
}

export type ReviewRecorder = (entry: Omit<ReviewRecord, "timestamp">) => void;

export function stateFor(map: Map<string, GateState>, sessionId: string): GateState {
	let state = map.get(sessionId);
	if (!state) {
		state = {
			turns: 0,
			completedTurn: 0,
			memoryDecisions: {},
			lastReviewAt: 0,
			goalBlockStreak: 0,
		};
		map.set(sessionId, state);
	}
	return state;
}

export function advanceMemoryCheckpoint(state: GateState, next: string): void {
	if (state.memoryCheckpoint === undefined) {
		state.memoryCheckpoint = next;
		return;
	}
	const order = compareReviewCursors(next, state.memoryCheckpoint);
	if (order === undefined || order > 0) state.memoryCheckpoint = next;
}

function rememberMemoryDecision(state: GateState, key: string, decision: ScopeApprovalDecision): void {
	state.memoryDecisions[key] = decision;
	const keys = Object.keys(state.memoryDecisions);
	while (keys.length > 128) delete state.memoryDecisions[keys.shift() ?? ""];
}

/**
 * The state view the extractor judges: the session's local entries merged
 * with the project and global stores, each entry carrying its real scope.
 * Without the global half the extractor cannot see that a topic is already
 * covered cross-session and happily re-sediments a local duplicate of it.
 *
 * The merged view is read-only context — applying still targets the raw
 * local state (baseline checks compare local entries only).
 */
export function loadGateHarnessView(engine: EvolutionEngine, sessionId: string, opts?: { projectKey?: string }): HarnessState {
	const projectState = opts?.projectKey ? engine.load("project", opts.projectKey) : undefined;
	return mergeHarnessStates(engine.load("global", undefined), engine.load("local", sessionId), projectState ? { projectState } : undefined);
}

/**
 * Gap C1: parse a "provider/model" or "model" string into its components.
 * Returns undefined when the input is empty (no override). A bare model name
 * falls back to the agent's provider, then "deepseek".
 * Exported for unit testing; production resolves it inside
 * runMemoryExtractionPhase.
 */
export function parseReviewModel(
	reviewModel: string | undefined,
	fallbackProvider: string | undefined,
): { provider: string; model: string } | undefined {
	if (!reviewModel || reviewModel.trim().length === 0) return undefined;
	const slash = reviewModel.indexOf("/");
	if (slash > 0) {
		return { provider: reviewModel.slice(0, slash), model: reviewModel.slice(slash + 1) };
	}
	return { provider: fallbackProvider ?? "deepseek", model: reviewModel };
}

/**
 * One extraction run over a scheduler snapshot. Records noop / applied /
 * declined audit rows with duration and loop stats, advances the memory
 * checkpoint on settled outcomes, and queues a visible receipt only for an
 * applied goal-blocked moment (compaction and session-close stay audit-only).
 */
export async function runMemoryExtractionPhase(
	ctx: Context,
	engine: EvolutionEngine,
	agent: Agent,
	config: AutoReviewConfig,
	state: GateState,
	snapshot: TurnSnapshot,
	record: ReviewRecorder,
	signal?: AbortSignal,
): Promise<void> {
	const sessionId = agent.id;
	const turnsSinceLastReview = state.turns - state.lastReviewAt;
	// This invocation becomes the new reference point for the next audit row.
	state.lastReviewAt = state.turns;
	const startedAt = Date.now();
	const memorySnapshot = state.memoryCheckpoint ? sliceTurnSnapshot(snapshot, state.memoryCheckpoint) : snapshot;
	if (!memorySnapshot.eligible || !memorySnapshot.trajectory) {
		advanceMemoryCheckpoint(state, snapshot.cursor);
		ctx.logger("continual-evolve").info(`memory agent no-op (${snapshot.reason}) [${agent.id}]: no new eligible evidence after checkpoint`);
		record({
			sessionId,
			reason: snapshot.reason,
			turnsSinceLastReview,
			outcome: "noop",
			rationale: `memory no-op (${snapshot.reason}): no new eligible evidence after checkpoint`,
			durationMs: Date.now() - startedAt,
			memoryTurns: 0,
			memorySearches: 0,
			appliedEdits: 0,
		});
		return;
	}
	const declinedHit = matchDeclinedTrajectory(engine.baseDir, memorySnapshot.trajectory);
	if (declinedHit !== undefined) {
		advanceMemoryCheckpoint(state, memorySnapshot.cursor);
		ctx.logger("continual-evolve").info(
			`memory agent pre-suppressed (${snapshot.reason}) [${agent.id}]: checkpoint overlaps declined ${declinedHit.entry.scope}:${declinedHit.entry.fingerprint} (coverage ${(declinedHit.coverage * 100).toFixed(0)}%, ${declinedHit.hits} tokens) — agent not invoked`,
		);
		record({
			sessionId,
			reason: snapshot.reason,
			turnsSinceLastReview,
			outcome: "noop",
			rationale: `memory pre-suppressed (${snapshot.reason}): checkpoint overlaps declined ${declinedHit.entry.scope}:${declinedHit.entry.fingerprint} — agent not invoked`,
			durationMs: Date.now() - startedAt,
			memoryTurns: 0,
			memorySearches: 0,
			appliedEdits: 0,
		});
		return;
	}
	const projectKey = snapshot.projectKey ?? projectKeyOf(agent);
	const baselines: MemoryScopeBaselines = {
		local: engine.load("local", sessionId),
		global: engine.load("global", undefined),
		...(projectKey ? { project: engine.load("project", projectKey) } : {}),
	};
	const manifest = buildMemoryManifest(loadGateHarnessView(engine, sessionId, projectKey ? { projectKey } : undefined));
	const overrideRoute = parseReviewModel(config.reviewModel, agent.options.provider);
	const provider = overrideRoute?.provider ?? agent.options.provider;
	const model = overrideRoute?.model ?? agent.options.model;
	if (!provider || !model) throw new Error("evolve: no provider/model route for the memory extraction agent");
	const tokenUsage = {
		baseDir: engine.baseDir,
		sessionId,
		retain: engine.retention.tokenUsage,
		onError: (cause: unknown) => ctx
			.logger("continual-evolve")
			.warn(`token-usage ledger failed for ${sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`),
	};
	const run = await runMemoryAgent(ctx, {
		provider,
		model,
		sessionId,
		manifest,
		trajectory: memorySnapshot.trajectory,
		trajectoryEvents: memorySnapshot.events,
		maxOutputTokens: config.budgetTokens,
		...(signal ? { signal } : {}),
		tokenUsage,
		language: resolveRecordLanguage({ configured: config.recordLanguage, ctx, trajectoryText: memorySnapshot.trajectory }),
		...((config.prefixCacheMode !== undefined || config.prefixMaxChars !== undefined
			? {
					prefixCache: {
						...(config.prefixCacheMode !== undefined ? { mode: config.prefixCacheMode } : {}),
						...(config.prefixMaxChars !== undefined ? { maxChars: config.prefixMaxChars } : {}),
					},
				}
			: {})),
	});
	if (run.proposal.edits.length === 0) {
		advanceMemoryCheckpoint(state, memorySnapshot.cursor);
		ctx.logger("continual-evolve").info(`memory agent no-op (${snapshot.reason}) [${sessionId}] after ${run.turns} turn(s): ${run.proposal.rationale}`);
		record({
			sessionId,
			reason: snapshot.reason,
			turnsSinceLastReview,
			outcome: "noop",
			rationale: `memory no-op (${snapshot.reason}) after ${run.turns} turn(s): ${run.proposal.rationale}`,
			durationMs: Date.now() - startedAt,
			memoryTurns: run.turns,
			memorySearches: run.searches,
			appliedEdits: 0,
		});
		return;
	}
	const source = { sessionId, ...(memorySnapshot.sourceSeqs.length > 0 ? { seqs: [...memorySnapshot.sourceSeqs] } : {}) };
	const application = await applyMemoryExtractionProposal(ctx, engine, run.proposal, {
		agent,
		baselines,
		...(projectKey ? { projectKey } : {}),
		requireApproval: config.requireGlobalApproval ?? true,
		source,
		decisionCursor: memorySnapshot.cursor,
		scopeDecisions: state.memoryDecisions,
		onScopeDecision: (key, decision) => rememberMemoryDecision(state, key, decision),
		...(config.recordLanguage !== undefined ? { recordLanguage: config.recordLanguage } : {}),
		...(signal ? { signal } : {}),
	});
	for (const result of application.results) {
		emitEvolveComplete(
			engine.baseDir,
			buildEvolveCompleteEvent(result, `memory_agent:${snapshot.reason}`, sessionId),
			config.reviewsRetain ?? DEFAULT_REVIEWS_RETAIN,
		);
	}
	state.memoryCheckpoint = memorySnapshot.cursor;
	const applied = application.results.reduce((count, result) => count + result.appliedEdits.filter((edit) => edit.applied).length, 0);
	const declined = application.declinedScopes.length > 0 ? `; declined scopes=${application.declinedScopes.join(",")}` : "";
	const durationMs = Date.now() - startedAt;
	for (const result of application.results) {
		record({
			sessionId,
			reason: snapshot.reason,
			turnsSinceLastReview,
			outcome: "applied",
			rationale: `memory applied (${snapshot.reason}) after ${run.turns} turn(s): ${run.proposal.rationale}${declined}`,
			refinementId: result.id,
			durationMs,
			memoryTurns: run.turns,
			memorySearches: run.searches,
			appliedEdits: result.appliedEdits.filter((edit) => edit.applied).length,
		});
	}
	if (application.declinedScopes.length > 0) {
		record({
			sessionId,
			reason: snapshot.reason,
			turnsSinceLastReview,
			outcome: "declined",
			rationale: `memory scopes declined (${snapshot.reason}): ${application.declinedScopes.join(",")}`,
			durationMs,
			memoryTurns: run.turns,
			memorySearches: run.searches,
			appliedEdits: 0,
		});
	}
	ctx.logger("continual-evolve").info(
		`memory agent applied ${applied} edit(s) across ${application.results.length} scope batch(es) [${sessionId}] after ${run.turns} turn(s)${declined}: ${run.proposal.rationale}`,
	);
	// Visibility (P1 unified receipt): only applied outcomes wake the agent
	// with a follow-up — and only on the goal-blocked moment, which runs
	// mid-session; compaction and session-close stay audit-only
	// (reviews.jsonl) so they never wake the agent mid-compaction or after
	// disposal.
	if (config.notifyOnAutoReview && snapshot.reason === "goal_blocked" && applied > 0) {
		notifyMemoryExtraction(ctx, agent, {
			outcome: "applied",
			results: application.results,
			...(application.declinedScopes.length > 0 ? { declinedScopes: [...application.declinedScopes] } : {}),
			turns: run.turns,
			searches: run.searches,
			durationMs,
		});
	}
}
