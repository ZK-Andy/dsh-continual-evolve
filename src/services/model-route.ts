/**
 * Where a direct call's route comes from: the four candidates, in the host's
 * own order of truth, and the one that answered.
 *
 * Only the first two follow a model switch made mid-session. `agent.options`
 * is a snapshot frozen when the agent was created and `agentDefaultModel` is a
 * process default read at startup, so a session that switched models kept
 * seeing its background tracks send to the model it had left (2026-10-16:
 * session on `deepseek-v4.1-flash`, both fallbacks still naming
 * `muse-spark`, five 403s in one session). Reading the session's *current*
 * selection is the only candidate that is already right when a switch has
 * happened but the next request has not been sent.
 *
 * Every candidate is duck-typed and optional — a host without the projection
 * registry, an older host, or a throwing service just moves the answer down
 * the chain, and "no candidate answered" stays the refusal path. The caller
 * traces which candidate won (`route-resolved`), because a silent fallback to
 * `agent.options` looks exactly like a working fix in the ledger.
 */

/** One concrete provider/model route for a direct call. */
export interface ModelSelection {
	provider: string;
	model: string;
	reasoningEffort?: string | undefined;
}

/** The host's default-model service, reached as `ctx.get("agentDefaultModel")`. */
export interface DefaultModelService {
	currentSelection(): unknown;
}

/** The host's session-projection registry, reached as `ctx.get("sessionProjections")`. */
export interface SessionProjectionService {
	/** One registered projection's state for one session (`undefined` when the key is not registered). */
	stateOf(session: unknown, key: string): unknown;
}

/** Which candidate supplied a resolved route: the point of tracing the route at all. */
export type RouteSource = "session-selection" | "request-header" | "agent-options" | "host-default";

/** One resolved route and the candidate it came from. */
export interface ResolvedRoute {
	selection: ModelSelection;
	source: RouteSource;
}

/** Read one sibling service off the host context (`ctx.get`). */
export type ServiceGetter = (name: string) => unknown;

/** Resolve one direct call's route, with the candidate that supplied it. */
export type RouteResolver = (agent: unknown) => ResolvedRoute | undefined;

/**
 * The host's default model selection, when the host exposes that service.
 *
 * The service is read through `ctx.get` and never joins an inject list: a host
 * without it (or an older one) must keep working, and a failed read is simply
 * "no default", never a mount failure.
 *
 * @param get - The host context's sibling-service reader, when available.
 * @returns The default provider/model (plus effort), or `undefined` when unknown.
 */
export function defaultRouteOf(get: ServiceGetter | undefined): ModelSelection | undefined {
	if (get === undefined) {
		return undefined;
	}
	let service: unknown;
	try {
		service = get("agentDefaultModel");
	} catch {
		// An absent service is not an error here: the caller falls back to refusing.
		return undefined;
	}
	const currentSelection = (service as Partial<DefaultModelService> | undefined)?.currentSelection;
	if (typeof currentSelection !== "function") {
		return undefined;
	}
	try {
		return selectionOf(currentSelection.call(service));
	} catch {
		// A throwing service is "no default" — the refusal path stays reachable.
		return undefined;
	}
}

/**
 * The session's current selection as the host itself resolves it: the
 * `modelSelection` projection's `pending` (what the next request will use),
 * then `lastUsed`.
 *
 * `pending` first is the host's own order (`selectionFor` reads the projection
 * before the logged header) and it is the only candidate that is already right
 * when a model switch has happened but the next request has not been sent —
 * the window the 2026-10-16 incident lived in.
 *
 * @param agent - The host Agent the call belongs to.
 * @param get - The host context's sibling-service reader, when available.
 * @returns The session's selection, or `undefined` when the projection is unreachable.
 */
function sessionSelectionOf(agent: unknown, get: ServiceGetter | undefined): ModelSelection | undefined {
	const session = sessionOf(agent);
	if (session === undefined || get === undefined) {
		return undefined;
	}
	let service: unknown;
	try {
		service = get("sessionProjections");
	} catch {
		// No projection registry on this host: the next candidate answers.
		return undefined;
	}
	const stateOf = (service as Partial<SessionProjectionService> | undefined)?.stateOf;
	if (typeof stateOf !== "function") {
		return undefined;
	}
	let state: unknown;
	try {
		state = stateOf.call(service, session, "modelSelection");
	} catch {
		// An unregistered projection key is "no session selection", never fatal.
		return undefined;
	}
	if (typeof state !== "object" || state === null) {
		return undefined;
	}
	const { pending, lastUsed } = state as { pending?: unknown; lastUsed?: unknown };
	return selectionOf(pending) ?? selectionOf(lastUsed);
}

/**
 * The route the session's last real request ran on, from its logged header.
 *
 * @param agent - The host Agent the call belongs to.
 * @returns That route, or `undefined` when the session has not logged one.
 */
function requestHeaderRoute(agent: unknown): ModelSelection | undefined {
	const session = sessionOf(agent);
	if (session === undefined) {
		return undefined;
	}
	const requestHeader = (session as { requestHeader?: unknown }).requestHeader;
	if (typeof requestHeader !== "function") {
		return undefined;
	}
	try {
		const header = requestHeader.call(session) as { config?: unknown } | undefined;
		return selectionOf(header?.config);
	} catch {
		// A throwing session is "no header" — the fallback chain continues.
		return undefined;
	}
}

/** One Agent's session, when it carries one. */
function sessionOf(agent: unknown): object | undefined {
	const session = (agent as { session?: unknown } | undefined)?.session;
	return typeof session === "object" && session !== null ? session : undefined;
}

/**
 * Resolve the route one direct call runs on, strongest truth first: the
 * session's current selection, the session's last request header, the agent's
 * creation-time `options`, the host's default model.
 *
 * The order matters because only the first two follow a model switch made
 * mid-session: `agent.options` is a snapshot frozen when the agent was created
 * (2026-10-16: a session switched to `deepseek-v4.1-flash` while both
 * `options` and the process default still named `muse-spark`, so the
 * background tracks kept sending 403 requests to a model the session had
 * already left). Every candidate is duck-typed and optional: an unreachable
 * one is skipped, and "no candidate answered" stays the refusal path.
 *
 * @param agent - The host Agent the call belongs to (its `options` may be empty).
 * @param get - The host context's sibling-service reader, when available.
 * @returns The route plus the candidate that supplied it, or `undefined` when there is none.
 */
export function resolveCallRoute(agent: unknown, get: ServiceGetter | undefined): ResolvedRoute | undefined {
	const candidates: readonly (readonly [RouteSource, () => ModelSelection | undefined])[] = [
		["session-selection", () => sessionSelectionOf(agent, get)],
		["request-header", () => requestHeaderRoute(agent)],
		["agent-options", () => selectionOf((agent as { options?: unknown } | undefined)?.options)],
		["host-default", () => defaultRouteOf(get)],
	];
	for (const [source, read] of candidates) {
		const selection = read();
		if (selection !== undefined) {
			return { selection, source };
		}
	}
	return undefined;
}

/** Narrow one candidate selection object; empty strings count as absent. */
function selectionOf(value: unknown): ModelSelection | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const { provider, model, reasoningEffort } = value as { provider?: unknown; model?: unknown; reasoningEffort?: unknown };
	if (typeof provider !== "string" || provider.length === 0) {
		return undefined;
	}
	if (typeof model !== "string" || model.length === 0) {
		return undefined;
	}
	return typeof reasoningEffort === "string" && reasoningEffort.length > 0
		? { provider, model, reasoningEffort }
		: { provider, model };
}
