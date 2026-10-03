/**
 * The automatic evolution driver: moment-driven memory extraction.
 *
 * Conversation writes (`evolve_add` guided by the when_to_save section) own
 * routine sedimentation. The dedicated Memory Agent wakes only at low
 * frequency moments (refactor 2026-10-03, B verdict):
 *
 * - `session/event` (compaction/start) — before trajectory data is summarized away.
 * - goal blocked streak — `goalBlockedWrapupTurns` consecutive idle probes
 *   observing the session goal in phase "blocked" trigger one extraction so
 *   the stuck encounter is distilled before the session moves on. The probe
 *   is a mechanical in-memory check; it costs no LLM call until the moment fires.
 * - session close — the bounded drain (`sessionCloseDrainMs`) lets an
 *   in-flight extraction settle before the owner signal aborts.
 * - manual `/evolve wrapup` — its own consultation flow (`wrapup.ts`).
 *
 * Per-turn snapshot extraction was removed: it burned 90% of the plugin's
 * direct LLM calls for a fifth of the sediment (audit 2026-10-03). The
 * general review/planner and local-fate phases were deleted with it —
 * superseded paths do not stay wired (architecture-standard §5.1).
 *
 * Every decision (applied / declined / failed / skipped / noop) is appended
 * to `<dshHome>/evolve/reviews.jsonl` so extraction activity is durably
 * auditable — the server console is not a reliable place to look.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ScopeApprovalDecision } from "./approval.js";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { EvolutionEngine } from "./service.js";
import { goalServiceOf } from "./goal.js";
import { notifyMemoryExtraction } from "./notify.js";
import { mergeHarnessStates } from "./state.js";
import { projectKeyOf } from "./project.js";
import { buildEvolveCompleteEvent, emitEvolveComplete } from "./evolve-event.js";
import { DEFAULT_REVIEWS_RETAIN, pruneJsonlFile } from "./store.js";
import { isGateEnabled } from "./runtime.js";
import { compareReviewCursors, createReviewScheduler, type ReviewScheduler } from "./review-scheduler.js";
import { captureTurnSnapshot, sliceTurnSnapshot, type TurnSnapshot } from "./turn-snapshot.js";
import { loadDeclinedMemory, matchDeclinedCheckpoint } from "./declines.js";
import { tokenize } from "./search.js";
import {
	applyMemoryExtractionProposal,
	buildMemoryManifest,
	runMemoryAgent,
	type MemoryScopeBaselines,
} from "./memory-agent.js";
import type { HarnessState } from "./types.js";
import { asLlmSessionId } from "./llm-text.js";
import type { PlannerPrefixCacheMode } from "./prefix-cache.js";
import { resolveRecordLanguage, type RecordLanguagePreference } from "./record-language.js";

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

/** Default session-close drain budget: an in-flight extraction gets 15s to settle. */
export const SESSION_CLOSE_DRAIN_MS_DEFAULT = 15000;

/**
 * Resolve the session-close drain budget: absent/invalid → default, 0 →
 * immediate abort (legacy). Negative or non-finite values fail back to the
 * default rather than silently disabling the drain.
 */
export function resolveSessionCloseDrainMs(raw?: number): number {
	if (raw === undefined) return SESSION_CLOSE_DRAIN_MS_DEFAULT;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return SESSION_CLOSE_DRAIN_MS_DEFAULT;
	return Math.floor(raw);
}

/**
 * Bounded session-close drain for one scheduler: wait for in-flight work up
 * to drainMs, then abort the owner signal and drop pending captures. Never
 * rejects — disposal must not hang the host on a stuck model call, and the
 * abort below is idempotent when the drain already settled.
 */
export function drainSchedulerOnDispose(scheduler: Pick<ReviewScheduler<TurnSnapshot>, "drain" | "shutdown">, drainMs: number): Promise<void> {
	if (drainMs <= 0) {
		try {
			scheduler.shutdown();
		} catch {
			// shutdown is flag-setting plus abort: nothing observable to do
		}
		return Promise.resolve();
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, drainMs);
	});
	const settle = (): void => {
		if (timer !== undefined) clearTimeout(timer);
		try {
			scheduler.shutdown();
		} catch {
			// same as above — the abort is best-effort by design
		}
	};
	return Promise.race([scheduler.drain(), timeout]).then(settle, settle);
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

export function registerAutoReview(ctx: Context, engine: EvolutionEngine, config: AutoReviewConfig): void {
	const perSession = new Map<string, GateState>();
	const schedulers = new Map<string, ReviewScheduler<TurnSnapshot>>();
	const captureTails = new Map<string, Promise<void>>();
	const disposedSessions = new Set<string>();
	const logger = ctx.logger("continual-evolve");
	const reviewsPath = join(engine.baseDir, "evolve", "reviews.jsonl");
	const defaultEnabled = config.enabledByDefault ?? true;

	const record = (entry: Omit<ReviewRecord, "timestamp">) => {
		try {
			mkdirSync(join(engine.baseDir, "evolve"), { recursive: true });
			appendFileSync(reviewsPath, `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`, "utf8");
		} catch (cause) {
			logger.warn(`failed to record auto-review: ${cause instanceof Error ? cause.message : String(cause)}`);
			return;
		}
		// Storage hygiene (#20): bound the audit trail at write time.
		try {
			pruneJsonlFile(reviewsPath, config.reviewsRetain ?? DEFAULT_REVIEWS_RETAIN);
		} catch {
			// ignored — the next record retries
		}
	};

	const schedulerFor = (agent: Agent, state: GateState): ReviewScheduler<TurnSnapshot> => {
		const existing = schedulers.get(agent.id);
		if (existing) return existing;
		const scheduler = createReviewScheduler<TurnSnapshot>(
			async ({ snapshot, signal }) => {
				if (!isGateEnabled(engine.baseDir, defaultEnabled)) return "aborted";
				if (!snapshot.eligible) {
					record({
						sessionId: snapshot.sessionId,
						reason: snapshot.reason,
						turnsSinceLastReview: state.turns - state.lastReviewAt,
						outcome: "skipped",
						rationale: `snapshot ${snapshot.cursor} skipped: ${snapshot.skipReason ?? "not eligible"}`,
					});
					return "no-op";
				}
				try {
					await runMemoryExtractionPhase(ctx, engine, agent, config, state, snapshot, record, signal);
					return "success";
				} catch (cause) {
					const message = cause instanceof Error ? cause.message : String(cause);
					logger.warn(`memory extraction failed for ${agent.id}: ${message}`);
					record({
						sessionId: agent.id,
						reason: snapshot.reason,
						turnsSinceLastReview: state.turns - state.lastReviewAt,
						outcome: "failed",
						rationale: `extraction error: ${message}`,
					});
					return "error";
				}
			},
			(snapshot) => snapshot.cursor,
		);
		schedulers.set(agent.id, scheduler);
		return scheduler;
	};

	const captureAndSchedule = (agent: Agent, state: GateState, reason: TurnSnapshot["reason"]): void => {
		if (disposedSessions.has(agent.id) || !isGateEnabled(engine.baseDir, defaultEnabled)) return;
		const previousCapture = captureTails.get(agent.id) ?? Promise.resolve();
		const captureTask = previousCapture.then(async () => {
			if (disposedSessions.has(agent.id) || !isGateEnabled(engine.baseDir, defaultEnabled)) return;
			const cursor = schedulerFor(agent, state).getCursor();
			const snapshot = await captureTurnSnapshot(ctx, agent, {
				turn: state.completedTurn,
				reason,
				...(cursor !== undefined ? { cursor } : {}),
				maxChars: config.maxInputChars,
				...(config.memoryMinUserWords !== undefined ? { minUserWords: config.memoryMinUserWords } : {}),
			});
			if (!disposedSessions.has(agent.id)) schedulerFor(agent, state).schedule(snapshot);
		}).catch((cause) => {
			const message = cause instanceof Error ? cause.message : String(cause);
			logger.warn(`memory snapshot failed for ${agent.id}: ${message}`);
			record({
				sessionId: agent.id,
				reason,
				turnsSinceLastReview: state.turns - state.lastReviewAt,
				outcome: "failed",
				rationale: `snapshot error: ${message}`,
			});
		});
		captureTails.set(agent.id, captureTask);
	};

	// DSH emits this awaited boundary when a turn is about to close. It only
	// advances the mechanical counters — extraction is moment-driven, so a
	// successful turn never costs an LLM call by itself.
	ctx.on("agent/turn-stopping", (payload: { agent?: Agent; turn?: number }) => {
		const agent = payload.agent;
		if (!agent) {
			logger.warn(`memory extraction listener: agent/turn-stopping payload missing agent; skipping count`);
			return;
		}
		const state = stateFor(perSession, agent.id);
		state.turns += 1;
		if (typeof payload.turn === "number") state.completedTurn = Math.max(state.completedTurn, payload.turn);
	});

	// The idle transition is the safe point at which to read the durable
	// surface. It probes the goal phase (mechanical, zero LLM) and fires the
	// goal-blocked moment when the streak reaches the threshold.
	ctx.on("agent/status", (payload: { agent?: Agent; status?: string }) => {
		const agent = payload.agent;
		if (!agent || payload.status !== "idle") return;
		if (config.goalBlockedWrapupTurns <= 0) return;
		const state = stateFor(perSession, agent.id);
		const goal = goalServiceOf(ctx)?.get(agent);
		if (goal?.phase !== "blocked") {
			state.goalBlockStreak = 0;
			return;
		}
		state.goalBlockStreak += 1;
		if (state.goalBlockStreak < config.goalBlockedWrapupTurns) return;
		state.goalBlockStreak = 0; // one moment per streak; declines re-arm after the next full streak
		logger.info(`goal-blocked moment [${agent.id}]: ${config.goalBlockedWrapupTurns} consecutive blocked rounds → memory extraction`);
		captureAndSchedule(agent, state, "goal_blocked");
	});

	// Diagnostic: the armed marker proves the listener was registered even when
	// its runtime default is off, distinguishing "not registered" from "off".
	try {
		mkdirSync(join(engine.baseDir, "evolve"), { recursive: true });
		appendFileSync(
			reviewsPath,
			`${JSON.stringify({
				timestamp: new Date().toISOString(),
				sessionId: "boot",
				reason: "boot",
				turnsSinceLastReview: 0,
				outcome: "armed",
				rationale: `automatic evolution listener registered (mode=memory-only; default=${defaultEnabled ? "on" : "off"}; moments=compaction/goal-blocked/session-close-drain/manual-wrapup)`,
			})}\n`,
			"utf8",
		);
	} catch (cause) {
		logger.warn(`failed to write armed marker: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	try {
		pruneJsonlFile(reviewsPath, config.reviewsRetain ?? DEFAULT_REVIEWS_RETAIN);
	} catch {
		// ignored — the next record retries
	}

	ctx.on("agent/disposed", (payload: { agent?: Agent }) => {
		const agent = payload.agent;
		if (!agent) return;
		disposedSessions.add(agent.id);
		const scheduler = schedulers.get(agent.id);
		schedulers.delete(agent.id);
		captureTails.delete(agent.id);
		perSession.delete(agent.id);
		if (scheduler) {
			// Bounded session-close drain: an in-flight extraction gets drainMs
			// to settle so its result is not lost on session close; afterwards
			// the owner signal aborts. Fire-and-forget — disposal must never
			// hang the host, and the helper never rejects.
			void drainSchedulerOnDispose(scheduler, resolveSessionCloseDrainMs(config.sessionCloseDrainMs));
		}
	});

	ctx.on("session/event", (session: { id: string }, event: { type: string }) => {
		// Compaction moment: extract before the pre-compaction trajectory is
		// summarized away. Cold sessions (no live agent) are ignored.
		if (event.type !== "compaction/start") return;
		const agents = (ctx as unknown as { agents?: { get(id: string): Agent | undefined } }).agents;
		const agent = agents?.get(session.id);
		if (!agent) return;
		const state = stateFor(perSession, agent.id);
		captureAndSchedule(agent, state, "compact");
	});
}

/**
 * Gap C1: parse a "provider/model" or "model" string into its components.
 * Returns undefined when the input is empty (no override). A bare model name
 * falls back to the agent's provider, then "deepseek".
 * Exported for unit testing (the advanceGateState precedent); production
 * resolves it inside runMemoryExtractionPhase.
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

function stateFor(map: Map<string, GateState>, sessionId: string): GateState {
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

function advanceMemoryCheckpoint(state: GateState, next: string): void {
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
 * The dedicated ZCode-style memory phase. Owns its request loop, manifest and
 * memory-only tool policy. Its phase-specific checkpoint advances after a
 * successful/no-op memory outcome; memory failures leave the boundary
 * retryable.
 */
export async function runMemoryExtractionPhase(
	ctx: Context,
	engine: EvolutionEngine,
	agent: Agent,
	config: AutoReviewConfig,
	state: GateState,
	snapshot: TurnSnapshot,
	record: (entry: Omit<ReviewRecord, "timestamp">) => void,
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
	const declinedHit = matchDeclinedCheckpoint(loadDeclinedMemory(engine.baseDir), tokenize(memorySnapshot.trajectory));
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
		sessionId: asLlmSessionId(sessionId),
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
