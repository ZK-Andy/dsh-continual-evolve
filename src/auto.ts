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
import type { HarnessState, RefinementEdit, RefinementProposal } from "./types.js";
import { slug } from "./types.js";
import type { EvolutionEngine } from "./service.js";
import { planWithLlm } from "./planner.js";
import { reviewAutoRefine, serializeSurface, type AutoRefineReason } from "./review.js";
import { goalServiceOf } from "./goal.js";
import { notifyAutoReview } from "./notify.js";
import { runLocalFatePhase } from "./fate.js";
import { entrySourceOf } from "./source.js";
import { mergeHarnessStates } from "./state.js";
import { questionServiceOf } from "./approval.js";
import { buildEvolveCompleteEvent, emitEvolveComplete } from "./evolve-event.js";

export interface AutoReviewConfig {
	intervalTurns: number;
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
	 * Minimum turns between local-fate assessments on the turn-interval path
	 * (compaction is unconditional). Independent of the review cadence so
	 * goal-driven sessions (gate every round) do not pay an assessment per
	 * round.
	 */
	fateIntervalTurns: number;
	/**
	 * Gap C1: optional model override for the review gate (cheaper model).
	 * Format: "provider/model" or just "model" (same provider as the agent).
	 * When absent, the review gate uses the agent's own provider/model.
	 */
	reviewModel?: string;
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
}

export interface GateState {
	turns: number;
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
	outcome: "approved" | "declined" | "failed" | "assessed" | "deferred";
	rationale?: string;
	refinementId?: string;
}

/**
 * Count completed turns from agent/status transitions (running → idle).
 * Exported for unit testing; production counting uses agent/turn-stopping
 * (see registerAutoReview) which empirically carries the agent subject.
 */
export function advanceGateState(state: GateState, status: string): boolean {
	if (status === "running") {
		state.running = true;
		return false;
	}
	if (status === "idle" && state.running) {
		state.running = false;
		state.turns += 1;
		return true;
	}
	return false;
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

	// Turn counting uses `agent/turn-stopping` — empirically the only event
	// whose payload carries the agent subject in every dispatch (verified: the
	// gate fired under it at 20:56). `agent/status` serves as the idle trigger.
	ctx.on("agent/turn-stopping", (payload: { agent?: Agent }) => {
		const agent = payload.agent;
		if (!agent) {
			logger.warn(`auto-review gate: agent/turn-stopping payload missing agent; skipping count`);
			return;
		}
		const state = stateFor(perSession, agent.id);
		state.turns += 1;
	});

	ctx.on("agent/status", (payload: { agent?: Agent; status?: string }) => {
		const agent = payload.agent;
		if (!agent || payload.status !== "idle") return;
		const state = stateFor(perSession, agent.id);
		// v3 optional: an active evolution goal drives the gate EVERY round
		// (the goal's round machine keeps the session continuing); without a
		// goal the plain turn interval applies.
		const goalDriven = goalServiceOf(ctx)?.get(agent)?.phase === "active";
		if (!goalDriven && state.turns - state.lastReviewAt < config.intervalTurns) return;
		// Run the gate outside the listener turn: agent is idle, work is auxiliary.
		// Every failure is durably recorded — nothing fails silently.
		void runGate(ctx, engine, agent, config, state, "turn_interval", record).catch((cause) => {
			const message = cause instanceof Error ? cause.message : String(cause);
			logger.warn(`auto-review failed for ${agent.id}: ${message}`);
			record({
				sessionId: agent.id,
				reason: "turn_interval",
				turnsSinceLastReview: state.turns - state.lastReviewAt,
				outcome: "failed",
				rationale: `gate error: ${message}`,
			});
			state.lastReviewAt = state.turns; // back off until the interval elapses again
		});
	});

	// Diagnostic: the armed marker proves registerAutoReview ran with the
	// configured interval; a restart that writes it but nothing after means the
	// trigger events are not reaching this listener.
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
				rationale: `auto-review gate registered (interval=${config.intervalTurns})`,
			})}\n`,
			"utf8",
		);
	} catch (cause) {
		logger.warn(`failed to write armed marker: ${cause instanceof Error ? cause.message : String(cause)}`);
	}

	ctx.on("session/event", (session: { id: string }, event: { type: string }) => {
		if (event.type !== "compaction/start") return;
		const agents = (ctx as unknown as { agents?: { get(id: string): Agent | undefined } }).agents;
		const agent = agents?.get(session.id);
		if (!agent) return; // no live agent for that session (e.g. cold read)
		const state = stateFor(perSession, agent.id);
		// Compaction is unconditional: persist what is about to be summarized away.
		void runGate(ctx, engine, agent, config, state, "compact", record).catch((cause) => {
			logger.warn(`auto-review failed at compaction for ${agent.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
			record({
				sessionId: agent.id,
				reason: "compact",
				turnsSinceLastReview: state.turns - state.lastReviewAt,
				outcome: "failed",
				rationale: `gate error at compaction: ${cause instanceof Error ? cause.message : String(cause)}`,
			});
		});
	});
}

/**
 * Gap C1: parse a "provider/model" or "model" string into its components.
 * Returns undefined when the input is empty (no override).
 */
function parseReviewModel(
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

/**
 * The state view the gate and planner judge: the session's local entries
 * merged with the global store, each entry carrying its real scope. Without
 * the global half the gate cannot see that a topic is already covered
 * cross-session and happily re-sediments a local duplicate of it.
 *
 * The merged view is read-only context — applying still targets the raw
 * local state (baseline checks compare local entries only).
 */
export function loadGateHarnessView(engine: EvolutionEngine, sessionId: string): HarnessState {
	return mergeHarnessStates(engine.load("global", undefined), engine.load("local", sessionId));
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
	reason: AutoRefineReason,
	record: (entry: Omit<ReviewRecord, "timestamp">) => void,
): Promise<void> {
	await runReviewPhase(ctx, engine, agent, config, state, reason, record);
	// D3: a goal stuck in "blocked" for consecutive gate runs gets one
	// local-fate assessment (the pipeline below), so whatever led the goal
	// astray is distilled before the session moves on.
	await runGoalBlockedFate(ctx, engine, agent, config, state, reason, record);
	await runLocalFatePhase(ctx, engine, agent, config, state, reason, record);
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

async function runReviewPhase(
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

	// The gate judges the merged view (global + local, scopes labeled) so it
	// can recognize topics already covered globally and decline duplicates;
	// applying still targets the raw local store.
	const localState = engine.load("local", sessionId);
	const harnessState = loadGateHarnessView(engine, sessionId);
	const history = engine.history("local", sessionId);
	// Gap C1: resolve optional review model override.
	const reviewRoute = parseReviewModel(config.reviewModel, agent.options.provider);
	const review = await reviewAutoRefine(ctx, {
		agent,
		state: harnessState,
		history,
		trajectory,
		context: { reason, turnsSinceLastReview },
		budgetTokens: config.budgetTokens,
		...(reviewRoute ? { overrideProvider: reviewRoute.provider, overrideModel: reviewRoute.model } : {}),
	});
	state.lastReviewAt = state.turns;

	if (!review.shouldRefine) {
		logger.info(`auto-review declined (${reason}) [${sessionId}] after ${turnsSinceLastReview} turns: ${review.rationale}`);
		record({ sessionId, reason, turnsSinceLastReview, outcome: "declined", rationale: review.rationale });
		return;
	}

	const proposal = await planWithLlm(ctx, {
		agent,
		state: harnessState,
		history,
		...(review.instructions ? { instructions: review.instructions } : {}),
		global: false,
		// Read the skill-creator template facts (fallback: builtin distilled
		// guide) so skill proposals follow the standard.
		skillsRoot: join(engine.baseDir, "skills"),
	});
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
		logger.info(`auto-review declined (${reason}) [${sessionId}] after ${turnsSinceLastReview} turns: no consented edits${withheld} — ${review.rationale}`);
		record({ sessionId, reason, turnsSinceLastReview, outcome: "declined", rationale: `${review.rationale}${withheld}` });
		return;
	}
	const source = entrySourceOf(agent, sessionId);
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
	emitEvolveComplete(engine.baseDir, buildEvolveCompleteEvent(result, `auto_review:${reason}`, sessionId));
	// Visibility: tell the user what the gate just persisted. Only the
	// turn-interval path notifies — a compaction-triggered gate must not wake
	// the agent mid-compaction — and only when something was actually applied
	// (a notice for zero edits is noise). Failure is contained in notifyAutoReview.
	if (config.notifyOnAutoReview && reason === "turn_interval" && result.appliedEdits.some((e) => e.applied)) {
		notifyAutoReview(ctx, agent, result, turnsSinceLastReview);
	}
}

async function readTrajectory(ctx: Context, agent: Agent, maxChars: number): Promise<string> {
	const sessionQuery = (ctx as unknown as { sessionQuery?: { readSurface(sessionId: string): Promise<{ events: unknown[] }> } }).sessionQuery;
	if (!sessionQuery) {
		throw new Error("sessionQuery unavailable");
	}
	const snapshot = await sessionQuery.readSurface(agent.id);
	return serializeSurface(snapshot.events, maxChars);
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
