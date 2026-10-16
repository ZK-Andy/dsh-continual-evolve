/**
 * The generic subagent and its loader: the only path from plugin feature code
 * to an LLM call.
 *
 * A subagent is data — a strategy holding its identity, system prompt, output
 * budget fallback and answer parser. The loader binds that strategy to one
 * route and session, then runs it through one fixed skeleton (the template
 * method): assemble the call, stream it, parse the answer, account for what
 * happened. Failure accounting rides the same skeleton as success: the route
 * and the usage a stream reported before it died come back on the thrown
 * error, so a failed call can be audited exactly like a successful one.
 *
 * The structure is the point. "Which subagents exist and what each one is
 * told" is readable in one table (`subagent-defs.ts`) instead of being spread
 * across call sites, and a job that has no definition cannot be called.
 */
import { SubagentCallError, streamOnce, type LlmRuntime } from "./llm-call.js";
import type { ModelSelection } from "./model-route.js";

/** The per-call facts a definition's instruction may be built from. */
export interface SubagentContext {
	/** The run's baseline day `YYYY-MM-DD` (UTC) — the clock time-relative judgments use. */
	readonly today: string;
}

/** One subagent definition: everything that distinguishes one job from another. */
export interface SubagentDefinition<Answer> {
	/** The job's name, for diagnostics; unique across the registry (asserted by test). */
	readonly id: string;
	/**
	 * The job's entire instruction, sent as the system prompt — nothing is
	 * appended at the call site. The builder form is for jobs whose
	 * instruction depends on a per-call fact (the clock a rubric judges dates
	 * against); the loader resolves it once per call.
	 */
	readonly system: string | ((context: SubagentContext) => string);
	/** Output budget fallback; the exact model's advertised cap wins when it has one. */
	readonly maxTokens: number;
	/**
	 * Parse the answer text into this definition's answer type. A parser that
	 * can miss (`parseGateAnswer`, `parseCheapAnswer` …) includes `null` in its
	 * answer type: "no answer in the agreed shape" is a value, not a throw.
	 */
	readonly parse: (text: string) => Answer;
}

/** What one call is bound to: the LLM service, the exact route, the session identity, the day. */
export interface SubagentCall {
	llm: LlmRuntime | undefined;
	route: ModelSelection;
	sessionId: string | undefined;
	/** The run's baseline day `YYYY-MM-DD` (UTC): the clock every instruction is anchored to. */
	today: string;
}

/** One finished call: the parsed answer, the raw text, and the observed call facts. */
export interface SubagentAnswer<Answer> {
	answer: Answer;
	text: string;
	/** The provider's usage payload, exactly as observed; `undefined` when it reported none. */
	usage: unknown;
	/** The terminal finish kind (`stop`, `max-tokens`, …); `undefined` when the stream omitted it. */
	finish: string | undefined;
}

/** The loader feature code holds: bound to one route/session, it runs definitions. */
export interface SubagentLoader {
	/**
	 * Run one definition once.
	 *
	 * @param definition - The subagent strategy to run.
	 * @param prompt - This call's user prompt.
	 * @returns The parsed answer plus the observed usage and finish kind.
	 * @throws On call failures (a `SubagentCallError` carries the observed usage and route) or a missing route.
	 */
	run<Answer>(definition: SubagentDefinition<Answer>, prompt: string): Promise<SubagentAnswer<Answer>>;
}

/**
 * Build the loader for one call context — the simple factory: the context
 * produces the bound runner, the definitions table produces the strategies.
 *
 * @param call - The LLM service, the exact route, the session identity, and the baseline day to send.
 * @returns A loader whose `run` is the only LLM entry point a feature needs.
 */
export function subagentLoaderFor(call: SubagentCall): SubagentLoader {
	return {
		async run<Answer>(definition: SubagentDefinition<Answer>, prompt: string): Promise<SubagentAnswer<Answer>> {
			const system = typeof definition.system === "function" ? definition.system({ today: call.today }) : definition.system;
			const result = await streamOnce(call.llm, call.route, call.sessionId, system, prompt, definition.maxTokens);
			return { answer: definition.parse(result.text), text: result.text, usage: result.usage, finish: result.finish };
		},
	};
}

/**
 * Reject one answer as a failed call because the stream was cut.
 *
 * A cut answer is unusable by design — a half-written body must never become a
 * verdict, and a gate that produced no verdict is not an approval. The error
 * carries the facts the call already reported, so the failure is accounted
 * exactly like a transport failure instead of vanishing.
 *
 * @param answer - The cut answer.
 * @param route - The route it ran on.
 * @returns The error to throw.
 */
export function cutFailureOf<Answer>(answer: SubagentAnswer<Answer>, route: ModelSelection): SubagentCallError {
	return new SubagentCallError(`stream finished with ${answer.finish ?? "unknown"}`, {
		usage: answer.usage,
		finish: answer.finish,
		route,
	});
}
