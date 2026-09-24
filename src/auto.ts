/**
 * The automatic evolution driver: watches agent turns and session compaction.
 * In the production wiring it runs only the dedicated Memory Agent; the
 * general review/planner and local-fate phases remain available to direct
 * callers but are not entered by memory-only mode. All auxiliary work is
 * fire-and-forget with error containment: an automatic failure never disturbs
 * the agent loop.
 *
 * Every gate decision (approved / declined / failed / skipped) is appended to
 * `<dshHome>/evolve/reviews.jsonl` so auto-review activity is durably
 * auditable — the server console is not a reliable place to look.
 *
 * Hook wiring:
 * - `agent/turn-stopping` records the successful turn boundary.
 * - `agent/status` (idle) captures an incremental snapshot and feeds the
 *   per-session latest-pending serial scheduler.
 * - `session/event` (compaction/start) forces a snapshot flush before data is
 *   summarized away.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ScopeApprovalDecision } from "./approval.js";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { HarnessState, RefinementEdit, RefinementProposal } from "./types.js";
import { slug } from "./types.js";
import type { EvolutionEngine } from "./service.js";
import { planWithLlm } from "./planner.js";
import { reviewAutoRefine, type AutoRefineReason } from "./review.js";
import { goalServiceOf } from "./goal.js";
import { notifyAutoReview } from "./notify.js";
import { runLocalFatePhase } from "./fate.js";
import { mergeHarnessStates } from "./state.js";
import { projectKeyOf } from "./project.js";
import { questionServiceOf } from "./approval.js";
import { buildEvolveCompleteEvent, emitEvolveComplete } from "./evolve-event.js";
import { DEFAULT_REVIEWS_RETAIN, pruneJsonlFile } from "./store.js";
import { isGateEnabled } from "./runtime.js";
import { compareReviewCursors, createReviewScheduler, type ReviewScheduler } from "./review-scheduler.js";
import { captureTurnSnapshot, sliceTurnSnapshot, type TurnSnapshot } from "./turn-snapshot.js";
import { captureAutoCase } from "./autocase.js";
import {
	applyMemoryExtractionProposal,
	buildMemoryManifest,
	runMemoryAgent,
	type MemoryScopeBaselines,
} from "./memory-agent.js";
import type { PromotionPolicy } from "./promotion.js";
import { asLlmSessionId } from "./llm-text.js";
import type { PlannerPrefixCacheMode } from "./prefix-cache.js";

export interface AutoReviewConfig {
	/** Legacy fate cadence; successful turns are no longer gated by this value. */
	intervalTurns: number;
	/** Initial runtime state when no runtime.json exists. */
	enabledByDefault?: boolean;
	/**
	 * Run only the dedicated memory extraction phase. The general review,
	 * planner, prompt/skill writes, and local-fate phases are never entered.
	 */
	memoryOnly?: boolean;
	maxInputChars: number;
	budgetTokens: number;
	/** Queue a visible follow-up notice after an approved, applied gate run. */
	notifyOnAutoReview: boolean;
	/**
	 * Local-fate dimension (#11 P2): the gate audits the session's local
	 * entries on its own cadence and proposes promote/archive (consulted
	 * first — never written silently). Off disables the whole dimension.
	 */
	localFate: boolean;
	/**
	 * Minimum turns between local-fate assessments on the successful-turn path
	 * (compaction is unconditional). Independent of snapshot review cadence so
	 * eligible turns do not pay an assessment every round.
	 */
	fateIntervalTurns: number;
	/**
	 * Gap C1: optional model override for the review gate (cheaper model).
	 * Format: "provider/model" or just "model" (same provider as the agent).
	 * When absent, the review gate uses the agent's own provider/model.
	 */
	reviewModel?: string;
	/** Dedicated memory-agent writes to project/global require the normal human approval boundary. */
	requireGlobalApproval?: boolean;
	/**
	 * Prefix-cache routing for the gate input (see reviewAutoRefine).
	 * Absent mode → auto-detect; absent budget → the default prefix budget.
	 */
	prefixCacheMode?: PlannerPrefixCacheMode;
	prefixMaxChars?: number;
	/**
	 * Goal-blocked trigger (D3): after this many CONSECUTIVE gate runs that
	 * observe the session goal in phase "blocked", run one local-fate
	 * assessment (the same audit → classify → consult → apply pipeline as the
	 * gate's normal fate dimension) so the blocked encounter is distilled
	 * before the session moves on. 0 disables. The streak resets on any
	 * non-blocked run and after each triggered assessment; a declined
	 * proposal then follows the normal fate cooldown.
	 */
	goalBlockedWrapupTurns: number;
	/**
	 * Promotion policy (2026-08-22): mechanical promote guards applied by the
	 * local-fate dimension before anything reaches the global store.
	 */
	promotionPolicy: PromotionPolicy;
	/**
	 * P1 auto-case capture: a gate run whose planned edits all failed to get
	 * consent captures the attempt as a draft regression scaffold in the
	 * auto-regression container benchmark (never in a user benchmark).
	 */
	autoCase: boolean;
	/** Resolved rubric key for the capture's encrypted scaffold rubric. */
	rubricKey?: Buffer;
	/**
	 * Storage hygiene (#20): tail lines kept in the shared reviews.jsonl
	 * audit trail. Absent → the store default (readers need a recent
	 * window, not the full past).
	 */
	reviewsRetain?: number;
}

export interface GateState {
	turns: number;
	/** Latest successful turn boundary seen by the listener. */
	completedTurn: number;
	/** Latest turn whose snapshot acquisition was reserved. */
	lastSnapshotTurn: number;
	/** Latest successful/no-op memory boundary, independent of later review/fate completion. */
	memoryCheckpoint?: string;
	/** Per-boundary/scope approval decisions retained until the memory phase settles. */
	memoryDecisions: Record<string, ScopeApprovalDecision>;
	lastReviewAt: number;
	running: boolean;
	/**
	 * Per-candidate turn at which the user last rejected a skill proposal;
	 * consulted skill proposals are not offered again within the cooldown
	 * window (skills are governed resources — no nagging).
	 */
	skillRejects: Map<string, number>;
	/** Turn at which the local-fate dimension last assessed (cadence). */
	lastFateAt: number;
	/**
	 * Per-candidate-set turn at which the user last declined a local-fate
	 * proposal; declined sets are not offered again within the cooldown
	 * window (the consultSkillEdits pattern — no nagging).
	 */
	fateRejects: Map<string, number>;
	/**
	 * Consecutive gate runs that observed the goal phase "blocked" (D3).
	 * Reset to 0 by any non-blocked run and after a triggered assessment —
	 * see runGoalBlockedFate.
	 */
	goalBlockStreak: number;
}

/** Turns a rejected skill candidate stays silent before being offered again. */
export const SKILL_CONSULT_COOLDOWN_TURNS = 10;

export interface ReviewRecord {
	timestamp: string;
	sessionId: string;
	reason: AutoRefineReason;
	turnsSinceLastReview: number;
	outcome: "approved" | "declined" | "failed" | "assessed" | "deferred" | "skipped" | "armed";
	rationale?: string;
	refinementId?: string;
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
					if (config.memoryOnly) {
						await runMemoryExtractionPhase(ctx, engine, agent, config, state, snapshot, signal);
					} else {
						await runGate(ctx, engine, agent, config, state, snapshot, record, signal);
					}
					return "success";
				} catch (cause) {
					const message = cause instanceof Error ? cause.message : String(cause);
					logger.warn(`auto-review failed for ${agent.id}: ${message}`);
					record({
						sessionId: agent.id,
						reason: snapshot.reason,
						turnsSinceLastReview: state.turns - state.lastReviewAt,
						outcome: "failed",
						rationale: `gate error: ${message}`,
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
		const turn = state.completedTurn;
		const previousSnapshotTurn = state.lastSnapshotTurn;
		if (reason === "turn_snapshot" && turn <= previousSnapshotTurn) return;
		if (reason === "turn_snapshot") state.lastSnapshotTurn = turn;
		const previousCapture = captureTails.get(agent.id) ?? Promise.resolve();
		const captureTask = previousCapture.then(async () => {
			if (disposedSessions.has(agent.id) || !isGateEnabled(engine.baseDir, defaultEnabled)) return;
			const cursor = schedulerFor(agent, state).getCursor();
			const snapshot = await captureTurnSnapshot(ctx, agent, {
				turn,
				reason,
				...(cursor !== undefined ? { cursor } : {}),
				maxChars: config.maxInputChars,
			});
			if (!disposedSessions.has(agent.id)) schedulerFor(agent, state).schedule(snapshot);
		}).catch((cause) => {
			const message = cause instanceof Error ? cause.message : String(cause);
			logger.warn(`auto-review snapshot failed for ${agent.id}: ${message}`);
			record({
				sessionId: agent.id,
				reason,
				turnsSinceLastReview: state.turns - state.lastReviewAt,
				outcome: "failed",
				rationale: `snapshot error: ${message}`,
			});
			if (reason === "turn_snapshot" && state.lastSnapshotTurn === turn) {
				state.lastSnapshotTurn = previousSnapshotTurn;
			}
		});
		captureTails.set(agent.id, captureTask);
	};

	// DSH emits this awaited boundary when a turn is about to close. The idle
	// transition is the safe point at which to read the durable surface.
	ctx.on("agent/turn-stopping", (payload: { agent?: Agent; turn?: number }) => {
		const agent = payload.agent;
		if (!agent) {
			logger.warn(`auto-review gate: agent/turn-stopping payload missing agent; skipping count`);
			return;
		}
		const state = stateFor(perSession, agent.id);
		state.turns += 1;
		if (typeof payload.turn === "number") state.completedTurn = Math.max(state.completedTurn, payload.turn);
	});

	ctx.on("agent/status", (payload: { agent?: Agent; status?: string }) => {
		const agent = payload.agent;
		if (!agent || payload.status !== "idle") return;
		const state = stateFor(perSession, agent.id);
		if (state.completedTurn <= state.lastSnapshotTurn) return;
		captureAndSchedule(agent, state, "turn_snapshot");
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
				rationale: `automatic evolution listener registered (mode=${config.memoryOnly ? "memory-only" : "full"}; default=${defaultEnabled ? "on" : "off"}; per-success-turn snapshots)`,
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
		schedulers.get(agent.id)?.shutdown();
		schedulers.delete(agent.id);
		captureTails.delete(agent.id);
		perSession.delete(agent.id);
	});

	ctx.on("session/event", (session: { id: string }, event: { type: string }) => {
		if (event.type !== "compaction/start") return;
		const agents = (ctx as unknown as { agents?: { get(id: string): Agent | undefined } }).agents;
		const agent = agents?.get(session.id);
		if (!agent) return; // no live agent for that session (e.g. cold read)
		const state = stateFor(perSession, agent.id);
		captureAndSchedule(agent, state, "compact");
	});
}

/**
 * Gap C1: parse a "provider/model" or "model" string into its components.
 * Returns undefined when the input is empty (no override). A bare model name
 * falls back to the agent's provider, then "deepseek".
 * Exported for unit testing (the advanceGateState precedent); production
 * resolves it inside runReviewPhase.
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
			lastSnapshotTurn: 0,
			memoryDecisions: {},
			lastReviewAt: 0,
			running: false,
			skillRejects: new Map(),
			lastFateAt: 0,
			fateRejects: new Map(),
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
 * The state view the gate and planner judge: the session's local entries
 * merged with the project and global stores, each entry carrying its real
 * scope. Without the global half the gate cannot see that a topic is already
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
 * One gate run = review phase + local-fate phase (#11 P2). The review phase
 * judges and applies local refinements; the local-fate phase then gives the
 * session's existing local entries a running exit (promote/archive proposals,
 * consulted before they land). Running fate AFTER the review keeps the
 * review's baseline fresh — fate re-loads the store and never races the
 * review's optimistic-concurrency checks.
 */
async function runGate(
	ctx: Context,
	engine: EvolutionEngine,
	agent: Agent,
	config: AutoReviewConfig,
	state: GateState,
	snapshot: TurnSnapshot,
	record: (entry: Omit<ReviewRecord, "timestamp">) => void,
	signal?: AbortSignal,
): Promise<void> {
	// Reentry guard (review audit 2026-08-28 S3): a gate run holds LLM calls
	// and possibly a user question for a long time; an idle/compaction
	// trigger overlapping the run would start a second concurrent pipeline
	// whose stale whole-file saves clobber the first run's writes.
	if (state.running) {
		throw new Error(`previous gate run still in flight for ${agent.id}`);
	}
	state.running = true;
	try {
		await runMemoryExtractionPhase(ctx, engine, agent, config, state, snapshot, signal);
		await runReviewPhase(ctx, engine, agent, config, state, snapshot, record, signal);
		// D3: a goal stuck in "blocked" for consecutive gate runs gets one
		// local-fate assessment (the pipeline below), so whatever led the
		// goal astray is distilled before the session moves on.
		await runGoalBlockedFate(ctx, engine, agent, config, state, snapshot.reason, record);
		await runLocalFatePhase(ctx, engine, agent, config, state, snapshot.reason, record);
	} finally {
		state.running = false;
	}
}

/**
 * D3 (goal blocked → wrap-up coupling, reverse direction): count consecutive
 * gate runs whose goal is in phase "blocked"; when the streak reaches
 * `goalBlockedWrapupTurns`, run ONE local-fate assessment (same pipeline as
 * the normal fate dimension — audit, classify, consult, apply deterministically).
 * The streak resets on any non-blocked run and after a triggered assessment;
 * a declined proposal is then protected by the normal fate cooldown, so a
 * blocked session can never be nagged into another dialog.
 *
 * Exported for unit testing (the advanceGateState precedent); production runs
 * it from runGate.
 */
export async function runGoalBlockedFate(
	ctx: Context,
	engine: EvolutionEngine,
	agent: Agent,
	config: AutoReviewConfig,
	state: GateState,
	_reason: AutoRefineReason,
	record: (entry: Omit<ReviewRecord, "timestamp">) => void,
): Promise<void> {
	if (config.goalBlockedWrapupTurns <= 0) return;
	const goal = goalServiceOf(ctx)?.get(agent);
	if (goal?.phase !== "blocked") {
		state.goalBlockStreak = 0;
		return;
	}
	state.goalBlockStreak += 1;
	if (state.goalBlockStreak < config.goalBlockedWrapupTurns) {
		return;
	}
	state.goalBlockStreak = 0; // one assessment per streak; declines follow the fate cooldown
	const logger = ctx.logger("continual-evolve");
	logger.info(`auto-review goal-blocked trigger [${agent.id}]: ${config.goalBlockedWrapupTurns} consecutive blocked gate runs → local-fate assessment`);
	await runLocalFatePhase(ctx, engine, agent, config, state, "goal_blocked", record);
}

/**
 * Dedicated ZCode-style memory phase. It shares the scheduler snapshot and
 * snapshot with the general review, but owns its request loop, manifest and
 * memory-only tool policy. Its phase-specific checkpoint advances after a
 * successful/no-op memory outcome; later review/fate failures do not replay
 * old memory decisions, while memory failures leave the boundary retryable.
 */
export async function runMemoryExtractionPhase(
	ctx: Context,
	engine: EvolutionEngine,
	agent: Agent,
	config: AutoReviewConfig,
	state: GateState,
	snapshot: TurnSnapshot,
	signal?: AbortSignal,
): Promise<void> {
	const memorySnapshot = state.memoryCheckpoint ? sliceTurnSnapshot(snapshot, state.memoryCheckpoint) : snapshot;
	if (!memorySnapshot.eligible || !memorySnapshot.trajectory) {
		advanceMemoryCheckpoint(state, snapshot.cursor);
		ctx.logger("continual-evolve").info(`memory agent no-op (${snapshot.reason}) [${agent.id}]: no new eligible evidence after checkpoint`);
		return;
	}
	const sessionId = agent.id;
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
	ctx.logger("continual-evolve").info(
		`memory agent applied ${applied} edit(s) across ${application.results.length} scope batch(es) [${sessionId}] after ${run.turns} turn(s)${declined}: ${run.proposal.rationale}`,
	);
}

async function runReviewPhase(
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
	const reason = snapshot.reason;
	const turnsSinceLastReview = state.turns - state.lastReviewAt;
	const logger = ctx.logger("continual-evolve");
	const tokenUsage = {
		baseDir: engine.baseDir,
		sessionId,
		retain: engine.retention.tokenUsage,
		onError: (cause: unknown) => logger.warn(`token-usage ledger failed for ${sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`),
	};

	const trajectory = snapshot.trajectory;
	if (!trajectory) {
		throw new Error("eligible snapshot has no trajectory");
	}

	// The gate judges the merged view (global + local, scopes labeled) so it
	// can recognize topics already covered globally and decline duplicates;
	// applying still targets the raw local store.
	const localState = engine.load("local", sessionId);
	const projectKey = projectKeyOf(agent);
	const harnessState = loadGateHarnessView(engine, sessionId, projectKey ? { projectKey } : undefined);
	const history = engine.history("local", sessionId);
	// Gap C1: resolve optional review model override.
	const reviewRoute = parseReviewModel(config.reviewModel, agent.options.provider);
	const review = await reviewAutoRefine(ctx, {
		agent,
		state: harnessState,
		history,
		trajectory,
		trajectoryEvents: snapshot.events,
		...(signal ? { signal } : {}),
		context: { reason, turnsSinceLastReview },
		budgetTokens: config.budgetTokens,
		tokenUsage,
		...(reviewRoute ? { overrideProvider: reviewRoute.provider, overrideModel: reviewRoute.model } : {}),
		...((config.prefixCacheMode !== undefined || config.prefixMaxChars !== undefined
			? {
					prefixCache: {
						...(config.prefixCacheMode !== undefined ? { mode: config.prefixCacheMode } : {}),
						...(config.prefixMaxChars !== undefined ? { maxChars: config.prefixMaxChars } : {}),
					},
				}
			: {})),
	});
	state.lastReviewAt = state.turns;

	if (!review.shouldRefine) {
		logger.info(`auto-review declined (${reason}) [${sessionId}] after ${turnsSinceLastReview} turns: ${review.rationale}`);
		record({ sessionId, reason, turnsSinceLastReview, outcome: "declined", rationale: review.rationale });
		return;
	}

	const plannedProposal = await planWithLlm(ctx, {
		agent,
		state: harnessState,
		history,
		trajectory: snapshot.trajectory,
		trajectoryEvents: snapshot.events,
		...(signal ? { signal } : {}),
		...(review.instructions ? { instructions: review.instructions } : {}),
		global: false,
		// Read the skill-creator template facts (fallback: builtin distilled
		// guide) so skill proposals follow the standard.
		skillsRoot: join(engine.baseDir, "skills"),
		tokenUsage,
		...((config.prefixCacheMode !== undefined || config.prefixMaxChars !== undefined
			? {
					prefixCache: {
						...(config.prefixCacheMode !== undefined ? { mode: config.prefixCacheMode } : {}),
						...(config.prefixMaxChars !== undefined ? { maxChars: config.prefixMaxChars } : {}),
					},
				}
			: {})),
	});
	const proposal = stripDedicatedMemoryEdits(plannedProposal);
	const memoryOnlyPlan = isDedicatedMemoryOnlyProposal(plannedProposal);
	// Skills are governed resources: an auto-created skill is OFFERED to the
	// user for a decision (固化/不固化) before it lands — the gate never
	// writes a skill silently. Without consent the skill edits are withheld
	// and the rest of the proposal proceeds as usual.
	const { skillEdits, otherEdits } = splitSkillEdits(proposal);
	const skillConsented = await consultSkillEdits(ctx, agent, skillEdits, state);
	const finalProposal = skillConsented
		? proposal
		: {
				...proposal,
				edits: otherEdits,
				summary:
					skillEdits.length > 0 ? `${proposal.summary} (skill edits withheld — pending user decision)` : proposal.summary,
			};
	if (finalProposal.edits.length === 0) {
		const withheld = skillEdits.length > 0 ? " (skill proposal withheld — user not consulted or declined)" : "";
		logger.info(`auto-review declined (${reason}) [${sessionId}]: no consented edits${withheld} — ${review.rationale}`);
		// P1 auto-case capture: an attempted evolution that never landed is a
		// regression asset. Contained — capture failure must not disturb the gate.
		if (config.autoCase && !memoryOnlyPlan) {
			try {
				const captured = captureAutoCase({
					baseDir: engine.baseDir,
					rubricKey: config.rubricKey,
					source: "gate_no_consent",
					sessionId,
					summary: finalProposal.summary,
					reasons: [review.rationale],
				});
				logger.info(`auto-review auto-case captured (${reason}) [${sessionId}]: ${captured.caseId}`);
			} catch (cause) {
				logger.warn(`auto-case capture failed for ${sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`);
			}
		}
		record({ sessionId, reason, turnsSinceLastReview, outcome: "declined", rationale: `${review.rationale}${withheld}` });
		return;
	}
	const source = { sessionId, ...(snapshot.sourceSeqs.length > 0 ? { seqs: [...snapshot.sourceSeqs] } : {}) };
	const result = engine.apply("local", sessionId, finalProposal, {
		scope: "local",
		baselineState: localState,
		...(source ? { source } : {}),
	});
	logger.info(
		`auto-review approved (${reason}) [${sessionId}] after ${turnsSinceLastReview} turns; auto-refine ${result.id}: ${result.appliedEdits.filter((e) => e.applied).length} applied, ${result.appliedEdits.filter((e) => !e.applied).length} failed — ${review.rationale}`,
	);
	record({ sessionId, reason, turnsSinceLastReview, outcome: "approved", rationale: review.rationale, refinementId: result.id });
	// Gap C4: emit structured evolve_complete event for third-party consumers.
	emitEvolveComplete(engine.baseDir, buildEvolveCompleteEvent(result, `auto_review:${reason}`, sessionId), config.reviewsRetain ?? DEFAULT_REVIEWS_RETAIN);
	// Visibility: tell the user what the gate just persisted. Only the
	// turn snapshot path notifies — a compaction-triggered gate must not wake
	// the agent mid-compaction — and only when something was actually applied
	// (a notice for zero edits is noise). Failure is contained in notifyAutoReview.
	if (config.notifyOnAutoReview && reason === "turn_snapshot" && result.appliedEdits.some((e) => e.applied)) {
		notifyAutoReview(ctx, agent, result, turnsSinceLastReview);
	}
}

/** True when the general planner returned only edits owned by the memory phase. */
export function isDedicatedMemoryOnlyProposal(proposal: RefinementProposal): boolean {
	return proposal.edits.length > 0 && proposal.edits.every((edit) => edit.kind === "memory");
}

/**
 * Remove memory edits from the general auto-review planner. The dedicated
 * memory phase owns this responsibility and has already run against the same
 * snapshot; accepting a second memory proposal would reintroduce duplicates.
 */
export function stripDedicatedMemoryEdits(proposal: RefinementProposal): RefinementProposal {
	const edits = proposal.edits.filter((edit) => edit.kind !== "memory");
	if (edits.length === proposal.edits.length) return proposal;
	return {
		...proposal,
		edits,
		summary: `${proposal.summary} (memory edits owned by dedicated extractor)`,
	};
}

/**
 * Split a proposal into skill edits and everything else. Skill edits are the
 * governed part: they need explicit user consent before the gate applies
 * them, while the remaining edits flow through the normal auto path.
 */
export function splitSkillEdits(proposal: RefinementProposal): {
	skillEdits: RefinementEdit[];
	otherEdits: RefinementEdit[];
} {
	return {
		skillEdits: proposal.edits.filter((edit) => edit.kind === "skill"),
		otherEdits: proposal.edits.filter((edit) => edit.kind !== "skill"),
	};
}

/**
 * Ask the user whether to solidify proposed skill edits (guidance or
 * executable) into the harness. Returns true when every skill edit is
 * consented. Never writes a skill silently:
 * - no question service available → false (conservative);
 * - the same candidate was rejected within the cooldown window → false
 *   without asking again (no nagging);
 * - the user declines → false and the rejection is recorded for cooldown;
 * - the question call fails/aborts → false (conservative).
 */
export async function consultSkillEdits(
	ctx: Context,
	agent: Agent,
	skillEdits: RefinementEdit[],
	gate: GateState,
): Promise<boolean> {
	if (skillEdits.length === 0) return true;
	const key = skillEdits.map((edit) => edit.id ?? slug(edit.title ?? edit.kind, edit.kind)).join("|");
	const lastReject = gate.skillRejects.get(key);
	if (lastReject !== undefined && gate.turns - lastReject < SKILL_CONSULT_COOLDOWN_TURNS) {
		return false;
	}
	const userQuestions = questionServiceOf(ctx);
	if (!userQuestions) {
		return false;
	}
	const description = skillEdits
		.map((edit) => {
			const form = edit.skill_kind === "guidance" ? "guidance 技能（SKILL.md 文档）" : "可执行技能";
			return `- ${edit.action}「${edit.title ?? edit.id}」(${form})`;
		})
		.join("\n");
	try {
		const answer = await userQuestions.ask({
			questions: [
				{
					id: "evolve-skill-consult",
					question: `自进化检测到反复出现的流程/技能候选，建议沉淀：\n\n${description}\n\n是否固化？`,
					options: [{ label: "固化" }, { label: "不固化" }],
				},
			],
			agent,
		});
		const item = answer.answers?.find((entry) => entry.id === "evolve-skill-consult");
		const consented = item?.selected?.includes("固化") ?? false;
		if (!consented) {
			gate.skillRejects.set(key, gate.turns);
		}
		return consented;
	} catch {
		return false;
	}
}
