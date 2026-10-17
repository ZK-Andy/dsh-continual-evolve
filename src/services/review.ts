/**
 * The autonomous content-quality loop (the model's verdicts, code's
 * consequences): cheap gate first, evolve pass only on approval, every
 * terminal path ledgered as one `item-review` row, one day-rollup merge per
 * run. No human in the loop — delete never lands automatically (verdicts
 * only know keep/rewrite/quarantine) and oversized rewrites degrade to
 * quarantine instead of landing.
 *
 * This module owns the batch: the hard daily cap, the rollup, and the
 * scheduler; the queue it drains is `review-candidates.ts`, and the per-item
 * walk itself is a responsibility chain (`review-ring.ts`) the batch assembles
 * once per run — gate → evolve → landing — so the order is visible in one
 * place and each step is one link.
 *
 * This track is independent from the extraction pipeline by construction:
 * own prompts (`review-prompt.ts`), own budget (`review_daily`), own ledger
 * (`review_log`), no cursor, no increment. It only shares the store's write
 * gates (`applyProposals` / `applySkillProposals` / `quarantine`).
 */
import { runChain } from "./chain.js";
import { isRouteRejectedCode, type LlmRuntime } from "./llm-call.js";
import type { ModelSelection, RouteResolver } from "./model-route.js";
import { ROUTE_REJECTED_REASON } from "../store-types.js";
import { assembleRing, failureHead, type ReviewItem, type ReviewRing } from "./review-ring.js";
import type { MemoryStore } from "../store.js";
import { zeroUsage } from "./token-usage.js";

/** The LLM face review calls, aliased so each scheduler can name its own. */
export type ReviewLlm = LlmRuntime;

export interface ReviewDeps {
	store: MemoryStore;
	llm: LlmRuntime | undefined;
	/**
	 * Route resolution for a direct call: the session's current selection, its
	 * last request header, the agent's creation-time options, the host default.
	 * Absent keeps the legacy agent-options-only behavior (tests, older hosts).
	 */
	resolveRoute?: RouteResolver | undefined;
}

/**
 * Which tier put a candidate in front of the reviewer — the account's own
 * vocabulary for `review_daily`'s per-source counters.
 */
export type CandidateSource = "new" | "event" | "clock" | "sample";

export interface ReviewCandidate {
	workspaceId: string;
	kind: "memory" | "skill";
	id: string;
	/** 0 = new, 1 = event/clock requeue, 2 = stale sample. */
	priority: number;
	/** The tier that queued it (the rollup's per-source account). */
	source: CandidateSource;
	title: string;
	description: string;
	body: string;
	/** Memory type, present only for memory candidates. */
	memoryType?: string | undefined;
	/** Skill scope, present only for skill candidates. */
	scope?: "project" | "global" | undefined;
}

export interface ReviewRunOptions {
	/** UTC day `YYYY-MM-DD` the hard cap accounts against — also the clock the prompts judge dates by. */
	day: string;
	/** Hard cap for the day (100). Candidates past it count as dropped. */
	budget: number;
	/** Trial mode: verdicts ledgered, nothing applied or quarantined. */
	dryRun: boolean;
	/** Max items per run (batching keeps one prompt small). */
	batchSize?: number | undefined;
	/** Days of untouched age before an item requeues (default 30). */
	staleDays?: number | undefined;
	provider?: string | undefined;
	model?: string | undefined;
	sessionId?: string | undefined;
	runId?: string | undefined;
}

export interface ReviewRunSummary {
	reviewed: number;
	approved: number;
	applied: number;
	dropped: number;
	backlog: number;
	cheapToken: number;
	evolveToken: number;
	/**
	 * True when the batch stopped because the provider refused the route: the
	 * scheduler halts that route, so the next boundary does not pay for the
	 * same refusal once per candidate.
	 */
	routeRejected: boolean;
}

/** Defaults for the review settings the host may override — and edit live. */
export const REVIEW_DEFAULT_DRY_RUN = true;
export const REVIEW_DEFAULT_DAILY_BUDGET = 100;
export const REVIEW_DEFAULT_BATCH_SIZE = 10;
export const REVIEW_DEFAULT_STALE_DAYS = 30;

/**
 * Run one review batch: assemble the per-item chain once, then walk each
 * candidate through it — cheap gate, evolve pass on approval, safeguards
 * before landing, one `item-review` row per terminal path, one daily merge at
 * the end. LLM and parse failures degrade to skip rows inside the chain (the
 * run keeps going), exactly like extraction's fail-ledgered discipline.
 */
/** Everything one batch run carries across its candidates. */
interface BatchRun {
	deps: ReviewDeps;
	opts: ReviewRunOptions;
	batch: ReviewCandidate[];
	runId: string;
	route: ModelSelection | undefined;
	ring: ReviewRing | undefined;
	summary: ReviewRunSummary;
	skipReasons: string[];
	/** The rollup's per-source requeue account (the total is their sum). */
	counts: Record<CandidateSource, number>;
	position: number;
}

export async function runReviewBatch(deps: ReviewDeps, candidates: readonly ReviewCandidate[], opts: ReviewRunOptions): Promise<ReviewRunSummary> {
	const batch = candidates.slice(0, Math.max(1, opts.batchSize ?? 10));
	const runId = opts.runId ?? `review:${opts.day}:${Date.now()}`;
	const route: ModelSelection | undefined = opts.provider === undefined || opts.model === undefined
		? undefined
		: { provider: opts.provider, model: opts.model };
	const llm = deps.llm;
	// The environment class: one loader and one chain for the whole run, in the
	// order the ring declares. Without a route there is no ring to walk.
	const ring = route === undefined || llm === undefined ? undefined : assembleRing({ llm, route, sessionId: opts.sessionId, today: opts.day });
	const run: BatchRun = {
		deps, opts, batch, runId, route, ring,
		summary: { reviewed: 0, approved: 0, applied: 0, dropped: 0, backlog: 0, cheapToken: 0, evolveToken: 0, routeRejected: false },
		skipReasons: [], counts: { new: 0, event: 0, clock: 0, sample: 0 }, position: 0,
	};
	// The run's account is written whatever happens to the loop: a fault that
	// escapes one item (or the loop itself) is rethrown *after* the rollup is
	// merged, so a dead run can never leave `reviewed` incremented with every
	// other counter at zero and nothing saying why (2026-10-14 incident).
	let escaped: unknown;
	let failed = false;
	try {
		for (const candidate of batch) {
			if (await reviewOneCandidate(run, candidate)) {
				break;
			}
		}
	} catch (error) {
		failed = true;
		escaped = error;
	} finally {
		run.summary.backlog = Math.max(0, candidates.length - run.summary.reviewed - run.summary.dropped);
		deps.store.mergeDaily(opts.day, opts.budget, {
			newItems: run.counts.new,
			requeuedLink: run.counts.event,
			requeuedClock: run.counts.clock,
			requeuedSampled: run.counts.sample,
			approved: run.summary.approved, applied: run.summary.applied,
			cheapToken: run.summary.cheapToken, evolveToken: run.summary.evolveToken,
			backlog: run.summary.backlog, dropped: run.summary.dropped,
			skipReasons: run.skipReasons.length > 0 ? run.skipReasons : undefined,
		});
	}
	if (failed) {
		throw escaped;
	}
	return run.summary;
}

/** Review one candidate; true stops the loop (hard cap hit). */
async function reviewOneCandidate(run: BatchRun, candidate: ReviewCandidate): Promise<boolean> {
	const { deps, opts, runId, route, ring, summary, skipReasons } = run;
	try {
		const remaining = deps.store.consumeReviewBudget(opts.day, opts.budget);
		if (remaining < 0) {
			exhaustBudget(run);
			return true;
		}
		summary.reviewed += 1;
		run.counts[candidate.source] += 1;
		if (route === undefined || ring === undefined) {
			deps.store.logReview({
				runId, workspaceId: candidate.workspaceId, itemKind: candidate.kind, itemId: candidate.id,
				verdict: "skip", reason: "no-route", applied: 0,
			});
			skipReasons.push("no-route");
			run.position += 1;
			return false;
		}
		const item: ReviewItem = {
			deps, loader: ring.loader, route, runId, candidate, opts, summary, skipReasons,
			gate: { usage: zeroUsage(), raw: undefined },
		};
		await runChain(ring.links, item);
		if (isRouteRejectedCode(item.faultCode)) {
			// The gate/evolve leg already ledgered this item's own failure; this
			// row is the drain's account of why it stopped, and the remaining
			// candidates stay queued (nothing is dropped, nothing is re-billed).
			deps.store.logReview({
				runId, workspaceId: candidate.workspaceId, itemKind: candidate.kind, itemId: candidate.id,
				verdict: "skip", reason: ROUTE_REJECTED_REASON, model: route?.model, applied: 0,
			});
			skipReasons.push(ROUTE_REJECTED_REASON);
			run.summary.routeRejected = true;
			run.position += 1;
			return true;
		}
	} catch (error) {
		// A fault escaping the chain (a store write, a wiring bug) gets its
		// own row carrying the error text and costs the batch only this
		// item — the model-facing failures already degrade inside the ring.
		deps.store.logReview({
			runId, workspaceId: candidate.workspaceId, itemKind: candidate.kind, itemId: candidate.id,
			verdict: "skip", reason: `review-failed: ${failureHead(error)}`,
			model: route?.model, applied: 0,
		});
		skipReasons.push("review-failed");
	}
	run.position += 1;
	return false;
}

/** Hard cap hit: this item and everything after it drops. */
function exhaustBudget(run: BatchRun): void {
	const { deps, batch, runId, summary, skipReasons } = run;
	// Hard cap hit: this item and everything after it drops (low
	// priority never rolls over — it simply waits for a future run).
	summary.dropped += batch.length - run.position;
	for (const item of batch.slice(run.position)) {
		deps.store.logReview({
			runId, workspaceId: item.workspaceId, itemKind: item.kind, itemId: item.id,
			verdict: "skip", reason: "budget-exhausted", applied: 0,
		});
	}
	skipReasons.push("budget-exhausted");
}
