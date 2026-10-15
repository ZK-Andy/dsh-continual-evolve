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
import { resolveCallRoute, type LlmRuntime, type ModelSelection, type RouteResolver } from "./llm-call.js";
import { cwdOf } from "./surfaces/memory-section.js";
import { todayUtc } from "./prompt-date.js";
import type { PluginLog } from "./plugin-log.js";
import { collectCandidates } from "./review-candidates.js";
import { failureHead, assembleRing, type ReviewItem, type ReviewRing } from "./review-ring.js";
import type { MemoryStore } from "./store.js";
import { zeroUsage } from "./token-usage.js";

/** The LLM face review calls, aliased so each scheduler can name its own. */
export type ReviewLlm = LlmRuntime;

export interface ReviewDeps {
	store: MemoryStore;
	llm: LlmRuntime | undefined;
	/**
	 * Route resolution for a direct call: the agent's explicit selection first,
	 * the host default model second. Absent keeps the legacy agent-options-only
	 * behavior (tests and older hosts).
	 */
	resolveRoute?: RouteResolver | undefined;
}

export interface ReviewCandidate {
	workspaceId: string;
	kind: "memory" | "skill";
	id: string;
	/** 0 = new, 1 = corrects-linked requeue, 2 = stale requeue. */
	priority: number;
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
	newItems: number;
	requeued: number;
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
		summary: { reviewed: 0, approved: 0, applied: 0, dropped: 0, backlog: 0, cheapToken: 0, evolveToken: 0 },
		skipReasons: [], newItems: 0, requeued: 0, position: 0,
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
			newItems: run.newItems, requeued: run.requeued, approved: run.summary.approved, applied: run.summary.applied,
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
		if (candidate.priority === 0) {
			run.newItems += 1;
		} else {
			run.requeued += 1;
		}
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

/** The event wiring surface (duck-typed cordis context, mirrors extraction). */
export interface ReviewSchedulerHost {
	on(event: string, handler: (...args: never[]) => void): unknown;
	/** The plugin's own log face: durable in the store, mirrored live. */
	log: PluginLog;
}

/** The editable review settings, re-read on every drain. */
export interface ReviewSettings {
	dryRun: boolean;
	dailyBudget: number;
	batchSize: number;
	staleDays: number;
}

export interface ReviewSchedulerConfig {
	enabled: boolean;
	/**
	 * Read the current settings for each drain: the host's configuration is
	 * volatile, so values edited live take effect without a remount and are
	 * never captured once at mount time.
	 */
	read: () => ReviewSettings;
	/** Minimum ms between two drains (default 5 minutes). */
	minIntervalMs: number;
}

/**
 * Wire the review triggers onto the host context. Global single-flight with
 * a minimum interval: turn boundaries arm the pending workspace, compaction
 * and session close drain immediately. Each drain reviews one batch bounded
 * by the remaining daily budget — never more.
 */
/** The review scheduler's mutable wiring: single-flight flag, pacing, and the pending route. */
interface ReviewSchedulerState {
	running: boolean;
	lastRunAt: number;
	pendingWorkspace: string | undefined;
	lastRoute: { provider: string; model: string; sessionId: string } | undefined;
}

export function createReviewScheduler(
	host: ReviewSchedulerHost,
	deps: ReviewDeps,
	config: ReviewSchedulerConfig,
): () => void {
	const listeners: unknown[] = [];
	const state: ReviewSchedulerState = { running: false, lastRunAt: 0, pendingWorkspace: undefined, lastRoute: undefined };

	listeners.push(
		host.on("agent/turn-stopping", (payload: { agent?: unknown }) => {
			const agent = payload.agent as { id?: unknown } | undefined;
			const id = agent?.id;
			if (typeof id !== "string" || id.length === 0) {
				return;
			}
			// A drain needs a live route. A session running on the host default
			// model carries no explicit selection, so the default-model service
			// fills it in; with neither, the boundary is only remembered and the
			// next turn boundary reviews it. This is what keeps a review call
			// from being sent with an empty provider or a dead session identity
			// (both of which the provider answers with a bare stream error).
			// Absent resolver (older host, tests) still reads the agent's explicit
			// selection: the fallback is the legacy behavior, never "no route".
			const route = deps.resolveRoute?.(agent) ?? resolveCallRoute(agent, undefined);
			if (route === undefined) {
				state.pendingWorkspace = cwdOf(agent);
				return;
			}
			state.lastRoute = { provider: route.provider, model: route.model, sessionId: id };
			drainReview(state, host, deps, config, cwdOf(agent));
		}),
	);
	const armed = config.read();
	host.log.info(
		"review-armed",
		`scheduler armed (daily cap ${armed.dailyBudget}, dry-run ${armed.dryRun ? "on" : "off"})`,
	);
	return () => {
		state.pendingWorkspace = undefined;
		for (const listener of listeners) {
			if (typeof listener === "function") {
				listener();
			}
		}
	};
}

/** Drain one batch when guards pass: enabled, single-flight, paced, routed. */
function drainReview(
	state: ReviewSchedulerState,
	host: ReviewSchedulerHost,
	deps: ReviewDeps,
	config: ReviewSchedulerConfig,
	triggerWorkspace: string | undefined,
): void {
	if (!config.enabled || state.running) {
		if (triggerWorkspace !== undefined) {
			state.pendingWorkspace = triggerWorkspace;
		}
		return;
	}
	if (Date.now() - state.lastRunAt < config.minIntervalMs) {
		if (triggerWorkspace !== undefined) {
			state.pendingWorkspace = triggerWorkspace;
		}
		return;
	}
	if (deps.llm === undefined || state.lastRoute?.provider === undefined || state.lastRoute?.model === undefined) {
		return;
	}
	state.running = true;
	state.lastRunAt = Date.now();
	const workspace = triggerWorkspace ?? state.pendingWorkspace;
	state.pendingWorkspace = undefined;
	const route = state.lastRoute;
	void runDrain(state, host, deps, config, workspace, route);
}

/** Run one drain: budget check, candidate batch, and the drain's own ledger discipline. */
async function runDrain(
	state: ReviewSchedulerState,
	host: ReviewSchedulerHost,
	deps: ReviewDeps,
	config: ReviewSchedulerConfig,
	workspace: string | undefined,
	route: { provider: string; model: string; sessionId: string } | undefined,
): Promise<void> {
	const settings = config.read();
	const day = todayUtc();
	try {
		const daily = deps.store.getDaily(day);
		const remaining = settings.dailyBudget - (daily?.reviewed ?? 0);
		if (remaining <= 0) {
			host.log.info(
				"review-budget-spent",
				`drain skipped: daily budget spent (${daily?.reviewed ?? 0}/${settings.dailyBudget})`,
				{ workspaceId: workspace },
			);
			return;
		}
		const candidates = collectCandidates(deps.store, { staleDays: settings.staleDays, limit: settings.batchSize * 2 });
		const ordered = workspace === undefined
			? candidates
			: [...candidates.filter((c) => c.workspaceId === workspace), ...candidates.filter((c) => c.workspaceId !== workspace)];
		const summary = await runReviewBatch(deps, ordered.slice(0, settings.batchSize), {
			day, budget: settings.dailyBudget, dryRun: settings.dryRun,
			batchSize: settings.batchSize, staleDays: settings.staleDays,
			provider: route?.provider, model: route?.model, sessionId: route?.sessionId,
		});
		host.log.info(
			"review-drain",
			`reviewed ${summary.reviewed}, approved ${summary.approved}, ` +
				`applied ${summary.applied}, dropped ${summary.dropped}, backlog ${summary.backlog}`,
			{ workspaceId: workspace, sessionId: route?.sessionId },
		);
	} catch (error) {
		const head = failureHead(error);
		host.log.warn("review-drain-failed", head, { workspaceId: workspace, sessionId: route?.sessionId });
		// Two records on purpose: the log is the live channel, the day's
		// rollup is the durable one every later reading sees. A drain that
		// died must leave a trace in the ledger, not only in a log row.
		try {
			deps.store.mergeDaily(day, settings.dailyBudget, { skipReasons: [`drain-failed: ${head}`] });
		} catch (recordError) {
			host.log.warn("review-drain-unledgered", failureHead(recordError), { workspaceId: workspace });
		}
	} finally {
		state.running = false;
	}
}
