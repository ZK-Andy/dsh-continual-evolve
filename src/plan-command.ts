/**
 * `/evolve plan` — the manual LLM planner path: propose edits against one
 * store with the main-session model, ask for approval on persistent scopes,
 * and apply with the normal baseline checks.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CommandInvocation } from "@deepseek-ai/dsh-commands";
import { join } from "node:path";
import type { HarnessScope } from "./types.js";
import type { EvolutionEngine } from "./service.js";
import { planWithLlm } from "./planner.js";
import { requireGlobalApproval } from "./approval.js";
import { entrySourceOf } from "./source.js";
import { renderResult, storeIdForCommand, success, type CommandGateOptions, type CommandRuntimeOptions, type CommandTextResult } from "./command-util.js";

export async function executePlanCommand(
	ctx: Context,
	engine: EvolutionEngine,
	invocation: CommandInvocation,
	scope: HarnessScope,
	after: string[],
	opts: CommandGateOptions,
	runtime: CommandRuntimeOptions,
): Promise<CommandTextResult> {
	const instructions = after.length > 0 ? after.join(" ") : undefined;
	const sessionId = invocation.agent.id;
	const state = engine.load(scope, storeIdForCommand(scope, invocation));
	const history = engine.history(scope, storeIdForCommand(scope, invocation));
	const proposal = await planWithLlm(ctx, {
		agent: invocation.agent,
		state,
		history,
		...(instructions ? { instructions } : {}),
		global: scope === "global",
		signal: invocation.signal,
		tokenUsage: {
			baseDir: engine.baseDir,
			sessionId,
			retain: engine.retention.tokenUsage,
			onError: (cause: unknown) =>
				ctx.logger("continual-evolve").warn(`token-usage ledger failed for ${sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`),
		},
		// skill-creator template facts (fallback: builtin guide).
		skillsRoot: join(engine.baseDir, "skills"),
	});
	if ((scope === "global" || scope === "project") && opts.requireGlobalApproval && proposal.edits.length > 0) {
		await requireGlobalApproval(
			ctx,
			invocation.agent,
			invocation.signal,
			`/evolve plan ${scope} 将应用 ${proposal.edits.length} 条编辑到${scope === "project" ? "本项目" : "跨会话"} store：${proposal.summary}`,
			runtime.recordLanguage,
		);
	}
	const source = entrySourceOf(invocation.agent, sessionId);
	const result = engine.apply(scope, storeIdForCommand(scope, invocation), proposal, {
		scope,
		baselineState: state,
		...(source ? { source } : {}),
	});
	return success(renderResult(result));
}
