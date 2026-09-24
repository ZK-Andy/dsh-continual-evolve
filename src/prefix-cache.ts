/**
 * Prefix-cache-aware planning input routing (Route A/B).
 *
 * The planner and the review gate re-send session context on every call as
 * flat text. On providers with prompt caching that context is re-billed at
 * full price each time. Route A instead prepends session-derived messages —
 * the same evidence in structured form, eligible for cache-read pricing —
 * and drops the redundant flat trajectory block. Route B keeps the legacy
 * flat-text input byte-for-byte.
 *
 * Adapted from dsh-continual-harness (Route A/B + cache-detect): this port
 * deliberately does NOT reproduce the host loop's byte-identical cache key
 * (no deriveMessages/tools/sessionId plumbing on this seam), so a hit needs
 * a provider that keys on the message-prefix content. Sources are stamped
 * honestly and every reduction is documented below.
 */
import { createAssistantMessage, createUserMessage, type AssistantMessage, type UserMessage } from "@deepseek-ai/dsh-llm";

/** Planning input shape: A = session-derived message prefix, B = flat-text trajectory. */
export type PlannerRoute = "A" | "B";

/** Routing mode: auto-detect from cache evidence, always prefix, or never. */
export type PlannerPrefixCacheMode = "auto" | "session" | "off";

/** Per-call routing overrides; absent fields fall back to the resolved defaults. */
export interface PrefixCacheOptions {
	mode?: PlannerPrefixCacheMode;
	maxChars?: number;
}

/** Default session-prefix budget for one Route A input, in characters. */
export const DEFAULT_PREFIX_MAX_CHARS = 12000;

/** Loose session-event shape (duck-typed: the log reader degrades across harness generations). */
interface SessionEventLike {
	type?: unknown;
	data?: {
		content?: unknown;
		source?: { kind?: unknown };
		usage?: { cacheReadTokens?: unknown };
	};
}

/**
 * Resolve per-call overrides against the defaults.
 *
 * @param opts - sparse per-call overrides.
 * @returns the effective mode (default "auto") and char budget.
 * @throws When maxChars is present but not a positive safe integer (fail loud on misconfiguration).
 */
export function resolvePrefixCache(opts?: PrefixCacheOptions): { mode: PlannerPrefixCacheMode; maxChars: number } {
	const mode = opts?.mode ?? "auto";
	const maxChars = opts?.maxChars ?? DEFAULT_PREFIX_MAX_CHARS;
	if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
		throw new Error(`evolve: prefix-cache maxChars must be a positive integer, got ${String(opts?.maxChars)}`);
	}
	return { mode, maxChars };
}

/**
 * True when any assistant message in this session reported cache-read
 * tokens — evidence the provider can serve a warm prefix.
 *
 * @param events - session log rows, newest last.
 * @returns whether cache evidence exists (false on an empty/unreadable log).
 */
export function hasCacheEvidence(events: readonly unknown[]): boolean {
	for (const raw of events) {
		if (typeof raw !== "object" || raw === null) continue;
		const event = raw as SessionEventLike;
		if (event.type !== "assistant/message") continue;
		const read = event.data?.usage?.cacheReadTokens;
		if (typeof read === "number" && read > 0) return true;
	}
	return false;
}

/**
 * Pick the planning input route for one call.
 *
 * @param events - session log rows, newest last.
 * @param mode - routing mode (default "auto").
 * @returns "A" when the session prefix should carry the context, else "B".
 */
export function detectPlannerRoute(events: readonly unknown[], mode?: PlannerPrefixCacheMode): PlannerRoute {
	const resolved = mode ?? "auto";
	if (resolved === "session") return "A";
	if (resolved === "off") return "B";
	return hasCacheEvidence(events) ? "A" : "B";
}

/**
 * Extract one message's text without depending on the dsh-llm ContentBlock
 * type: string blocks pass through, object blocks contribute their `text`
 * field when present. Non-text blocks (tool calls, images) are dropped.
 */
function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
		} else if (block !== null && typeof block === "object" && "text" in block && typeof (block as { text?: unknown }).text === "string") {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.filter((text) => text.length > 0).join(" ");
}

/**
 * Rebuild a tail-biased session prefix from the event log.
 *
 * Inclusion mirrors the trajectory grounding (only direct human `user`
 * speech plus the model's own assistant text), so injected plugin context
 * and tool results never echo back into the planning input. Whole messages
 * are dropped oldest-first over budget; a single over-budget message keeps
 * its tail.
 *
 * @param events - session log rows, newest last.
 * @param opts - provider/model stamps the assistant messages (the calling
 * agent's own route); maxChars caps the prefix (default {@link DEFAULT_PREFIX_MAX_CHARS}).
 * @returns the prefix messages, oldest first ([] when nothing qualifies —
 * callers fall back to Route B).
 * @throws When assistant text exists but provider/model is missing (an
 * assistant message cannot be honestly stamped without its route).
 */
export function buildPrefixMessages(
	events: readonly unknown[],
	opts: { provider?: string; model?: string; maxChars?: number },
): (UserMessage | AssistantMessage)[] {
	const maxChars = opts.maxChars ?? DEFAULT_PREFIX_MAX_CHARS;
	if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
		throw new Error(`evolve: prefix-cache maxChars must be a positive integer, got ${String(opts.maxChars)}`);
	}
	const pairs: { role: "user" | "assistant"; text: string }[] = [];
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const raw = events[i];
		if (typeof raw !== "object" || raw === null) continue;
		const event = raw as SessionEventLike;
		const isUser = event.type === "user/message";
		const isAssistant = event.type === "assistant/message";
		if (!isUser && !isAssistant) continue;
		if (isUser) {
			const kind = event.data?.source?.kind;
			if (kind !== undefined && kind !== "user") continue;
		}
		const text = blockText(event.data?.content).trim();
		if (text.length === 0) continue;
		pairs.push({ role: isUser ? "user" : "assistant", text });
	}
	if (pairs.length === 0) return [];
	// Collected newest-first; restore conversation order before budgeting.
	pairs.reverse();
	// Tail-biased budget: drop oldest whole messages over budget; a lone
	// over-budget message keeps its tail.
	let total = pairs.reduce((sum, pair) => sum + pair.text.length, 0);
	while (pairs.length > 1 && total > maxChars) {
		const dropped = pairs.shift();
		total -= dropped?.text.length ?? 0;
	}
	const oldest = pairs[0];
	if (oldest !== undefined && total > maxChars) {
		oldest.text = oldest.text.slice(-maxChars);
	}
	const messages: (UserMessage | AssistantMessage)[] = [];
	for (const pair of pairs) {
		if (pair.role === "user") {
			messages.push(
				createUserMessage({
					source: { kind: "user" },
					content: [{ type: "text" as const, text: pair.text }],
				}),
			);
		} else {
			if (!opts.provider || !opts.model) {
				throw new Error("evolve: prefix-cache needs the agent provider/model to stamp assistant messages");
			}
			messages.push(
				createAssistantMessage({
					source: { provider: opts.provider, model: opts.model },
					content: [{ type: "text" as const, text: pair.text }],
				}),
			);
		}
	}
	return messages;
}
