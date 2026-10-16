/**
 * The single accounting entry for direct LLM calls (the `token-usage.ts`
 * the coding standard names). Observed provider payloads disagree on keys —
 * `inputTokens`/`outputTokens` are usual, `totalTokens`, `cacheReadTokens`,
 * `cacheWriteTokens`, and `reasoningTokens` come and go — so every call site
 * normalizes through {@link normalizeUsage} and aggregates with
 * {@link sumUsage}. Nothing here touches the store: per-day aggregation over
 * ledger rows lives in the review daily rollup, which stays read-only and
 * bounded (one row per day).
 */

/** Token counts for one LLM call, every field present, zeros when unknown. */
export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	total: number;
}

/** The zero value: no signal, not a failure. */
export function zeroUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Normalize one provider usage payload to full totals. Returns `null` when
 * the payload carries no usable numeric signal at all (not an object, or an
 * object with no recognized numeric field) — callers treat that as "no
 * accounting for this run", never as zeros that would dilute real totals.
 */
export function normalizeUsage(raw: unknown): UsageTotals | null {
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const payload = raw as Record<string, unknown>;
	const input = num(payload.inputTokens);
	const output = num(payload.outputTokens);
	const cacheRead = num(payload.cacheReadTokens);
	const cacheWrite = num(payload.cacheWriteTokens);
	const reasoning = num(payload.reasoningTokens);
	const recognized = [input, output, cacheRead, cacheWrite, reasoning].some((n) => n > 0);
	const totalRaw = num(payload.totalTokens);
	if (!recognized && totalRaw === 0) {
		return null;
	}
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		reasoning,
		total: totalRaw > 0 ? totalRaw : input + output,
	};
}

/** Pure field-wise sum; either side may be a zero value. */
export function sumUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		reasoning: a.reasoning + b.reasoning,
		total: a.total + b.total,
	};
}
