/**
 * The review track's scheduler: when a drain runs, on which route, and what
 * the failure discipline does about a route the provider refuses.
 *
 * The batch it drains lives in `review.ts` — this module owns the triggers
 * (turn boundaries arm a workspace, compaction and session close drain at
 * once), the pacing (single-flight, a minimum interval between drains), the
 * route it settles on, and the halt that stops a refused route from being
 * re-billed once per candidate.
 */
import { resolveCallRoute, type ResolvedRoute, type RouteSource } from "./model-route.js";
import { routeRefOf } from "./extraction-failure.js";
import { collectCandidatesWithUnchanged } from "./review-candidates.js";
import { failureHead } from "./review-ring.js";
import { runReviewBatch, type ReviewDeps } from "./review.js";
import { cwdOf } from "./agent.js";
import { todayUtc } from "./prompt-date.js";
import type { PluginLog } from "./plugin-log.js";

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
	lastRoute: { provider: string; model: string; sessionId: string; source: RouteSource } | undefined;
	/**
	 * The route the last drain was refused on. A refusal belongs to the route
	 * it happened on, so a different route (a model switch) lifts it; it lives
	 * here rather than in the store because a host restart lifts it too.
	 */
	rejectedRoute: string | undefined;
}

export function createReviewScheduler(
	host: ReviewSchedulerHost,
	deps: ReviewDeps,
	config: ReviewSchedulerConfig,
): () => void {
	const listeners: unknown[] = [];
	const state: ReviewSchedulerState = {
		running: false,
		lastRunAt: 0,
		pendingWorkspace: undefined,
		lastRoute: undefined,
		rejectedRoute: undefined,
	};

	listeners.push(
		host.on("agent/turn-stopping", (payload: { agent?: unknown }) => {
			const agent = payload.agent as { id?: unknown } | undefined;
			const id = agent?.id;
			if (typeof id !== "string" || id.length === 0) {
				return;
			}
			// A drain needs a live route: the session's current selection first,
			// then its last request header, the agent's creation-time options, the
			// host default. With none, the boundary is only remembered and the next
			// turn boundary reviews it — a review call is never sent with an empty
			// provider or a dead session identity (both answered by a bare stream
			// error). Absent resolver (older host, tests) still reads the agent's
			// explicit selection: the fallback is the legacy behavior, never "no route".
			const route: ResolvedRoute | undefined = deps.resolveRoute?.(agent) ?? resolveCallRoute(agent, undefined);
			if (route === undefined) {
				state.pendingWorkspace = cwdOf(agent);
				return;
			}
			state.lastRoute = {
				provider: route.selection.provider,
				model: route.selection.model,
				sessionId: id,
				source: route.source,
			};
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
	const routeRef = routeRefOf(state.lastRoute.provider, state.lastRoute.model);
	if (state.rejectedRoute === routeRef) {
		// Refused on this route already: a drain here would pay for the same
		// refusal once per candidate until the budget ran out.
		return;
	}
	if (state.rejectedRoute !== undefined) {
		const unfrozen = state.rejectedRoute;
		state.rejectedRoute = undefined;
		host.log.info("route-unfrozen", `${unfrozen} → ${routeRef}: reviewing again`, {
			workspaceId: triggerWorkspace,
			sessionId: state.lastRoute.sessionId,
		});
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
	route: { provider: string; model: string; sessionId: string; source: RouteSource } | undefined,
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
		const candidates = collectCandidatesWithUnchanged(deps.store, {
			staleDays: settings.staleDays,
			batchSize: settings.batchSize,
			limit: settings.batchSize * 2,
		});
		// P1 unchanged gate (D7): event-pending items held back for zero
		// change cost no LLM call; the count rides the log, not the daily
		// rollup (whose requeued = link+clock+sampled sum stays intact).
		if (candidates.unchangedEvents.length > 0) {
			const shown = candidates.unchangedEvents
				.slice(0, 20)
				.map((entry) => `${entry.kind}:${entry.id}`)
				.join(", ");
			host.log.info(
				"review-unchanged-events",
				`event tier held back ${candidates.unchangedEvents.length} unchanged since last review (${shown})`,
				{ workspaceId: workspace },
			);
		}
		const ordered = workspace === undefined
			? candidates.candidates
			: [...candidates.candidates.filter((c) => c.workspaceId === workspace), ...candidates.candidates.filter((c) => c.workspaceId !== workspace)];
		// The trace's review half: whatever candidate the scheduler settled on is
		// in the log before the first item pays for a verdict (2026-10-16). The
		// log face never throws — a trace must not take a drain down.
		host.log.info("route-resolved", `${route?.provider ?? "?"}/${route?.model ?? "?"} via ${route?.source ?? "none"} (review drain)`, {
			workspaceId: workspace,
			sessionId: route?.sessionId,
		});
		const summary = await runReviewBatch(deps, ordered.slice(0, settings.batchSize), {
			day, budget: settings.dailyBudget, dryRun: settings.dryRun,
			batchSize: settings.batchSize, staleDays: settings.staleDays,
			provider: route?.provider, model: route?.model, sessionId: route?.sessionId,
		});
		if (summary.routeRejected && route !== undefined) {
			state.rejectedRoute = routeRefOf(route.provider, route.model);
			host.log.warn("route-halted", `${state.rejectedRoute} refused: no review calls until the route changes`, {
				workspaceId: workspace,
				sessionId: route.sessionId,
			});
		}
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
