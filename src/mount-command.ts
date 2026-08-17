/**
 * The `/evolve mount` and `/evolve unmount` subcommand handlers.
 * Extracted from command.ts (P2-2).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import type { EvolutionEngine } from "./service.js";
import { loadLedger, mountSkill, unmountSkill } from "./mount.js";
import { stripAngleBrackets } from "./command.js";

function success(text: string): CommandResult {
	return { kind: "success", text };
}

function error(text: string): CommandResult {
	return { kind: "error", text };
}

export async function executeMountCommand(
	ctx: Context,
	engine: EvolutionEngine,
	invocation: CommandInvocation,
	rest: string[],
): Promise<CommandResult> {
	const sub = rest[0] ?? "";
	if (sub === "list") {
		const ledger = loadLedger(engine.baseDir);
		if (ledger.mounted.length === 0) {
			return success("(no hot-mounted plugins — /evolve mount <skillId>)");
		}
		return success(ledger.mounted.map((m) => `- ${m.id} (${m.entryId}, v${m.version}, ${m.mountedAt})`).join("\n"));
	}
	const skillId = stripAngleBrackets(sub);
	if (!skillId) {
		return error(`mount requires a skill entry id.\nUsage: /evolve mount <skillId> | /evolve mount list`);
	}
	const sessionId = invocation.agent.id;
	const local = engine.load("local", sessionId);
	const globalState = engine.load("global", undefined);
	const entry =
		local.entries.skill[skillId] ??
		globalState.entries.skill[skillId] ??
		Object.values(local.entries.skill).find((e) => e.id === skillId) ??
		Object.values(globalState.entries.skill).find((e) => e.id === skillId);
	if (!entry) {
		return error(`skill entry ${skillId} not found in local or global store`);
	}
	try {
		const record = await mountSkill(ctx, engine.baseDir, entry);
		return success(`mounted ${record.id} as ${record.entryId} (v${record.version}) — tool: skill_${record.id.replace(/_/g, "-")}`);
	} catch (cause) {
		return error(cause instanceof Error ? cause.message : String(cause));
	}
}

export async function executeUnmountCommand(
	ctx: Context,
	engine: EvolutionEngine,
	rest: string[],
): Promise<CommandResult> {
	const id = stripAngleBrackets(rest[0] ?? "");
	if (!id) {
		return error(`unmount requires a mount id (see /evolve mount list).`);
	}
	const record = await unmountSkill(ctx, engine.baseDir, id);
	return record ? success(`unmounted ${record.id} (${record.entryId})`) : error(`no mount found for ${id}`);
}
