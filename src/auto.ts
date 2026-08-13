/**
 * The automatic review driver: watches agent turns and session compaction,
 * runs the cheap review gate, and — when the gate approves — runs the
 * local-scope planner and applies the result. All auxiliary work is
 * fire-and-forget with error containment: an auto-review failure never
 * disturbs the agent loop.
 *
 * Every gate decision (approved / declined / failed) is appended to
 * `<dshHome>/evolve/reviews.jsonl` so auto-review activity is durably
 * auditable — the server console is not a reliable place to look.
 *
 * Hook wiring:
 * - `agent/turn-stopping` increments a per-session turn counter (sync, cheap).
 * - `agent/status` (idle) checks the interval and may start the gate.
 * - `session/event` (compaction/start) starts an unconditional gate run so
 *   experiences about to be summarized away are persisted first.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { EvolutionEngine } from "./service.js";
import { planWithLlm } from "./planner.js";
import { reviewAutoRefine, serializeSurface, type AutoRefineReason } from "./review.js";

export interface AutoReviewConfig {
	intervalTurns: number;
	maxInputChars: number;
	budgetTokens: number;
}

interface GateState {
	turns: number;
	lastReviewAt: number;
}

interface ReviewRecord {
	timestamp: string;
	sessionId: string;
	reason: AutoRefineReason;
	turnsSinceLastReview: number;
	outcome: "approved" | "declined" | "failed";
	rationale?: string;
	refinementId?: string;
}

export function registerAutoReview(ctx: Context, engine: EvolutionEngine, config: AutoReviewConfig): void {
	const perSession = new Map<string, GateState>();
	const logger = ctx.logger("continual-evolve");
	const reviewsPath = join(engine.baseDir, "evolve", "reviews.jsonl");

	const record = (entry: Omit<ReviewRecord, "timestamp">) => {
		try {
			mkdirSync(join(engine.baseDir, "evolve"), { recursive: true });
			appendFileSync(reviewsPath, `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`, "utf8");
		} catch (cause) {
			logger.warn(`failed to record auto-review: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
	};

	ctx.on("agent/turn-stopping", (payload: { agent: Agent }) => {
		const state = stateFor(perSession, payload.agent.id);
		state.turns += 1;
	});

	ctx.on("agent/status", (payload: { agent: Agent; status: string }) => {
		if (payload.status !== "idle") return;
		const agent = payload.agent;
		const state = stateFor(perSession, agent.id);
		if (state.turns - state.lastReviewAt < config.intervalTurns) return;
		// Run the gate outside the listener turn: agent is idle, work is auxiliary.
		void runGate(ctx, engine, agent, config, state, "turn_interval", record).catch((cause) => {
			logger.warn(`auto-review failed for ${agent.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
			state.lastReviewAt = state.turns; // back off until the interval elapses again
		});
	});

	ctx.on("session/event", (session: { id: string }, event: { type: string }) => {
		if (event.type !== "compaction/start") return;
		const agents = (ctx as unknown as { agents?: { get(id: string): Agent | undefined } }).agents;
		const agent = agents?.get(session.id);
		if (!agent) return; // no live agent for that session (e.g. cold read)
		const state = stateFor(perSession, agent.id);
		// Compaction is unconditional: persist what is about to be summarized away.
		void runGate(ctx, engine, agent, config, state, "compact", record).catch((cause) => {
			logger.warn(`auto-review failed at compaction for ${agent.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
		});
	});
}

function stateFor(map: Map<string, GateState>, sessionId: string): GateState {
	let state = map.get(sessionId);
	if (!state) {
		state = { turns: 0, lastReviewAt: 0 };
		map.set(sessionId, state);
	}
	return state;
}

async function runGate(
	ctx: Context,
	engine: EvolutionEngine,
	agent: Agent,
	config: AutoReviewConfig,
	state: GateState,
	reason: AutoRefineReason,
	record: (entry: Omit<ReviewRecord, "timestamp">) => void,
): Promise<void> {
	const sessionId = agent.id;
	const turnsSinceLastReview = state.turns - state.lastReviewAt;
	const logger = ctx.logger("continual-evolve");

	const trajectory = await readTrajectory(ctx, agent, config.maxInputChars).catch((cause) => {
		logger.warn(`auto-review skipped for ${sessionId}: trajectory unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
		record({ sessionId, reason, turnsSinceLastReview, outcome: "failed", rationale: `trajectory unavailable: ${cause instanceof Error ? cause.message : String(cause)}` });
		return undefined;
	});
	if (!trajectory) {
		state.lastReviewAt = state.turns;
		return;
	}

	const harnessState = engine.load("local", sessionId);
	const history = engine.history("local", sessionId);
	const review = await reviewAutoRefine(ctx, {
		agent,
		state: harnessState,
		history,
		trajectory,
		context: { reason, turnsSinceLastReview },
		budgetTokens: config.budgetTokens,
	});
	state.lastReviewAt = state.turns;

	if (!review.shouldRefine) {
		logger.info(`auto-review declined (${reason}) after ${turnsSinceLastReview} turns: ${review.rationale}`);
		record({ sessionId, reason, turnsSinceLastReview, outcome: "declined", rationale: review.rationale });
		return;
	}

	const proposal = await planWithLlm(ctx, {
		agent,
		state: harnessState,
		history,
		...(review.instructions ? { instructions: review.instructions } : {}),
		global: false,
	});
	const result = engine.apply("local", sessionId, proposal, { scope: "local", baselineState: harnessState });
	logger.info(
		`auto-review approved (${reason}) after ${turnsSinceLastReview} turns; auto-refine ${result.id}: ${result.appliedEdits.filter((e) => e.applied).length} applied, ${result.appliedEdits.filter((e) => !e.applied).length} failed — ${review.rationale}`,
	);
	record({ sessionId, reason, turnsSinceLastReview, outcome: "approved", rationale: review.rationale, refinementId: result.id });
}

async function readTrajectory(ctx: Context, agent: Agent, maxChars: number): Promise<string> {
	const sessionQuery = (ctx as unknown as { sessionQuery?: { readSurface(sessionId: string): Promise<{ events: unknown[] }> } }).sessionQuery;
	if (!sessionQuery) {
		throw new Error("sessionQuery unavailable");
	}
	const snapshot = await sessionQuery.readSurface(agent.id);
	return serializeSurface(snapshot.events, maxChars);
}
