/**
 * The transport for the plugin's own LLM calls. Every subagent call
 * (`subagentDefs.ts` definitions loaded through `subagent.ts`) ends here.
 *
 * Four disciplines live in one place because all four were learned the hard
 * way, and none of them is visible at a call site:
 *
 * - **The route.** Imported from `./model-route.js`: four candidates in the
 *   host's own order of truth, the session's current selection first. A caller
 *   that ends up with no route refuses to send instead of streaming into a
 *   provider rejection.
 * - **The reasoning effort.** An exact provider/model advertises the effort
 *   ids it accepts, and a request naming one it does not accept is rejected
 *   by capability validation before any provider I/O. The lowest *enabled*
 *   effort the model advertises is used; a model with no reasoning metadata
 *   gets no caller-supplied effort at all. This is the pre-teardown
 *   `llm-text.ts` discipline (see the 2026-09-24 capability note), restored
 *   after the direct calls that replaced that boundary shipped without it.
 * - **The output budget.** A fixed budget is a guess about how much a model
 *   spends before it answers, and a wrong guess cuts the answer off as
 *   `max-tokens` — which reads in the ledger as a route fault (2026-10-13).
 *   The exact model's own advertised per-request cap wins; the definition's
 *   declared budget is only the fallback for adapters that advertise none.
 * - **The failure.** A terminal `error`/`aborted` finish carries the host's
 *   own failure object, and the stream has usually reported its usage by
 *   then. Both now ride the thrown error: keeping only the `kind` produced a
 *   ledger full of "stream finished with error", and discarding the usage
 *   left failed calls with no model and no token account at all.
 */

import type { ModelSelection } from "./model-route.js";

/** The minimal LLM face a direct call needs (duck-typed host service). */
export interface LlmStream {
	stream(options: Record<string, unknown>): AsyncIterable<unknown>;
}

/** Exact-model capability metadata, narrowed to the fields this plugin reads. */
export interface ModelInfo {
	reasoning?: { efforts?: unknown } | undefined;
	/** Adapter-configured per-request output cap; the host materializes it when callers omit `maxTokens`. */
	defaultMaxTokens?: unknown;
}

/** The LLM service plus the optional exact-model capability query. */
export interface LlmRuntime extends LlmStream {
	/** Resolve one exact provider/model's capabilities; absent on older hosts and test fakes. */
	resolveModelInfo?(provider: string, model: string): Promise<ModelInfo | undefined> | ModelInfo | undefined;
}

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
		throw new LlmConfigError("continual-evolve: invalid model reasoning metadata");
	}
	const ids: string[] = [];
	for (const effort of efforts as readonly unknown[]) {
		const id = (effort as { id?: unknown } | null | undefined)?.id;
		if (typeof id !== "string") {
			throw new LlmConfigError("continual-evolve: invalid model reasoning metadata");
		}
		ids.push(id);
	}
	return ids.find((id) => !CLOSED_REASONING_EFFORTS.has(id)) ?? ids[0];
}

/**
 * The output budget to send for one exact route: the model's own advertised
 * per-request cap when it has one, the caller's fallback otherwise.
 *
 * A budget below what the model needs is not a cost saving — it is a
 * truncation. Deriving it from the model's capability (the same source the
 * reasoning effort comes from) is what keeps one model's answer from being
 * cut off at a number chosen for another model's habits.
 *
 * @param modelInfo - Exact resolved-model metadata, when the provider exposes it.
 * @param fallbackMaxTokens - The definition's declared budget.
 * @returns The budget to send.
 * @throws When the host reports a max-tokens capability this plugin cannot trust.
 */
export function selectMaxTokens(modelInfo: ModelInfo | undefined, fallbackMaxTokens: number): number {
	const advertised = modelInfo?.defaultMaxTokens;
	if (advertised === undefined) {
		return fallbackMaxTokens;
	}
	if (typeof advertised !== "number" || !Number.isInteger(advertised) || advertised <= 0) {
		throw new LlmConfigError("continual-evolve: invalid model max-tokens metadata");
	}
	return advertised;
}

/**
 * A fault in this plugin's own configuration (capability metadata the host
 * answered with a shape the plugin cannot trust). Retrying cannot fix it, so
 * it classifies as terminal: the route halts until it changes.
 */
export class LlmConfigError extends Error {
	/** The stable code the failure discipline classifies on. */
	readonly code = "PLUGIN_CONFIG";

	constructor(message: string) {
		super(message);
		this.name = "LlmConfigError";
	}
}

/**
 * One failed call, carrying what the stream observed before it failed.
 *
 * The model and the tokens of a *failed* call are exactly what the ledger
 * could not answer for (2026-10-13): the route and usage existed in memory
 * and were dropped on the way out. They ride the error now, so every failure
 * path can account for itself the same way a success does.
 */
export class SubagentCallError extends Error {
	/** Usage payload observed before the failure, `undefined` when the stream never reported one. */
	readonly usage: unknown;
	/** The terminal finish kind, `undefined` when the stream failed before reporting one. */
	readonly finish: string | undefined;
	/** The route the failed call ran on. */
	readonly route: ModelSelection;
	/**
	 * The host's stable failure code (`AUTH`, `RATE_LIMIT`, `TRANSPORT`, …),
	 * when the failure carried one. Classification reads this, never the
	 * message: the host documents `code` as the field to route on, and the
	 * message is a composition of code, route, and provider prose.
	 */
	readonly code: string | undefined;

	constructor(
		message: string,
		observed: { usage: unknown; finish: string | undefined; route: ModelSelection; code?: unknown; cause?: unknown },
	) {
		super(message, observed.cause === undefined ? undefined : { cause: observed.cause });
		this.name = "SubagentCallError";
		this.usage = observed.usage;
		this.finish = observed.finish;
		this.route = observed.route;
		this.code = codeTextOf(observed.code);
	}
}

/**
 * Host failure codes that mean "this route is refused": no retry can help, so
 * the route halts until it changes. Everything else — rate limits, server and
 * transport faults, timeouts, empty responses, stream cuts, and codes this
 * plugin has never seen — is transient and retried under a backoff.
 */
const TERMINAL_ROUTE_CODES: ReadonlySet<string> = new Set(["AUTH", "NO_ADAPTER", "PLUGIN_CONFIG"]);

/**
 * One failure code as text: a code travels both as a field on a thrown value
 * and as an already-extracted string, and both are normalized here.
 * @param value - A code string, or a value carrying a `code` field.
 * @returns The non-empty code, or `undefined` when there is none.
 */
function codeTextOf(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value.length > 0 ? value : undefined;
	}
	return failureCodeOf(value);
}

/**
 * The stable failure code a thrown value carries, when it carries one.
 * @param value - Whatever a call threw (a host `LlmError`, this plugin's own failure, anything else).
 * @returns The non-empty code, or `undefined` when there is none to classify on.
 */
export function failureCodeOf(value: unknown): string | undefined {
	const code = (value as { code?: unknown } | null | undefined)?.code;
	return typeof code === "string" && code.length > 0 ? code : undefined;
}

/**
 * Whether a failure refuses the route rather than blipping on it.
 * @param error - Whatever a call threw.
 * @returns True when the route itself is unavailable (halt), false when a retry may help.
 */
export function isRouteRejected(error: unknown): boolean {
	const code = error instanceof SubagentCallError ? error.code : failureCodeOf(error);
	return isRouteRejectedCode(code);
}

/**
 * The same verdict for a code that already travelled (a run's reported fault).
 * @param code - The host's failure code, when the failure carried one.
 * @returns True when the route itself is unavailable (halt), false when a retry may help.
 */
export function isRouteRejectedCode(code: string | undefined): boolean {
	return code !== undefined && TERMINAL_ROUTE_CODES.has(code);
}

/**
 * The usage a failed call had already observed, for the ledger.
 *
 * @param error - Whatever a call threw.
 * @returns The observed usage payload, or `undefined` when the failure carries none.
 */
export function observedUsageOf(error: unknown): unknown {
	return error instanceof SubagentCallError ? error.usage : undefined;
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
 * @param fallbackMaxTokens - Output budget to use when the model advertises no cap of its own.
 * @returns The assembled text, usage, finish kind, and chosen effort.
 * @throws On a missing LLM service, capability lookup failure, terminal provider error or abort, and empty output.
 */
export async function streamOnce(
	llm: LlmRuntime | undefined,
	route: ModelSelection,
	sessionId: string | undefined,
	system: string,
	prompt: string,
	fallbackMaxTokens: number,
): Promise<StreamOnceResult> {
	if (llm === undefined) {
		throw new Error("no llm route");
	}
	const dials = await resolveDials(llm, route, fallbackMaxTokens);
	let text = "";
	let usage: unknown;
	let finish: { kind?: string; failure?: unknown } | undefined;
	try {
		for await (const chunk of llm.stream({
			provider: route.provider,
			model: route.model,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
			system,
			maxTokens: dials.maxTokens,
			sessionId,
			...(dials.reasoningEffort === undefined ? {} : { reasoningEffort: dials.reasoningEffort }),
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
	} catch (error) {
		// A provider that dies mid-stream still reported what it spent: the
		// observation survives the failure so the ledger can show it.
		throw new SubagentCallError(failureHeadOf(error), { usage, finish: finish?.kind, route, code: failureCodeOf(error), cause: error });
	}
	const finishKind = finish?.kind;
	if (finishKind === "error" || finishKind === "aborted") {
		throw new SubagentCallError(failureTextOf(finishKind, finish?.failure), {
			usage,
			finish: finishKind,
			route,
			code: failureCodeOf(finish?.failure),
		});
	}
	if (text.trim().length === 0) {
		// Nothing usable arrived: the finish reason is the only diagnosis.
		throw new SubagentCallError(
			finishKind !== undefined && finishKind !== "stop" ? `stream finished with ${finishKind}` : "empty model output",
			{ usage, finish: finishKind, route },
		);
	}
	return { text, usage, finish: finishKind, reasoningEffort: dials.reasoningEffort };
}

/** One-line head of a mid-stream throw, flattened so the ledger row stays greppable. */
function failureHeadOf(error: unknown): string {
	const message = error instanceof Error && error.message.length > 0 ? error.message : String(error);
	return message.replace(/\s+/g, " ").trim();
}

/** The two capability-derived dials one call sends. */
interface CallDials {
	reasoningEffort: string | undefined;
	maxTokens: number;
}

/**
 * Resolve both dials from one capability query.
 *
 * The host's capability query is the only source: an explicit selection's
 * effort belongs to the *main* conversation and must not silently raise an
 * auxiliary call's cost, and an explicit `maxTokens` belongs to nothing here.
 * No query (older host, test fake) means no effort and the caller's budget.
 */
async function resolveDials(llm: LlmRuntime, route: ModelSelection, fallbackMaxTokens: number): Promise<CallDials> {
	if (typeof llm.resolveModelInfo !== "function") {
		return { reasoningEffort: undefined, maxTokens: fallbackMaxTokens };
	}
	const modelInfo = await llm.resolveModelInfo(route.provider, route.model);
	return {
		reasoningEffort: selectLowestReasoningEffort(modelInfo),
		maxTokens: selectMaxTokens(modelInfo, fallbackMaxTokens),
	};
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
