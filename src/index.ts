/**
 * dsh-continual-evolve — plugin entry (Phase 2: auto review gate).
 *
 * Mounts the evolution engine, registers the model-facing evolve_* tools,
 * the human-facing /evolve command, the system-prompt guidance section, and
 * (opt-in) the automatic review gate that runs the planner on a turn
 * interval. Store roots default under the resolved DSH home; a deployment
 * may override `baseDir` in the plugin config.
 */
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
import { expandHomePath, resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { createEvolutionEngine, type EvolutionEngine } from "./service.js";
import { registerEvolveTools } from "./tool.js";
import { registerEvolveCommand } from "./command.js";
import { registerAutoReview } from "./auto.js";
import { syncSkillsFromResult } from "./skill.js";
import { entriesSectionText } from "./inject.js";
import { resolveRubricKey } from "./rubric.js";
import { restoreMounted } from "./mount.js";

export const name = "continual-evolve";

/** Service key under which the evolution engine is published. */
export const EVOLUTION_SERVICE = "evolution";

export const inject = ["tools", "commands", "systemPrompt", "llm", "sessionQuery", "agents", "userQuestions", "subagents"];

export const Config = z.object({
	/** Root for evolution stores; defaults to the resolved DSH home. */
	baseDir: z.string(),
	/** System-prompt section order for the evolution guidance. */
	sectionOrder: z.natural().default(118),
	/** Enable the automatic review gate (off by default: it costs model calls). */
	autoReview: z.boolean().default(false),
	/** Gate runs when this many turns have passed since the last review. */
	reviewIntervalTurns: z.natural().default(6),
	/** Trajectory slice handed to the gate, in characters. */
	maxReviewInputChars: z.natural().default(40000),
	/** Output budget for the cheap gate call. */
	reviewBudgetTokens: z.natural().default(4096),
	/** Cross-session (global) edits require an explicit human approval. */
	requireGlobalApproval: z.boolean().default(true),
	/** Skills root for materialized skill entries; defaults to <dshHome>/skills. */
	skillsDir: z.string(),
	/** Passphrase for rubric encryption; falls back to DSH_EVOLVE_RUBRIC_KEY, then a dev key. */
	rubricKey: z.string(),
});

/** Structurally typed resolved config (loader passes the validated object). */
export interface EvolveConfig {
	baseDir?: string;
	sectionOrder?: number;
	autoReview?: boolean;
	reviewIntervalTurns?: number;
	maxReviewInputChars?: number;
	reviewBudgetTokens?: number;
	requireGlobalApproval?: boolean;
	skillsDir?: string;
	rubricKey?: string;
}

export interface EvolutionService {
	readonly engine: EvolutionEngine;
	readonly baseDir: string;
}

export function apply(ctx: Context, config: EvolveConfig): void {
	const baseDir = resolveDshHome(config.baseDir);
	const skillsRoot = config.skillsDir ? expandHomePath(config.skillsDir) : join(baseDir, "skills");
	const engine = createEvolutionEngine(baseDir, {
		onApplied: (result) => {
			try {
				syncSkillsFromResult(skillsRoot, result);
			} catch (cause) {
				ctx
					.logger("continual-evolve")
					.warn(`skill materialization failed for ${result.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
			}
		},
	});

	ctx.provide(EVOLUTION_SERVICE, { engine, baseDir });

	ctx.systemPrompt.section({
		name: "tool:continual-evolve",
		order: config.sectionOrder ?? 118,
		text: "You have a continual harness: versioned, persistent prompt notes, memories, skills, and subagent specs. Prompt notes and delegation specs are injected below; use evolve_list for the full state. Create an entry (evolve_add) after a repeated failure, a reusable tactic, a durable fact or preference, a repeated procedure, or a repeated delegation role. Keep edits small and evidence-backed; prefer local scope, use global: true only for stable cross-session lessons. Update or delete (evolve_update / evolve_delete) when an entry is wrong or obsolete; roll back faulty refinements with evolve_rollback. Every edit is snapshotted, versioned, and recorded — no edit can be silently lost.",
	});

	// Phase 2: make prompt entries real system-prompt content and subagent
	// entries real delegation specs. The text is a provider evaluated at every
	// assembly with the assembling agent; a store without prompt/subagent
	// entries renders to "" and the prompt renderer drops the section.
	ctx.systemPrompt.section({
		name: "tool:continual-evolve:entries",
		order: (config.sectionOrder ?? 118) + 1,
		text: (context) => entriesSectionText(engine, context.agent),
	});

	const gate = { requireGlobalApproval: config.requireGlobalApproval ?? true };
	registerEvolveTools(ctx, engine, gate);
	registerEvolveCommand(ctx, engine, gate, { rubricKey: resolveRubricKey(config.rubricKey, process.env, (m) => ctx.logger("continual-evolve").warn(m)) });

	// v2 optional: restore hot-mounted skill plugins after a restart.
	void restoreMounted(ctx, baseDir).catch((cause) => {
		ctx.logger("continual-evolve").warn(`mount restore failed: ${cause instanceof Error ? cause.message : String(cause)}`);
	});

	if (config.autoReview) {
		registerAutoReview(ctx, engine, {
			intervalTurns: config.reviewIntervalTurns ?? 6,
			maxInputChars: config.maxReviewInputChars ?? 40000,
			budgetTokens: config.reviewBudgetTokens ?? 4096,
		});
		ctx.logger("continual-evolve").info(
			`continual-evolve auto-review enabled (every ${config.reviewIntervalTurns ?? 6} turns)`,
		);
	}

	ctx.logger("continual-evolve").info(`continual-evolve mounted (baseDir=${baseDir})`);
}
