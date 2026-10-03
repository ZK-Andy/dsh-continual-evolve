/**
 * The moment-driven extraction listener: registers the host event wiring and
 * the per-session serial scheduler. The extraction logic itself lives in
 * `extraction-phase.ts`; this module owns only WHEN it runs.
 *
 * Moments (refactor 2026-10-03, B verdict):
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
 * direct LLM calls for a fifth of the sediment (audit 2026-10-03). A
 * successful turn only advances mechanical counters.
 *
 * All auxiliary work is fire-and-forget with error containment: an automatic
 * failure never disturbs the agent loop, and every decision lands in the
 * shared `reviews.jsonl` audit trail (see `audit-log.ts`).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { EvolutionEngine } from "./service.js";
import { goalServiceOf } from "./goal.js";
import { isGateEnabled } from "./runtime.js";
import { createReviewScheduler, type ReviewScheduler } from "./review-scheduler.js";
import { captureTurnSnapshot, type TurnSnapshot } from "./turn-snapshot.js";
import { appendReviewRecord, writeArmedMarker } from "./audit-log.js";
import {
	runMemoryExtractionPhase,
	stateFor,
	type AutoReviewConfig,
	type GateState,
	type ReviewRecorder,
} from "./extraction-phase.js";

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

export function registerAutoReview(ctx: Context, engine: EvolutionEngine, config: AutoReviewConfig): void {
	const perSession = new Map<string, GateState>();
	const schedulers = new Map<string, ReviewScheduler<TurnSnapshot>>();
	const captureTails = new Map<string, Promise<void>>();
	const disposedSessions = new Set<string>();
	const logger = ctx.logger("continual-evolve");
	const defaultEnabled = config.enabledByDefault ?? true;

	const record: ReviewRecorder = (entry) => {
		appendReviewRecord(engine.baseDir, entry, config.reviewsRetain, (cause) =>
			logger.warn(`failed to record auto-review: ${cause instanceof Error ? cause.message : String(cause)}`),
		);
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

	// Boot-time diagnostic: proves the listener was registered even when its
	// runtime default is off, distinguishing "not registered" from "off".
	writeArmedMarker(
		engine.baseDir,
		`automatic evolution listener registered (mode=memory-only; default=${defaultEnabled ? "on" : "off"}; moments=compaction/goal-blocked/session-close-drain/manual-wrapup)`,
		(cause) => logger.warn(`failed to write armed marker: ${cause instanceof Error ? cause.message : String(cause)}`),
	);

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
