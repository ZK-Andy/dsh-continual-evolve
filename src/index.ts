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
import { registerFileLogger } from "./logfile.js";
import { resolvePromotionPolicy } from "./promotion.js";

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
	/** After an approved gate run with applied edits, queue a visible follow-up notice. */
	notifyOnAutoReview: z.boolean().default(true),
	/** Cross-session (global) edits require an explicit human approval. */
	requireGlobalApproval: z.boolean().default(true),
	/** Skills root for materialized skill entries; defaults to <dshHome>/skills. */
	skillsDir: z.string(),
	/** Passphrase for rubric encryption; falls back to DSH_EVOLVE_RUBRIC_KEY, then a local key file. */
	rubricKey: z.string(),
	/** Write all cordis log messages to <baseDir>/evolve/plugin.log (JSONL). */
	logToFile: z.boolean().default(true),
	/** File log level: 0=error, 1=info, 2=warn, 3=debug. */
	logLevel: z.natural().default(1),
	/** Rotate the file log when it exceeds this many bytes. */
	logMaxBytes: z.natural().default(5 * 1024 * 1024),
	/** After a benchmark decision rejects a candidate, roll the refinement back automatically. */
	autoRollbackOnReject: z.boolean().default(true),
	/**
	 * Gap C1: optional model override for the review gate (cheaper model).
	 * Format: "provider/model" or just "model" (same provider as the agent).
	 * When absent, the review gate uses the agent's own provider/model.
	 */
	reviewModel: z.string(),
	/**
	 * Gate local-fate dimension (#11 P2): the gate audits the session's local
	 * entries on its own cadence and proposes promote/archive — consulted
	 * first, never written silently. Only meaningful with autoReview on.
	 */
	localFate: z.boolean().default(true),
	/**
	 * Minimum turns between local-fate assessments on the turn-interval path
	 * (compaction is unconditional). Absent → follows reviewIntervalTurns.
	 */
	fateIntervalTurns: z.natural(),
	/**
	 * Goal-blocked trigger (D3): after this many CONSECUTIVE gate runs that
	 * observe the session goal in phase "blocked", run one local-fate
	 * assessment so the encounter is distilled. 0 disables.
	 */
	goalBlockedWrapupTurns: z.natural().min(0).default(3),
	/**
	 * Promotion policy (2026-08-22): regex sources whose match in a
	 * candidate's title/content marks it project-scoped — such entries are
	 * never promoted to the cross-session global store. Replaces the built-in
	 * defaults when set.
	 */
	promotionBlockPatterns: z.array(z.string()),
	/** Whole promotions below this content length stay local (chars). */
	promotionMinChars: z.natural().default(100),
	/** Entry-directory lines injected per build before folding into a counter. */
	injectionDirectoryLines: z.natural().default(15),
});

/**
 * Structurally typed resolved config (loader passes the validated object).
 * Derived from the schemastery schema — single source of truth, no manual sync.
 */
export type EvolveConfig = Partial<Schemastery.TypeT<typeof Config>>;

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
				const warnings = syncSkillsFromResult(skillsRoot, result);
				for (const warning of warnings) {
					ctx.logger("continual-evolve").warn(warning);
				}
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
		text: (context) => entriesSectionText(engine, context.agent, undefined, { directoryLines: config.injectionDirectoryLines ?? 15 }),
	});

	const gate = { requireGlobalApproval: config.requireGlobalApproval ?? true };
	const promotionPolicy = resolvePromotionPolicy({
		blockPatterns: config.promotionBlockPatterns,
		minPromoteChars: config.promotionMinChars,
	});
	registerEvolveTools(ctx, engine, gate);
	registerEvolveCommand(ctx, engine, gate, {
		rubricKey: resolveRubricKey(baseDir, config.rubricKey, process.env, (m) => ctx.logger("continual-evolve").warn(m)),
		autoRollbackOnReject: config.autoRollbackOnReject ?? true,
		promotionPolicy,
	});

	// Plugin-owned file logging: every cordis log message lands in
	// <baseDir>/evolve/plugin.log regardless of how dsh web was launched —
	// no extra component to install, no startup-script dependency.
	if (config.logToFile !== false) {
		registerFileLogger(ctx, baseDir, {
			logLevel: config.logLevel ?? 1,
			...(config.logMaxBytes !== undefined ? { logMaxBytes: config.logMaxBytes } : {}),
		});
	}

	// v2 optional: restore hot-mounted skill plugins after a restart.
	void restoreMounted(ctx, baseDir).catch((cause) => {
		ctx.logger("continual-evolve").warn(`mount restore failed: ${cause instanceof Error ? cause.message : String(cause)}`);
	});

	if (config.autoReview) {
		registerAutoReview(ctx, engine, {
			intervalTurns: config.reviewIntervalTurns ?? 6,
			maxInputChars: config.maxReviewInputChars ?? 40000,
			budgetTokens: config.reviewBudgetTokens ?? 4096,
			notifyOnAutoReview: config.notifyOnAutoReview ?? true,
			localFate: config.localFate ?? true,
			fateIntervalTurns: config.fateIntervalTurns ?? config.reviewIntervalTurns ?? 6,
			goalBlockedWrapupTurns: config.goalBlockedWrapupTurns ?? 3,
			promotionPolicy,
			...(config.reviewModel ? { reviewModel: config.reviewModel } : {}),
		});
		ctx.logger("continual-evolve").info(
			`continual-evolve auto-review enabled (every ${config.reviewIntervalTurns ?? 6} turns; local-fate ${config.localFate ?? true ? "on" : "off"} every ${config.fateIntervalTurns ?? config.reviewIntervalTurns ?? 6} turns)`,
		);
	}

	ctx.logger("continual-evolve").info(`continual-evolve mounted (baseDir=${baseDir})`);
}
