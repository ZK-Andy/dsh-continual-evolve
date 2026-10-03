/**
 * The human-facing `/evolve` command router: parse the subcommand and hand
 * off to its implementation file. Subcommand logic lives in the
 * `*-command.ts` modules; this file owns only registration, help text, and
 * the core inspect/rollback flows.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import type { EvolutionEngine } from "./service.js";
import { formatHarnessStateForPrompt, historyForPrompt } from "./render.js";
import {
	findEntryById,
	renderResult,
	scopeArg,
	stripAngleBrackets,
	storeIdForCommand,
	success,
	error,
	tokenizeEvolveInput,
	type CommandGateOptions,
	type CommandRuntimeOptions,
} from "./command-util.js";
import { executePlanCommand } from "./plan-command.js";
import {
	executeArchiveCommand,
	executeConsolidateCommand,
	executeExportCommand,
	executeFailuresCommand,
	executeImportCommand,
	executeLogCommand,
} from "./maintenance-commands.js";
import { executePauseResumeCommand, executeStatusCommand, executeUsageCommand } from "./runtime-commands.js";
import { executeGoalCommand } from "./goal-command.js";
import { executeMountCommand, executeUnmountCommand } from "./mount-command.js";
import { executeBenchmarkCommand } from "./benchmark-command.js";
import { executeWrapupCommand } from "./wrapup-command.js";
import { projectKeyOf } from "./project.js";

const USAGE_COMMON = `Usage:
  /evolve                  show this help and the current local store
  /evolve list [project|global]    list entries (default local staging; "project" = this project's cross-session store, "global" = cross-project store)
  /evolve history [global] show applied refinements (rollback ids)
  /evolve rollback <id> [global]  deterministically revert a refinement
  /evolve plan [msg]       run the LLM planner against the current store
  /evolve wrapup           assess this session's local entries: promote reusable ones
                           to the global store (approval required), archive one-offs
  /evolve archive <id> [global]   hide an entry from injection (data kept, restorable)
  /evolve unarchive <id> [global] restore an archived entry
  /evolve pause | resume   pause/resume the automatic Memory Agent (manual tools and commands keep working)
  /evolve status           automatic Memory Agent state plus store entry counts
  /evolve help all         every subcommand, including the advanced ones below`;

const USAGE_ADVANCED = `Advanced:
  /evolve consolidate [apply] [merge]
                                   report (or apply) a batch archive of conflict-hinted
                                   and stale zero-use global entries; "merge" folds
                                   near-duplicate content into the surviving original
  /evolve failures               aggregated failure counts (gate + benchmark, by class)
  /evolve log [tail N]            show the recent plugin log (default 50 lines)
  /evolve export [global] <path>  backup a store to a JSON file
  /evolve import [global] <path>  restore a store from an export file
  /evolve mount <skillId>    hot-mount a skill entry as a live cordis plugin
  /evolve mount list         list hot-mounted plugins
  /evolve unmount <id>       remove a hot-mounted plugin
  /evolve goal               show the evolution goal (round-driven auto-review)
  /evolve goal <objective>   create/update the evolution goal
  /evolve goal done          complete the evolution goal
  /evolve benchmark ...      case lifecycle, runs, acceptance
  /evolve usage              injection counts + exact direct-call token usage (benchmark subagents excluded)`;

/** Default help (`/evolve`, `/evolve help`): the commands worth knowing. */
const USAGE = USAGE_COMMON;

export { findEntryById, stripAngleBrackets, tokenizeEvolveInput };
export type { CommandGateOptions, CommandRuntimeOptions };

export function registerEvolveCommand(ctx: Context, engine: EvolutionEngine, opts: CommandGateOptions, runtime: CommandRuntimeOptions): void {
	ctx.commands.register({
		name: "evolve",
		description: "自进化：检查并演进 harness 状态（记忆/技能/提示词/子代理） | Inspect and evolve the continual harness state (memories, skills, prompt notes, subagent specs)",
		input: { hint: "[list [global] | history [global] | rollback <id> [global] | plan [msg] | help all]" },
		handler: (invocation) => executeEvolveCommand(ctx, engine, invocation, opts, runtime),
	});
}

async function executeEvolveCommand(
	ctx: Context,
	engine: EvolutionEngine,
	invocation: CommandInvocation,
	opts: CommandGateOptions,
	runtime: CommandRuntimeOptions,
): Promise<CommandResult> {
	const tokens = tokenizeEvolveInput(invocation.rawInput);
	const sub = tokens[0] ?? "";
	const rest = tokens.slice(1);
	const sessionId = invocation.agent.id;

	try {
		switch (sub) {
			case "":
			case "help":
				// Layered help (2026-10-01): the default listing stays short;
				// `help all` expands the advanced half.
				return success(
					`${rest[0] === "all" ? `${USAGE_COMMON}\n\n${USAGE_ADVANCED}` : USAGE_COMMON}\n\n${formatHarnessStateForPrompt(engine.load("local", sessionId))}`,
				);
			case "list": {
				const { scope } = scopeArg(rest);
				return success(formatHarnessStateForPrompt(engine.load(scope, storeIdForCommand(scope, invocation))));
			}
			case "history": {
				const { scope } = scopeArg(rest);
				const history = engine.history(scope, storeIdForCommand(scope, invocation));
				return success(historyForPrompt(history) || "(no refinements yet)");
			}
			case "rollback": {
				const { scope, rest: after } = scopeArg(rest);
				const id = stripAngleBrackets(after[0] ?? "");
				if (!id) {
					return error(`rollback requires a refinement id.\n${USAGE}`);
				}
				const result = engine.rollback(scope, storeIdForCommand(scope, invocation), id);
				return success(renderResult(result));
			}
			case "archive":
			case "unarchive": {
				return await executeArchiveCommand(ctx, engine, invocation, sub, scopeArg(rest), USAGE);
			}
			case "consolidate":
				return executeConsolidateCommand(engine, rest);
			case "failures":
				return executeFailuresCommand(engine);
			case "log":
				return executeLogCommand(engine, rest, USAGE);
			case "export": {
				const parsed = scopeArg(rest);
				return executeExportCommand(engine, invocation, parsed, USAGE);
			}
			case "import": {
				const parsed = scopeArg(rest);
				return executeImportCommand(engine, invocation, parsed, parsed.rest[0]);
			}
			case "plan": {
				const { scope, rest: after } = scopeArg(rest);
				return await executePlanCommand(ctx, engine, invocation, scope, after, opts, runtime);
			}
			case "wrapup": {
				return await executeWrapupCommand(ctx, engine, invocation, runtime.promotionPolicy, runtime.recordLanguage);
			}
			case "pause":
			case "resume":
				return executePauseResumeCommand(engine, sub, runtime);
			case "status":
				return executeStatusCommand(engine, sessionId, projectKeyOf(invocation.agent), runtime);
			case "usage":
				return executeUsageCommand(engine, sessionId, projectKeyOf(invocation.agent));
			case "goal": {
				return executeGoalCommand(ctx, invocation, rest);
			}
			case "mount": {
				return await executeMountCommand(ctx, engine, invocation, rest);
			}
			case "unmount": {
				return await executeUnmountCommand(ctx, engine, rest);
			}
			case "benchmark": {
				return await executeBenchmarkCommand(ctx, engine, invocation, rest, runtime);
			}
			default:
				return error(`unknown subcommand: ${sub}\n${USAGE}`);
		}
	} catch (cause) {
		return error(cause instanceof Error ? cause.message : String(cause));
	}
}
