/**
 * What the extraction track remembers about a session whose calls failed.
 *
 * Two questions, two homes. *Has this route been refused?* is a property of the
 * running process — a refusal ends when the host restarts, so it lives in the
 * scheduler's own slot and never outlives it. *How many transient failures in a
 * row, and not before when?* is worth surviving a reload and worth inspecting,
 * so it lives in the store's `state` table under `extract:fail:<sessionId>`,
 * self-describing and swept by retention.
 *
 * The record is the second half of 2026-10-16: a refused route was retried on
 * every turn boundary (10 refusals, two calls each) because nothing remembered
 * the previous one. A record that outlives the turn is what turns "retry
 * forever" into "back off, and stop calling a route that is refused".
 */
import { GLOBAL_WORKSPACE, ROUTE_BACKOFF_REASON, ROUTE_HALTED_REASON, type LedgerEntry, type MemoryStore } from "../store.js";
import { isRouteRejectedCode } from "./llm-call.js";
import type { PluginLog } from "./plugin-log.js";

/**
 * One session's in-process halt: the route whose terminal failure stopped the
 * track. Structural so the scheduler's own slot fits it without an import.
 */
export interface RouteHaltState {
	rejectedRoute?: string | undefined;
}

/** What the failure discipline says about one drain. */
export interface DrainDecision {
	action: "run" | "backoff" | "halted";
	/** The route a halt was just lifted from (the route changed); absent otherwise. */
	unfrozen?: string | undefined;
}

/** The part of a finished run's outcome the discipline classifies on. */
export interface RunFaultOutcome {
	status: "applied" | "rejected" | "skipped" | "failed";
	/** The host's failure code when the run died on its LLM call. */
	faultCode?: string | undefined;
}

/** The key prefix every route-failure record of one store lives under. */
export const FAILURE_STATE_PREFIX = "extract:fail:";

/** One session's route failures: how many in a row, and the earliest retry instant. */
export interface RouteFailure {
	/** Consecutive transient failures (reset by a success or a route change). */
	count: number;
	/** Epoch ms before which no retry may be attempted (`0` = retry freely). */
	until: number;
	/** The route the failures happened on, as `provider/model`; a different route ignores the record. */
	route: string;
}

/** The state key one session's record lives under. */
export function failureStateKey(sessionId: string): string {
	return `${FAILURE_STATE_PREFIX}${sessionId}`;
}

/** One route as the record compares it. */
export function routeRefOf(provider: string | undefined, model: string | undefined): string {
	return `${provider ?? "?"}/${model ?? "?"}`;
}

/**
 * The wait before the next attempt after `count` consecutive failures: the
 * first failure retries at once (a single blip should not delay a session),
 * then 5min → 15min → 1h → 6h, capped.
 * @param count - Consecutive transient failures so far.
 * @param now - Epoch ms of the failure.
 * @returns The earliest epoch ms the next attempt may run.
 */
export function backoffUntil(count: number, now: number): number {
	const steps = [0, 5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
	const index = Math.min(Math.max(count, 1), steps.length) - 1;
	return now + (steps[index] ?? 0);
}

/**
 * Read one session's failure record.
 *
 * A store that cannot answer — closed under a shutdown, finalized by a test
 * teardown — reads as "no record": the record is a guard for the next turn,
 * and the run it guards reports a dead store on its own account anyway. This
 * read happens on the scheduler's synchronous path (including a re-entrant
 * drain from a finished run), where a throw would become an unhandled
 * rejection rather than a reported failure.
 *
 * @param store - The open store.
 * @param workspaceId - The session's workspace partition.
 * @param sessionId - The session the record belongs to.
 * @returns The record, or `undefined` when there is none (or it is unreadable).
 */
export function readRouteFailure(store: MemoryStore, workspaceId: string, sessionId: string): RouteFailure | undefined {
	let value: string | undefined;
	try {
		value = store.state(workspaceId, failureStateKey(sessionId));
	} catch {
		// Named swallow: an unreadable record is no record (see above).
		return undefined;
	}
	return parseRouteFailure(value);
}

/**
 * Parse one stored record, tolerating anything that is not one.
 * @param value - The raw `state` value.
 * @returns The record, or `undefined` when the value is absent or not a record this module wrote.
 */
export function parseRouteFailure(value: string | undefined): RouteFailure | undefined {
	if (value === undefined) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		// A value under this prefix that is not JSON was not written here: it is
		// not a record, and reading it as none is the only safe reading.
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	const { count, until, route } = parsed as { count?: unknown; until?: unknown; route?: unknown };
	if (typeof count !== "number" || typeof until !== "number" || typeof route !== "string") {
		return undefined;
	}
	return { count, until, route };
}

/**
 * Write one session's failure record.
 * @param store - The open store.
 * @param workspaceId - The session's workspace partition.
 * @param sessionId - The session the record belongs to.
 * @param record - The record to store.
 */
export function writeRouteFailure(store: MemoryStore, workspaceId: string, sessionId: string, record: RouteFailure): void {
	store.setState(workspaceId, failureStateKey(sessionId), JSON.stringify(record));
}

/**
 * Forget a session's failures after a run that was not a fault: the next
 * failure starts a fresh count, which is exactly what a success means.
 * @param store - The open store.
 * @param workspaceId - The session's workspace partition.
 * @param sessionId - The session to clear.
 */
export function clearRouteFailure(store: MemoryStore, workspaceId: string, sessionId: string): void {
	store.deleteState(workspaceId, failureStateKey(sessionId));
}

/**
 * What the failure discipline says about one drain: run it, wait out a
 * transient backoff, or stop calling a route the provider refused. The route
 * change is the one transition that lifts both, and it is noticed here —
 * before any surface read, so a halted session costs nothing per turn.
 */
export function drainDecisionOf(
	halt: RouteHaltState,
	store: MemoryStore,
	workspaceId: string,
	sessionId: string,
	route: string,
	now: number,
): DrainDecision {
	if (halt.rejectedRoute === route) {
		return { action: "halted" };
	}
	let unfrozen: string | undefined;
	if (halt.rejectedRoute !== undefined) {
		unfrozen = halt.rejectedRoute;
		halt.rejectedRoute = undefined;
	}
	const record = readRouteFailure(store, workspaceId, sessionId);
	if (record === undefined || record.route !== route || record.until <= now) {
		return unfrozen === undefined ? { action: "run" } : { action: "run", unfrozen };
	}
	return { action: "backoff" };
}

/**
 * Fold one finished run into the session's failure discipline: a clean run
 * clears the count, a refused route halts the session's track, and anything
 * else counts up the backoff ladder.
 */
export function recordRunOutcome(
	log: PluginLog,
	halt: RouteHaltState,
	store: MemoryStore,
	where: { workspaceId: string | undefined; sessionId: string },
	route: string,
	result: RunFaultOutcome,
	now: number,
): void {
	const partition = where.workspaceId ?? GLOBAL_WORKSPACE;
	if (result.status !== "failed") {
		halt.rejectedRoute = undefined;
		clearRouteFailure(store, partition, where.sessionId);
		return;
	}
	if (isRouteRejectedCode(result.faultCode)) {
		// Terminal: the same route would be refused again, so stop paying for it
		// every turn boundary. Nothing about it is persisted — the next host
		// start (or a model switch) is the unfreeze.
		halt.rejectedRoute = route;
		clearRouteFailure(store, partition, where.sessionId);
		log.warn("route-halted", `${route} refused: no calls until the route changes`, { ...where });
		return;
	}
	const previous = readRouteFailure(store, partition, where.sessionId);
	const count = (previous !== undefined && previous.route === route ? previous.count : 0) + 1;
	writeRouteFailure(store, partition, where.sessionId, { count, until: backoffUntil(count, now), route });
}

/**
 * Account for a wake-up the discipline suppressed instead of sending.
 *
 * The boundary is dropped, never consumed: the cursor stays where it was, so
 * the increment this wake-up stood for is still there to extract once the
 * route works again. The row coalesces (many quiet turns are one counted
 * line), and it is best-effort — a store that cannot take the account must not
 * turn a suppression into a failure.
 *
 * @param log - The plugin log face (never throws) for the fallback warn.
 * @param store - The open store.
 * @param where - The session and trigger the suppressed wake-up belonged to.
 * @param action - Why it was suppressed: a refused route, or an active backoff.
 */
export function recordSuppressedWakeUp(
	log: PluginLog,
	store: MemoryStore,
	where: { workspaceId: string | undefined; sessionId: string; trigger: LedgerEntry["trigger"]; model: string | undefined },
	action: "halted" | "backoff",
): void {
	try {
		store.logSkipped({
			sessionId: where.sessionId,
			workspaceId: where.workspaceId,
			trigger: where.trigger,
			skipReason: action === "halted" ? ROUTE_HALTED_REASON : ROUTE_BACKOFF_REASON,
			status: "skipped",
			model: where.model,
		});
	} catch (error) {
		log.warn("route-suppressed-unledgered", error instanceof Error ? error.message : String(error), {
			workspaceId: where.workspaceId,
			sessionId: where.sessionId,
		});
	}
}
