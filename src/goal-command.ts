/**
 * The `/evolve goal` subcommand handler. Extracted from command.ts (P2-2).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import { blockEvolutionGoal, completeEvolutionGoal, goalServiceOf, goalStatusText, upsertEvolutionGoal } from "./goal.js";

function success(text: string): CommandResult {
	return { kind: "success", text };
}

function error(text: string): CommandResult {
	return { kind: "error", text };
}

export function executeGoalCommand(ctx: Context, invocation: CommandInvocation, rest: string[]): CommandResult {
	const agent = invocation.agent;
	const goals = goalServiceOf(ctx);
	if (!goals) {
		return error(`/evolve goal requires the goals service (load @deepseek-ai/dsh-goal)`);
	}
	const sub = rest[0] ?? "";
	try {
		if (sub === "done") {
			const view = completeEvolutionGoal(ctx, agent);
			return view ? success(`evolution goal completed: ${goalStatusText(view)}`) : success("(no goal to complete)");
		}
		if (sub === "block") {
			const reason = rest.slice(1).join(" ") || "user requested block";
			const view = blockEvolutionGoal(ctx, agent, reason);
			return view ? success(`evolution goal blocked: ${goalStatusText(view)}`) : success("(no active goal to block)");
		}
		if (sub.length === 0) {
			const current = goals.get(agent);
			return current ? success(goalStatusText(current)) : success("(no evolution goal — /evolve goal <objective> to create one)");
		}
		const objective = rest.join(" ");
		const view = upsertEvolutionGoal(ctx, agent, objective);
		return success(`evolution goal ready: ${goalStatusText(view)}\n(active goal drives the review gate every round)`);
	} catch (cause) {
		return error(cause instanceof Error ? cause.message : String(cause));
	}
}
