/**
 * Goal-driven evolution rounds (v3 optional item, design.md §6): a
 * same-session goal turns the auto-review into a per-round driver — while a
 * goal is active, the review gate runs every round instead of every
 * `reviewIntervalTurns`, so the "continual evolution loop" is driven by the
 * goal's round machine (goal-round-driver keeps the session continuing) and
 * stops when the goal is completed or blocked.
 *
 * The goal service (`ctx.goals`) is resolved lazily and never required
 * (FAQ #1 discipline): without it, `/evolve goal` reports the feature
 * unavailable and auto-review keeps its plain interval.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";

/** The durable goal phases we drive on. */
export type GoalPhase = "active" | "paused" | "blocked" | "complete";

/** Minimal structural view of a goal view (duck-typed against dsh-goal). */
export interface GoalViewLike {
	readonly id: string;
	readonly revision: number;
	readonly objective: string;
	readonly phase: GoalPhase;
	readonly maxGoalRounds: number;
}

export interface GoalRefLike {
	readonly id: string;
	readonly revision: number;
}

export interface GoalServiceLike {
	get(agent: Agent): GoalViewLike | undefined;
	create(agent: Agent, request: { objective: string; maxGoalRounds?: number }): GoalViewLike;
	edit(agent: Agent, ref: GoalRefLike, request: { objective?: string; maxGoalRounds?: number }): GoalViewLike;
	complete(agent: Agent, ref: GoalRefLike): GoalViewLike;
	block?(agent: Agent, ref: GoalRefLike, reason: { code: string; reason: string }): GoalViewLike;
}

/** The default objective used by `/evolve goal` without an explicit one. */
export const DEFAULT_EVOLVE_GOAL_OBJECTIVE =
	"持续进化本会话 harness 状态：每轮沉淀可复用经验（失败/战术/事实/委派规格），保持条目小而带证据";

/** Resolve the goal service lazily; undefined when the profile lacks it. */
export function goalServiceOf(ctx: Context): GoalServiceLike | undefined {
	return (ctx as unknown as { goals?: GoalServiceLike }).goals;
}

/** True when a goal view exists and is in a round-driving phase (active). */
export function goalDrivesRounds(view: GoalViewLike | undefined): boolean {
	return view?.phase === "active";
}

/** True when a goal exists at all (any phase) — used to gate create vs edit. */
export function goalExists(view: GoalViewLike | undefined): view is GoalViewLike {
	return view !== undefined;
}

/** Human-readable one-line status for a goal view. */
export function goalStatusText(view: GoalViewLike): string {
	const rounds = typeof (view as { roundsStarted?: number }).roundsStarted === "number"
		? String((view as { roundsStarted?: number }).roundsStarted)
		: "?";
	return `[${view.phase}] ${view.objective} (rounds=${rounds}/${view.maxGoalRounds}, revision=${view.revision})`;
}

/**
 * Create or edit the session's evolution goal. With no current goal: create.
 * With a current goal: edit its objective (create-on-first-use semantics are
 * enforced by the goal service itself; completed goals may be replaced).
 */
export function upsertEvolutionGoal(ctx: Context, agent: Agent, objective?: string): GoalViewLike {
	const goals = goalServiceOf(ctx);
	if (!goals) {
		throw new Error("evolve: /evolve goal requires the goals service (load @deepseek-ai/dsh-goal)");
	}
	const current = goals.get(agent);
	const nextObjective = objective && objective.length > 0 ? objective : DEFAULT_EVOLVE_GOAL_OBJECTIVE;
	if (goalExists(current)) {
		if (current.phase === "active" || current.phase === "paused") {
			return goals.edit(agent, { id: current.id, revision: current.revision }, { objective: nextObjective });
		}
	}
	return goals.create(agent, { objective: nextObjective });
}

/** Complete the current goal, returning the completed view or undefined. */
export function completeEvolutionGoal(ctx: Context, agent: Agent): GoalViewLike | undefined {
	const goals = goalServiceOf(ctx);
	if (!goals) {
		throw new Error("evolve: /evolve goal requires the goals service (load @deepseek-ai/dsh-goal)");
	}
	const current = goals.get(agent);
	if (!goalExists(current) || current.phase === "complete") {
		return current;
	}
	return goals.complete(agent, { id: current.id, revision: current.revision });
}

/** Block the current goal with a reason (when the service supports it). */
export function blockEvolutionGoal(ctx: Context, agent: Agent, reason: string): GoalViewLike | undefined {
	const goals = goalServiceOf(ctx);
	if (!goals || typeof goals.block !== "function") {
		return undefined;
	}
	const current = goals.get(agent);
	if (!goalExists(current) || current.phase !== "active") {
		return current;
	}
	return goals.block(agent, { id: current.id, revision: current.revision }, { code: "evolve-blocked", reason });
}
