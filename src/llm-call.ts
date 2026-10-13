/**
 * The shared boundary for the plugin's own LLM calls: extraction's cheap
 * pre-gate and full proposal call, and review's gate and evolve passes all
 * stream through here.
 *
 * Three disciplines live in one place because all three were learned the hard
 * way, and none of them is visible at a call site:
 *
 * - **The route.** `agent.options` carries an *explicit* selection only. A
 *   session running on the host's default model carries nothing there, so the
 *   route falls back to the host's `agentDefaultModel` service — the same
 *   value the host Agent loop itself runs on. A caller that still has no
 *   route refuses to send instead of streaming into a provider rejection.
 * - **The reasoning effort.** An exact provider/model advertises the effort
 *   ids it accepts, and a request naming one it does not accept is rejected
 *   by capability validation before any provider I/O. The lowest *enabled*
 *   effort the model advertises is used; a model with no reasoning metadata
 *   gets no caller-supplied effort at all. This is the pre-teardown
 *   `llm-text.ts` discipline (see the 2026-09-24 capability note), restored
 *   after the direct calls that replaced that boundary shipped without it.
 * - **The failure text.** A terminal `error`/`aborted` finish carries the
 *   host's own failure object. Keeping only its `kind` produced a ledger full
 *   of "stream finished with error" that named no cause for a whole day.
 */

/** The minimal LLM face a direct call needs (duck-typed host service). */
export interface LlmStream {
	stream(options: Record<string, unknown>): AsyncIterable<unknown>;
}

/** Exact-model capability metadata, narrowed to the field this plugin reads. */
export interface ModelInfo {
	reasoning?: { efforts?: unknown } | undefined;
}

/** The LLM service plus the optional exact-model capability query. */
export interface LlmRuntime extends LlmStream {
	/** Resolve one exact provider/model's capabilities; absent on older hosts and test fakes. */
	resolveModelInfo?(provider: string, model: string): Promise<ModelInfo | undefined> | ModelInfo | undefined;
}

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

/** Read one sibling service off the host context (`ctx.get`). */
export type ServiceGetter = (name: string) => unknown;

/** Resolve one direct call's route from the agent plus the host default model. */
export type RouteResolver = (agent: unknown) => ModelSelection | undefined;

/** Effort ids that mean "reasoning off"; a model may advertise only these. */
export const CLOSED_REASONING_EFFORTS: ReadonlySet<string> = new Set(["disabled", "off", "none"]);

/**
 * Select the lowest reasoning effort an exact model advertises.
 *
 * An enabled effort wins over a declared closing effort: the adapter's first
 * enabled effort is the lowest enabled level it exposes, and a closing effort
 * is only a fallback when the model publishes no enabled level at all. No
 * capability list means no caller-supplied effort.
 *
 * @param modelInfo - Exact resolved-model metadata, when the provider exposes it.
 * @returns The provider-owned effort id to send, or `undefined` to omit the field.
 * @throws When the host reports reasoning metadata in a shape this plugin cannot trust.
 */
export function selectLowestReasoningEffort(modelInfo: ModelInfo | undefined): string | undefined {
	const efforts = modelInfo?.reasoning?.efforts;
	if (efforts === undefined) {
		return undefined;
	}
	if (!Array.isArray(efforts)) {
		throw new Error("continual-evolve: invalid model reasoning metadata");
	}
	const ids: string[] = [];
	for (const effort of efforts as readonly unknown[]) {
		const id = (effort as { id?: unknown } | null | undefined)?.id;
		if (typeof id !== "string") {
			throw new Error("continual-evolve: invalid model reasoning metadata");
		}
		ids.push(id);
	}
	return ids.find((id) => !CLOSED_REASONING_EFFORTS.has(id)) ?? ids[0];
}

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
 * Resolve the route one direct call runs on: the agent's explicit selection
 * first, the host default second.
 *
 * @param agent - The host Agent the call belongs to (its `options` may be empty).
 * @param get - The host context's sibling-service reader, when available.
 * @returns The route to call with, or `undefined` when there is none to use.
 */
export function resolveCallRoute(agent: unknown, get: ServiceGetter | undefined): ModelSelection | undefined {
	const options = (agent as { options?: unknown } | undefined)?.options;
	return selectionOf(options) ?? defaultRouteOf(get);
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

/** One completed direct call: its text, usage, terminal finish kind, and chosen effort. */
export interface StreamOnceResult {
	text: string;
	usage: unknown;
	/** The host's finish kind (`stop`, `max-tokens`, …); `undefined` when the stream omitted it. */
	finish: string | undefined;
	/** The capability-derived effort actually sent, for diagnostics. */
	reasoningEffort: string | undefined;
}

/**
 * Stream one single-turn text call on one route.
 *
 * A terminal `error` or `aborted` finish always throws, carrying the host's own
 * failure text — partial text never rescues a failed call. A `max-tokens` cut
 * is *not* thrown here: a gate answer often completes before its budget does,
 * so the caller owns that verdict and reads `finish`.
 *
 * @param llm - The LLM service; `undefined` means the host exposed no route at all.
 * @param route - The exact provider/model to call.
 * @param sessionId - The host Agent identity providers use for request routing.
 * @param system - The system prompt for this call.
 * @param prompt - The user prompt for this call.
 * @param maxTokens - Output budget for this call.
 * @returns The assembled text, usage, finish kind, and chosen effort.
 * @throws On a missing LLM service, capability lookup failure, terminal provider error or abort, and empty output.
 */
export async function streamOnce(
	llm: LlmRuntime | undefined,
	route: ModelSelection,
	sessionId: string | undefined,
	system: string,
	prompt: string,
	maxTokens: number,
): Promise<StreamOnceResult> {
	if (llm === undefined) {
		throw new Error("no llm route");
	}
	const reasoningEffort = await resolveReasoningEffort(llm, route);
	let text = "";
	let usage: unknown;
	let finish: { kind?: string; failure?: unknown } | undefined;
	for await (const chunk of llm.stream({
		provider: route.provider,
		model: route.model,
		messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
		system,
		maxTokens,
		sessionId,
		...(reasoningEffort === undefined ? {} : { reasoningEffort }),
	})) {
		const piece = chunk as { type?: string; text?: unknown; usage?: unknown; reason?: { kind?: string; failure?: unknown } };
		if (piece?.type === "text-delta" && typeof piece.text === "string") {
			text += piece.text;
		} else if (piece?.type === "usage") {
			usage = piece.usage;
		} else if (piece?.type === "finish") {
			finish = piece.reason;
		}
	}
	const finishKind = finish?.kind;
	if (finishKind === "error" || finishKind === "aborted") {
		throw new Error(failureTextOf(finishKind, finish?.failure));
	}
	if (text.trim().length === 0) {
		// Nothing usable arrived: the finish reason is the only diagnosis.
		throw new Error(finishKind !== undefined && finishKind !== "stop" ? `stream finished with ${finishKind}` : "empty model output");
	}
	return { text, usage, finish: finishKind, reasoningEffort };
}

/**
 * Resolve the effort to send for one exact route.
 *
 * The host's capability query is the only source: an explicit selection's
 * effort belongs to the *main* conversation and must not silently raise an
 * auxiliary call's cost. No query (older host, test fake) means no effort.
 */
async function resolveReasoningEffort(llm: LlmRuntime, route: ModelSelection): Promise<string | undefined> {
	if (typeof llm.resolveModelInfo !== "function") {
		return undefined;
	}
	const modelInfo = await llm.resolveModelInfo(route.provider, route.model);
	return selectLowestReasoningEffort(modelInfo);
}

/** Render a terminal failure for the ledger: host code plus host message. */
function failureTextOf(kind: string, failure: unknown): string {
	const detail = failureDetailOf(failure);
	return detail === undefined ? `stream finished with ${kind}` : `LLM call ${kind}: ${detail}`;
}

/** Flatten the host failure object to `code: message` when either is present. */
function failureDetailOf(failure: unknown): string | undefined {
	if (typeof failure !== "object" || failure === null) {
		return undefined;
	}
	const { code, message } = failure as { code?: unknown; message?: unknown };
	const head = typeof message === "string" && message.length > 0 ? message : undefined;
	const label = typeof code === "string" && code.length > 0 ? code : undefined;
	if (head !== undefined && label !== undefined) {
		return `${label}: ${head}`;
	}
	return head ?? label;
}
