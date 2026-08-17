/**
 * Gate local-fate dimension (#11 P2): the automatic review gate also decides
 * what happens to a session's local entries while the session is STILL
 * running — not only at wrap-up.
 *
 * Local entries default to orphans: a later session (not on the parentSession
 * chain) never sees them, and nothing promotes or archives them — the
 * exploration results effectively "die" with the session. This module gives
 * the gate its own fate cadence on top of the existing review:
 *
 * - `promote` → the entry moves into the global store. The global store is a
 *   governed resource: the user is consulted FIRST (the consultSkillEdits
 *   pattern — never written silently), with a cooldown after a decline.
 * - `archive` → hidden from injection (data stays restorable). Archives that
 *   would bury possibly-reusable content (not covered globally AND distilled
 *   from real user messages) ask the user first; covered/operational entries
 *   archive silently, exactly like the wrap-up command does.
 * - `keep` → nothing.
 *
 * At compaction the gate NEVER opens a dialog (the agent is mid-compaction):
 * only deterministic silent archives apply, everything governed is deferred
 * with an audit record pointing at `/evolve wrapup`.
 *
 * Division of labor is the same as wrap-up: the mechanical audit proposes
 * (listLocalCandidates + coverage guards), the LLM classifies
 * (assessLocalEntries), the user approves, the code applies deterministically
 * (wholePromoteProposals / splitPromoteProposals — the SAME edits the wrap-up
 * command applies). Every decision lands in reviews.jsonl via the gate's
 * record callback.
 */
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { HarnessState, RefinementProposal, RefinementResult } from "./types.js";
import type { EvolutionEngine } from "./service.js";
import type { AutoRefineReason } from "./review.js";
import type { AutoReviewConfig, GateState, ReviewRecord } from "./auto.js";
import { questionServiceOf } from "./approval.js";
import {
	assessLocalEntries,
	candidateKey,
	filterPromotable,
	listLocalCandidates,
	splitArchiveGuards,
	splitPromoteBlocked,
	splitPromoteProposals,
	wholePromoteProposals,
	type WrapupAssessment,
	type WrapupCandidate,
	type WrapupItem,
} from "./wrapup.js";

/** Turns a declined local-fate proposal stays silent before being offered again. */
export const FATE_CONSULT_COOLDOWN_TURNS = 10;

/** What the gate decided to do with the session's local entries. */
export interface FatePlan {
	candidates: readonly WrapupCandidate[];
	/** Whole promotions that passed the deterministic global-coverage guard. */
	promotable: WrapupItem[];
	/** Split promotions (archive + cleaned promote payload) that passed the guard. */
	splits: { item: WrapupItem; candidate: WrapupCandidate }[];
	/** Archives that may proceed silently (covered globally / no real distillation source). */
	silentArchives: WrapupItem[];
	/** Archives that must ask the user first (uncovered + real source). */
	reviewArchives: WrapupItem[];
	/** Promotes blocked by the deterministic guard, with why. */
	skipped: { key: string; reason: string }[];
	/** Split promotions blocked by the deterministic guard, with why. */
	splitSkipped: { key: string; reason: string }[];
}

/**
 * Partition an assessed wrap-up classification into concrete fate actions,
 * re-running the deterministic guards against the LIVE global store (state
 * may have changed while the LLM call was in flight). Pure and unit-tested;
 * mirrors the partition step of the wrap-up command.
 */
export function planLocalFates(
	items: readonly WrapupItem[],
	candidates: readonly WrapupCandidate[],
	globalState: HarnessState,
): FatePlan {
	const byKey = new Map(candidates.map((candidate) => [candidateKey(candidate.kind, candidate.id), candidate]));
	const { promotable, skipped } = filterPromotable(items, globalState, candidates);
	const promoteItems = promotable.filter((item) => item.verdict === "promote");
	const archiveItems = items.filter((item) => item.verdict === "archive");
	const splits: { item: WrapupItem; candidate: WrapupCandidate }[] = [];
	const splitSkipped: { key: string; reason: string }[] = [];
	for (const item of archiveItems) {
		if (!item.promote) continue;
		const candidate = byKey.get(item.key);
		if (!candidate) {
			splitSkipped.push({ key: item.key, reason: "not in the audited candidate list" });
			continue;
		}
		const blocked = splitPromoteBlocked(item, globalState, candidate.kind);
		if (blocked) {
			splitSkipped.push({ key: item.key, reason: blocked });
			continue;
		}
		splits.push({ item, candidate });
	}
	const plainArchives = archiveItems.filter((item) => !item.promote);
	const { silent: silentArchives, review: reviewArchives } = splitArchiveGuards(plainArchives, candidates);
	return { candidates, promotable: promoteItems, splits, silentArchives, reviewArchives, skipped, splitSkipped };
}

/**
 * The cooldown key of a candidate set: the sorted `kind:id` list. The set is
 * the unit of consultation — a declined proposal is not offered again within
 * the cooldown window, and a changed set (new entries appeared) starts a
 * fresh consultation.
 */
export function fateSetKey(candidates: readonly WrapupCandidate[]): string {
	return candidates
		.map((candidate) => candidateKey(candidate.kind, candidate.id))
		.sort()
		.join("|");
}

/**
 * Whether the local-fate dimension is due for this gate run. Turn-interval
 * gates respect the fate cadence (an independent counter — goal-driven
 * sessions run the review EVERY round, the fate assessment must not);
 * compaction is unconditional: experiences about to be summarized away get
 * their fate check regardless. Goal-blocked assessments are unconditional
 * here too — the gate's own streak counter (auto.ts runGoalBlockedFate)
 * already gates their frequency, so the cadence must not re-block them.
 */
export function fateCadenceDue(state: GateState, reason: AutoRefineReason, intervalTurns: number): boolean {
	// Compact and goal-blocked assessments bypass the cadence (see header).
	if (reason === "compact" || reason === "goal_blocked") return true;
	return state.turns - state.lastFateAt >= intervalTurns;
}

export interface FateConsultResult {
	approved: boolean;
	asked: boolean;
	reason: "nothing-to-ask" | "consented" | "declined" | "cooldown" | "unavailable" | "error";
}

/**
 * Ask the user whether to execute the gate's local-fate proposal. ONE dialog
 * covers every governed action (promotes, split promotions, review-required
 * archives) — the gate never spams questions. Conservative on every edge:
 * no question service → not approved; the question call fails → not approved;
 * the same candidate set was declined within the cooldown → not asked again.
 * A decline records the cooldown (the consultSkillEdits pattern).
 */
export async function consultLocalFates(
	ctx: Context,
	agent: Agent,
	plan: FatePlan,
	gate: GateState,
): Promise<FateConsultResult> {
	const needsDialog = plan.promotable.length + plan.splits.length + plan.reviewArchives.length > 0;
	if (!needsDialog) {
		return { approved: true, asked: false, reason: "nothing-to-ask" };
	}
	const setKey = fateSetKey(plan.candidates);
	const lastReject = gate.fateRejects.get(setKey);
	if (lastReject !== undefined && gate.turns - lastReject < FATE_CONSULT_COOLDOWN_TURNS) {
		return { approved: false, asked: false, reason: "cooldown" };
	}
	const userQuestions = questionServiceOf(ctx);
	if (!userQuestions) {
		return { approved: false, asked: false, reason: "unavailable" };
	}
	try {
		const answer = await userQuestions.ask({
			questions: [
				{
					id: "evolve-fate-consult",
					question: consultQuestion(plan),
					options: [{ label: "执行" }, { label: "不执行" }],
				},
			],
			agent,
		});
		const approved = answer.answers?.find((entry) => entry.id === "evolve-fate-consult")?.selected?.includes("执行") ?? false;
		if (!approved) {
			gate.fateRejects.set(setKey, gate.turns);
		}
		return { approved, asked: true, reason: approved ? "consented" : "declined" };
	} catch {
		return { approved: false, asked: true, reason: "error" };
	}
}

/** The user-visible fate proposal: every governed action, with real titles. */
function consultQuestion(plan: FatePlan): string {
	const byKey = new Map(plan.candidates.map((candidate) => [candidateKey(candidate.kind, candidate.id), candidate]));
	const lines: string[] = [];
	if (plan.promotable.length > 0 || plan.splits.length > 0) {
		lines.push("【提升到跨会话全局 store】");
		for (const item of plan.promotable) {
			lines.push(`- ${item.key}「${byKey.get(item.key)?.title ?? item.key}」 — ${item.reason}`);
		}
		for (const { item } of plan.splits) {
			lines.push(`- ${item.key} → 拆出提升「${item.promote?.title}」（原条目随之归档）`);
		}
	}
	if (plan.reviewArchives.length > 0) {
		lines.push("【归档（未被全局覆盖且源自真实对话，需确认）】");
		for (const item of plan.reviewArchives) {
			lines.push(`- ${item.key}「${byKey.get(item.key)?.title ?? item.key}」 — ${item.reason}`);
		}
	}
	return [
		"自进化门禁检测到本会话的 local 条目需要归宿处理（提升条目将写入跨会话全局 store，归档条目隐藏但可恢复）：",
		...lines,
		"是否执行？",
	].join("\n");
}

export type FateApplyMode = "full" | "silent-only";

export interface FateApplyResult {
	/** Human-readable lines of what was applied (for the notice and the audit record). */
	applied: string[];
	/** Every refinement result produced, for rollback discovery. */
	results: RefinementResult[];
}

/**
 * Deterministically apply the fate plan. `"full"` applies everything
 * (promotes, splits, silent + review archives); `"silent-only"` applies only
 * the deterministic silent archives (the compaction path — nothing governed).
 * Promotes go through the SAME proposals as the wrap-up command
 * (wholePromoteProposals / splitPromoteProposals), so both paths write
 * identical global entries and local retirement stamps.
 */
export function applyLocalFates(
	engine: EvolutionEngine,
	sessionId: string,
	plan: FatePlan,
	localState: HarnessState,
	mode: FateApplyMode,
): FateApplyResult {
	const applied: string[] = [];
	const results: RefinementResult[] = [];
	const byKey = new Map(plan.candidates.map((candidate) => [candidateKey(candidate.kind, candidate.id), candidate]));
	if (mode === "full") {
		for (const item of plan.promotable) {
			const candidate = byKey.get(item.key);
			if (!candidate) continue;
			const proposals = wholePromoteProposals(item, candidate, sessionId);
			const globalResult = engine.apply("global", undefined, proposals.global, { scope: "global" });
			const createdId = globalResult.appliedEdits.find((edit) => edit.applied)?.id ?? candidate.id;
			const localResult = engine.apply("local", sessionId, proposals.localStamp(createdId), {
				scope: "local",
				baselineState: localState,
			});
			results.push(globalResult, localResult);
			applied.push(`提升 ${item.key} → 全局 store（global:${createdId}，本地副本已归档）`);
		}
		for (const { item, candidate } of plan.splits) {
			if (!item.promote) continue;
			const proposals = splitPromoteProposals(item, candidate, sessionId);
			const globalResult = engine.apply("global", undefined, proposals.global, { scope: "global" });
			const createdId = globalResult.appliedEdits.find((edit) => edit.applied)?.id ?? candidate.id;
			const localResult = engine.apply("local", sessionId, proposals.localStamp(createdId), {
				scope: "local",
				baselineState: localState,
			});
			results.push(globalResult, localResult);
			applied.push(`拆解 ${item.key} → 清洗「${item.promote.title}」入全局（原条目已归档）`);
		}
	}
	const archives = mode === "full" ? [...plan.silentArchives, ...plan.reviewArchives] : plan.silentArchives;
	for (const item of archives) {
		const candidate = byKey.get(item.key);
		if (!candidate) continue;
		const proposal: RefinementProposal = {
			summary: `gate fate: archive local ${item.key} — ${item.reason}`,
			rationale: item.reason,
			expectedOutcome: "The entry stops being injected but stays restorable.",
			edits: [{ action: "archive", kind: candidate.kind, id: candidate.id }],
		};
		const result = engine.apply("local", sessionId, proposal, { scope: "local", baselineState: localState });
		results.push(result);
		applied.push(`归档 ${item.key}「${candidate.title}」`);
	}
	return { applied, results };
}

/**
 * The gate's local-fate phase. Runs after the review phase on every gate
 * trigger (turn_interval / compact), subject to cadence and cooldown. All
 * failures are contained and recorded — a broken fate dimension never
 * disturbs the agent loop.
 */
export async function runLocalFatePhase(
	ctx: Context,
	engine: EvolutionEngine,
	agent: Agent,
	config: AutoReviewConfig,
	state: GateState,
	reason: AutoRefineReason,
	record: (entry: Omit<ReviewRecord, "timestamp">) => void,
): Promise<void> {
	if (!config.localFate) return;
	const logger = ctx.logger("continual-evolve");
	const sessionId = agent.id;
	const localState = engine.load("local", sessionId);
	const globalState = engine.load("global", undefined);
	const candidates = listLocalCandidates(localState, globalState, engine.baseDir);
	if (candidates.length === 0) return;
	if (!fateCadenceDue(state, reason, config.fateIntervalTurns)) return;
	const setKey = fateSetKey(candidates);
	const lastReject = state.fateRejects.get(setKey);
	if (lastReject !== undefined && state.turns - lastReject < FATE_CONSULT_COOLDOWN_TURNS) {
		logger.info(`auto-review local-fate skipped [${sessionId}]: candidate set declined ${state.turns - lastReject} turns ago (cooldown)`);
		return;
	}
	const turnsSinceFate = state.turns - state.lastFateAt;
	state.lastFateAt = state.turns;
	let assessment: WrapupAssessment;
	try {
		assessment = await assessLocalEntries(ctx, agent, candidates);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		logger.warn(`auto-review local-fate failed for ${sessionId}: ${message}`);
		record({
			sessionId,
			reason,
			turnsSinceLastReview: turnsSinceFate,
			outcome: "failed",
			rationale: `fate assessment error: ${message}`,
		});
		return;
	}
	const plan = planLocalFates(assessment.items, candidates, globalState);
	const needsDialog = plan.promotable.length + plan.splits.length + plan.reviewArchives.length > 0;

	let consent: FateConsultResult = { approved: false, asked: false, reason: "nothing-to-ask" };
	if (reason !== "compact" && needsDialog) {
		consent = await consultLocalFates(ctx, agent, plan, state);
	}

	if (consent.approved) {
		const { applied, results } = applyLocalFates(engine, sessionId, plan, localState, "full");
		logger.info(
			`auto-review local-fate approved (${reason}) [${sessionId}]: ${plan.promotable.length} promoted, ${plan.splits.length} split, ${plan.reviewArchives.length} review-archived, ${plan.silentArchives.length} silent-archived — ${assessment.rationale}`,
		);
		record({
			sessionId,
			reason,
			turnsSinceLastReview: turnsSinceFate,
			outcome: "approved",
			rationale: `fate: ${assessment.rationale} (${applied.join("; ")})`,
			refinementId: results.map((result) => result.id).join(","),
		});
		if (config.notifyOnAutoReview && reason === "turn_interval" && applied.length > 0) {
			notifyFateApplied(ctx, agent, applied);
		}
		return;
	}

	if (consent.reason === "declined" || consent.reason === "unavailable" || consent.reason === "error") {
		const withheld = consent.reason as "declined" | "unavailable" | "error";
		const outcome = withheld === "declined" ? "declined" : "deferred";
		logger.info(
			`auto-review local-fate ${outcome} (${reason}) [${sessionId}]: ${plan.promotable.length} promotes, ${plan.splits.length} splits, ${plan.reviewArchives.length} review-archives withheld — ${assessment.rationale}`,
		);
		record({
			sessionId,
			reason,
			turnsSinceLastReview: turnsSinceFate,
			outcome,
			rationale: `fate ${withheld}: ${assessment.rationale} (${plan.promotable.length} promotes, ${plan.splits.length} splits, ${plan.reviewArchives.length} review-archives withheld)`,
		});
		return;
	}

	if (reason === "compact" && needsDialog) {
		// Compaction: no dialog. Only deterministic silent archives apply;
		// governed actions are deferred with an audit record.
		const { applied, results } = applyLocalFates(engine, sessionId, plan, localState, "silent-only");
		if (applied.length > 0) {
			logger.info(`auto-review local-fate (compact) [${sessionId}]: silent-archived ${applied.length} — ${assessment.rationale}`);
			record({
				sessionId,
				reason,
				turnsSinceLastReview: turnsSinceFate,
				outcome: "approved",
				rationale: `fate (compact): ${assessment.rationale} (${applied.join("; ")})`,
				refinementId: results.map((result) => result.id).join(","),
			});
		}
		record({
			sessionId,
			reason,
			turnsSinceLastReview: turnsSinceFate,
			outcome: "deferred",
			rationale: `fate (compact): ${plan.promotable.length} promotes, ${plan.splits.length} splits, ${plan.reviewArchives.length} review-archives deferred — run /evolve wrapup for a full session exit`,
		});
		return;
	}

	// Silent archives on a plain turn-interval gate with nothing to ask.
	if (plan.silentArchives.length > 0) {
		const { applied, results } = applyLocalFates(engine, sessionId, plan, localState, "silent-only");
		logger.info(`auto-review local-fate (${reason}) [${sessionId}]: silent-archived ${applied.length} covered/operational entries — ${assessment.rationale}`);
		record({
			sessionId,
			reason,
			turnsSinceLastReview: turnsSinceFate,
			outcome: "approved",
			rationale: `fate: ${assessment.rationale} (${applied.join("; ")})`,
			refinementId: results.map((result) => result.id).join(","),
		});
		if (config.notifyOnAutoReview && reason === "turn_interval") {
			notifyFateApplied(ctx, agent, applied);
		}
		return;
	}

	// Assessed, nothing to do.
	logger.info(`auto-review local-fate assessed (${reason}) [${sessionId}]: ${candidates.length} candidates, no action — ${assessment.rationale}`);
	record({
		sessionId,
		reason,
		turnsSinceLastReview: turnsSinceFate,
		outcome: "assessed",
		rationale: `fate: ${assessment.rationale} (${candidates.length} candidates, no action)`,
	});
}

/** The user-visible notice after the gate applied local-fate actions. */
export function buildFateNotice(applied: readonly string[]): string {
	return [
		"🔎 自动进化门禁：本会话 local 条目归宿处理完成：",
		applied.map((line) => `- ${line}`).join("\n"),
		"查看全部条目：/evolve list；撤销：/evolve rollback <refinement id>",
		"请用一句话简短确认即可，不要调用任何工具。",
	].join("\n");
}

/** Queue the follow-up notice turn (turn_interval only, like the review notice). */
function notifyFateApplied(ctx: Context, agent: Agent, applied: string[]): void {
	try {
		agent.followup(
			createUserMessage({
				content: [{ type: "text", text: buildFateNotice(applied) }],
				source: { kind: "plugin", plugin: "dsh-continual-evolve" },
			}),
		);
	} catch (cause) {
		ctx
			.logger("continual-evolve")
			.warn(`local-fate notice failed for ${agent.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
}
