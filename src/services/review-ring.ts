/**
 * The review ring, assembled as a responsibility chain: cheap gate → evolve
 * pass → landing. Each link owns exactly one step and hands the item on until
 * a link terminates the walk; the batch runner (the environment class) is the
 * only place that knows the order.
 *
 * Every terminal path lands exactly one `item-review` row, and every row now
 * carries the model it ran on — a failure with no route on it cannot be
 * attributed, which is what left the gate's failure rate unreadable.
 */
import { type ChainLink, type ChainOutcome } from "./chain.js";
import { failureCodeOf, observedUsageOf } from "./llm-call.js";
import type { ModelSelection } from "./model-route.js";
import { evolvePrompt, gatePrompt, type EvolveVerdict } from "./review-prompt.js";
import { REVIEW_EVOLVE_BY_KIND, REVIEW_GATE_BY_KIND } from "./subagent-defs.js";
import { cutFailureOf, subagentLoaderFor, type SubagentCall, type SubagentLoader } from "./subagent.js";
import { normalizeUsage, zeroUsage, type UsageTotals } from "./token-usage.js";
import type { MemoryStore } from "../store.js";
import type { ReviewCandidate, ReviewDeps, ReviewRunOptions, ReviewRunSummary } from "./review.js";
import { evolveCountOf, proposedOf, rowBaseOf } from "./review-row.js";
import { landTieringExit } from "./review-tiering.js";

/** A rewrite lands only when the body-length ratio stays within this bound. */
export const REWRITE_MAGNITUDE_CAP = 0.3;

/** One item's walk through the ring: the context every link reads and fills in. */
export interface ReviewItem {
	readonly deps: ReviewDeps;
	/** The loader bound to this run's route and session — the only LLM entry point. */
	readonly loader: SubagentLoader;
	/** The route this run reviews on, for every row's `model` column. */
	readonly route: ModelSelection;
	readonly runId: string;
	readonly candidate: ReviewCandidate;
	readonly opts: ReviewRunOptions;
	readonly summary: ReviewRunSummary;
	readonly skipReasons: string[];
	/** Gate facts: the normalized totals later rows carry, and the raw payload rows keep. */
	gate: { usage: UsageTotals; raw: unknown };
	/** The evolve verdict, filled by the evolve link. */
	evolved?: EvolveVerdict;
	/** The evolve call's raw usage payload; `undefined` when it never reported one. */
	evolveUsage?: unknown;
	/**
	 * The host's failure code when an LLM leg died (`AUTH`, `RATE_LIMIT`, …).
	 * The batch reads it to tell a route that is refused from one that blipped:
	 * a refused route stops the whole drain instead of paying for the refusal
	 * once per candidate.
	 */
	faultCode?: string | undefined;
}

/**
 * Assemble the review chain: the environment class owns the order, the links
 * own their step, and the item carries the run's loader and route.
 *
 * @returns The chain, in order, ending in the landing link.
 */
export function reviewChain(): readonly ChainLink<ReviewItem>[] {
	return [gateLink(), evolveLink(), landLink()];
}

/** The per-run ring: the loader bound to this run, and the chain it walks. */
export interface ReviewRing {
	loader: SubagentLoader;
	links: readonly ChainLink<ReviewItem>[];
}

/** Assemble one run's ring (simple factory: one context, one bound loader, one chain). */
export function assembleRing(call: SubagentCall): ReviewRing {
	const loader = subagentLoaderFor(call);
	return { loader, links: reviewChain() };
}

/** Cheap gate: decide whether the item deserves the expensive pass at all. */
function gateLink(): ChainLink<ReviewItem> {
	return {
		name: "review-gate",
		async handle(item: ReviewItem): Promise<ChainOutcome> {
			const { deps, candidate } = item;
			const base = rowBaseOf(item);
			try {
				const answer = await item.loader.run(REVIEW_GATE_BY_KIND[candidate.kind], gatePrompt(candidate));
				const verdict = answer.answer;
				if (verdict === null) {
					// A cut gate is a failure only when no complete verdict came
					// through: the JSON usually lands before the budget runs out, so
					// parse first and blame the finish reason only if it did not.
					if (answer.finish !== undefined && answer.finish !== "stop") {
						throw cutFailureOf(answer, item.route);
					}
					deps.store.logReview({ ...base, verdict: "skip", reason: "gate-parse-failed", cheapUsage: answer.usage, applied: 0 });
					item.skipReasons.push("gate-parse-failed");
					return "handled";
				}
				if (!verdict.worthReview) {
					item.summary.cheapToken += totalOf(answer.usage);
					deps.store.logReview({ ...base, verdict: "skip", reason: verdict.reason, cheapUsage: answer.usage, applied: 0 });
					item.skipReasons.push("cheap-gate");
					return "handled";
				}
				item.summary.cheapToken += totalOf(answer.usage);
				item.gate = { usage: normalizedOf(answer.usage), raw: answer.usage };
				// Approved counts the gate's decision, not the outcome: the
				// evolve leg may still fail and ledger its own skip row.
				item.summary.approved += 1;
				return "next";
			} catch (error) {
				// The error text rides the row: a bare `gate-llm-failed` hid a ~50%
				// per-item failure rate in production (2026-10-12) with no way to
				// tell transient route faults from systematic ones — and the usage
				// the call already reported rides it too, or a failed call burns
				// tokens that no account shows.
				deps.store.logReview({
					...base, verdict: "skip", reason: `gate-llm-failed: ${failureHead(error)}`,
					cheapUsage: observedUsageOf(error), applied: 0,
				});
				item.skipReasons.push("gate-llm-failed");
				item.faultCode = failureCodeOf(error);
				return "handled";
			}
		},
	};
}

/** The evolve pass: judge the item and produce a verdict, or ledger why not. */
function evolveLink(): ChainLink<ReviewItem> {
	return {
		name: "review-evolve",
		async handle(item: ReviewItem): Promise<ChainOutcome> {
			const { deps, candidate } = item;
			const base = rowBaseOf(item);
			try {
				const definition = REVIEW_EVOLVE_BY_KIND[candidate.kind];
				const neighbors = neighborHooks(deps.store, candidate);
				const answer = await item.loader.run(definition, evolvePrompt(
					{ id: candidate.id, title: candidate.title, description: candidate.description, body: candidate.body, scope: candidate.scope },
					neighbors,
				));
				item.evolveUsage = answer.usage;
				item.summary.evolveToken += totalOf(answer.usage);
				// The evolve pass carries full replacement text: a cut stream may hold
				// half a body, so it never becomes a verdict.
				if (answer.finish !== undefined && answer.finish !== "stop") {
					throw cutFailureOf(answer, item.route);
				}
				if (answer.answer === null) {
					deps.store.logReview({
						...base, verdict: "skip", reason: "evolve-parse-failed",
						cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage, applied: 0,
					});
					item.skipReasons.push("evolve-parse-failed");
					return "handled";
				}
				item.evolved = answer.answer;
				return "next";
			} catch (error) {
				deps.store.logReview({
					...base, verdict: "skip", reason: `evolve-llm-failed: ${failureHead(error)}`,
					cheapUsage: item.gate.usage, evolveUsage: observedUsageOf(error) ?? item.evolveUsage, applied: 0,
				});
				item.skipReasons.push("evolve-llm-failed");
				item.faultCode = failureCodeOf(error);
				return "handled";
			}
		},
	};
}

/** Landing: turn one verdict into a row, and (outside dry-run) into a change. */
function landLink(): ChainLink<ReviewItem> {
	return {
		name: "review-land",
		handle(item: ReviewItem): ChainOutcome {
			const evolved = item.evolved;
			if (evolved === undefined) {
				// A landing link reached without a verdict is a wiring bug: fail
				// loud instead of writing a row with nothing behind it.
				throw new Error(`review landing reached without a verdict for ${item.candidate.kind} ${item.candidate.id}`);
			}
			if (evolved.verdict === "keep") {
				// A keep still resolves probation and promotion candidacy before
				// falling through to the plain keep row.
				if (landTieringExit(item, evolved, "keep")) {
					return "handled";
				}
				item.deps.store.logReview({
					...rowBaseOf(item), verdict: "keep", reason: evolved.reason,
					cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage, applied: 0,
				});
				return "handled";
			}
			if (evolved.verdict === "quarantine") {
				landQuarantine(item, evolved, evolved.reason);
				return "handled";
			}
			if (evolved.verdict === "archive" || evolved.verdict === "promote" || evolved.verdict === "demote" ||
				evolved.verdict === "export-suggestion") {
				landTieringExit(item, evolved, evolved.verdict);
				return "handled";
			}
			// Rewrite: magnitude cap first, dry-run second, gates last.
			const nextBody = evolved.body ?? item.candidate.body;
			if (rewriteMagnitude(item.candidate.body, nextBody) > REWRITE_MAGNITUDE_CAP) {
				landQuarantine(item, evolved, `幅度超限转隔离：${evolved.reason}`);
				return "handled";
			}
			if (item.opts.dryRun) {
				item.deps.store.logReview({
					...rowBaseOf(item), verdict: "rewrite", reason: `试运行未落盘：${evolved.reason}`,
					proposed: proposedOf(evolved), cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage, applied: 0,
				});
				return "handled";
			}
			landRewrite(item, evolved);
			return "handled";
		},
	};
}

/** Quarantine (or, in trial mode, the row it would have written). */
function landQuarantine(item: ReviewItem, evolved: EvolveVerdict, reason: string): void {
	const { deps, candidate, opts, summary } = item;
	const prior = evolveCountOf(deps.store, candidate);
	if (opts.dryRun) {
		deps.store.logReview({
			...rowBaseOf(item), verdict: "quarantine", reason: `试运行未隔离：${reason}`, proposed: proposedOf(evolved),
			cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage, applied: 0, evolveCount: prior,
		});
		return;
	}
	const ok = deps.store.quarantine(candidate.workspaceId, candidate.kind, candidate.id);
	deps.store.logReview({
		...rowBaseOf(item), verdict: "quarantine", reason,
		cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage,
		applied: ok ? 1 : 0, evolveCount: ok ? prior + 1 : prior,
	});
	if (ok) {
		summary.applied += 1;
	}
}

/** Apply one rewrite through the store's write gates. */
function landRewrite(item: ReviewItem, evolved: EvolveVerdict): void {
	const { deps, candidate, opts, summary } = item;
	const prior = evolveCountOf(deps.store, candidate);
	const ctx = {
		workspaceId: candidate.workspaceId, trigger: "item-review" as const,
		sessionId: opts.sessionId, runId: item.runId, model: opts.model, decision: evolved.reason,
	};
	const outcome = candidate.kind === "memory"
		? deps.store.applyProposals(ctx, [{
			action: "update", id: candidate.id,
			title: evolved.title, description: evolved.description, body: evolved.body, corrects: evolved.corrects,
		}])[0]
		: deps.store.applySkillProposals(ctx, [{
			action: "update", scope: candidate.scope ?? "project", id: candidate.id,
			title: evolved.title, description: evolved.description, body: evolved.body,
		}]).outcomes[0];
	const ok = outcome !== undefined && outcome.ok;
	deps.store.logReview({
		...rowBaseOf(item), verdict: "rewrite", reason: ok ? evolved.reason : `门禁拒绝：${outcome?.reason ?? "未知原因"}`,
		cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage, applied: ok ? 1 : 0, evolveCount: ok ? prior + 1 : prior,
	});
	if (ok) {
		summary.applied += 1;
	}
}

/** Similar existing items (hooks only) for the model's duplication check. */
function neighborHooks(store: MemoryStore, candidate: ReviewCandidate): { id: string; title: string; description: string }[] {
	try {
		if (candidate.kind === "memory") {
			const query = candidate.title.slice(0, 60);
			const hits = query.length >= 3 ? store.search(candidate.workspaceId, query, 5) : store.list(candidate.workspaceId).slice(0, 5);
			return hits.filter((hit) => hit.id !== candidate.id).slice(0, 4).map((hit) => ({ id: hit.id, title: hit.title, description: hit.description }));
		}
		const hits = store.searchSkills(candidate.workspaceId, candidate.title.slice(0, 60), 5);
		return hits.filter((hit) => hit.id !== candidate.id).slice(0, 4).map((hit) => ({ id: hit.id, title: hit.title, description: hit.description }));
	} catch {
		return [];
	}
}

function totalOf(raw: unknown): number {
	return normalizeUsage(raw)?.total ?? 0;
}

/** One-line error head for ledger rows (fail-loud shape, capped length). */
export function failureHead(error: unknown, max = 120): string {
	const message = error instanceof Error ? error.message : String(error);
	const head = message.split("\n", 1)[0] ?? "";
	return head.length > max ? `${head.slice(0, max)}…` : head;
}

/** Relative body change: |new-old| / max(old, 1). Above the cap → quarantine. */
export function rewriteMagnitude(oldBody: string, newBody: string): number {
	return Math.abs(newBody.length - oldBody.length) / Math.max(oldBody.length, 1);
}

function normalizedOf(raw: unknown): UsageTotals {
	return normalizeUsage(raw) ?? zeroUsage();
}
