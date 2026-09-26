/**
 * Record language resolution for evolution writes.
 *
 * Every durable record (refinement summary/rationale, entry title/content,
 * review and wrap-up verdicts) is generated prose. Its language is resolved
 * per call through one chain — never hardcoded at any single site:
 *
 * 1. explicit `recordLanguage` plugin config (`zh`|`en`; `auto` defers);
 * 2. the durable DSH client preference (`locale` namespace, `preference`
 *    field — the same source the desktop shell and the web GUI follow);
 * 3. detection over recent direct user text (Han-character signal);
 * 4. `en`, matching the DSH `FALLBACK_LOCALE`.
 *
 * The durable-preference read is intentionally fail-open: the settings
 * service is host-owned and its shape may drift, so any mismatch yields
 * `undefined` and the chain moves on instead of breaking the evolution run.
 */

/** Natural languages evolution records are authored in. */
export type RecordLanguage = "zh" | "en";

/** Plugin-facing preference: an explicit language or deferral to detection. */
export type RecordLanguagePreference = "auto" | RecordLanguage;

/**
 * Upstream durable-settings address reused verbatim
 * (`@deepseek-ai/dsh-client-locale`: `LOCALE_SETTINGS_NAMESPACE`,
 * `LOCALE_PREFERENCE_FIELD`). New keys are never invented here.
 */
export const DSH_LOCALE_NAMESPACE = "locale";
export const DSH_LOCALE_PREFERENCE_FIELD = "preference";

/** Han ideographs — the detection signal for Chinese user text. */
const HAN_PATTERN = /[\u4e00-\u9fff]/g;
/** Minimum Han hits to count as signal (stray characters must not flip). */
const HAN_SIGNAL_MIN = 5;
/** Detection scans a bounded prefix; trajectories are long and the signal is dense. */
const DETECT_SCAN_CHARS = 4000;

/**
 * Detect Chinese from user text by Han-character density.
 *
 * @param text Arbitrary user-supplied text.
 * @returns `"zh"` on sufficient Han signal, otherwise `undefined` (no
 *          signal — never a default; the resolver owns the fallback).
 */
export function detectLanguageFromText(text: string): RecordLanguage | undefined {
	const hits = (text.slice(0, DETECT_SCAN_CHARS).match(HAN_PATTERN) ?? []).length;
	return hits >= HAN_SIGNAL_MIN ? "zh" : undefined;
}

/**
 * Read the durable DSH client language preference through the host settings
 * service. Fail-open by contract: a missing service, a throwing read, an
 * async-shaped reply, or an unknown value all yield `undefined`.
 *
 * @param ctx Cordis context that may carry the host settings service.
 * @returns The stored preference (`zh`/`en`, subtag-tolerant) or `undefined`.
 */
export function durableLocalePreference(ctx: unknown): string | undefined {
	if (typeof ctx !== "object" || ctx === null) return undefined;
	const settings = (ctx as { settings?: unknown }).settings;
	if (typeof settings !== "object" || settings === null) return undefined;
	const describe = (settings as { describe?: unknown }).describe;
	if (typeof describe !== "function") return undefined;
	let rows: unknown;
	try {
		rows = (describe as (options?: unknown) => unknown)({ redactSecrets: true });
	} catch {
		return undefined;
	}
	if (!Array.isArray(rows)) return undefined;
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const record = row as Record<string, unknown>;
		if (record["ns"] !== DSH_LOCALE_NAMESPACE) continue;
		const value = record["value"];
		if (typeof value !== "object" || value === null) return undefined;
		const preference = (value as Record<string, unknown>)[DSH_LOCALE_PREFERENCE_FIELD];
		if (typeof preference !== "string") return undefined;
		const id = preference.toLowerCase();
		if (id === "zh" || id.startsWith("zh-")) return "zh";
		if (id === "en" || id.startsWith("en-")) return "en";
		return undefined;
	}
	return undefined;
}

/**
 * Normalize an explicit preference or durable value to a record language.
 *
 * @param value Candidate language id (config or durable preference).
 * @returns `"zh"`/`"en"` on a recognized id, otherwise `undefined`.
 */
export function normalizeRecordLanguage(value: string | undefined): RecordLanguage | undefined {
	if (value === "zh" || value === "en") return value;
	return undefined;
}

export interface ResolveRecordLanguageInput {
	/** Explicit plugin config; absent/`auto` defers to the chain below. */
	configured?: RecordLanguagePreference | undefined;
	/** Host context for the durable-preference read; absent skips that tier. */
	ctx?: unknown;
	/** Recent direct user text for the detection tier; absent skips it. */
	trajectoryText?: string;
}

/**
 * Resolve the authoring language for one evolution write.
 *
 * @param input Configured preference, host context, and trajectory sample.
 * @returns The winning language; always defined (`en` is the final fallback).
 */
export function resolveRecordLanguage(input: ResolveRecordLanguageInput): RecordLanguage {
	const configured = normalizeRecordLanguage(input.configured === "auto" ? undefined : input.configured);
	if (configured !== undefined) return configured;
	if (input.ctx !== undefined) {
		const durable = normalizeRecordLanguage(durableLocalePreference(input.ctx));
		if (durable !== undefined) return durable;
	}
	if (input.trajectoryText !== undefined) {
		const detected = detectLanguageFromText(input.trajectoryText);
		if (detected !== undefined) return detected;
	}
	return "en";
}

/**
 * The one-line prompt addendum appended to every record-authoring system
 * prompt. Machine contracts (JSON keys, ids, paths, code) stay untouched —
 * only natural-language values follow the resolved language.
 *
 * @param lang Resolved record language.
 * @returns The instruction line for `lang`.
 */
export function recordLanguageInstruction(lang: RecordLanguage): string {
	return lang === "zh"
		? "记录语言：用简体中文写所有的自然语言值（title、content、summary、rationale、reason、expectedOutcome）。JSON 键名、id、path 与代码片段保持原样。"
		: "Record language: write all natural-language values (title, content, summary, rationale, reason, expectedOutcome) in English. Keep JSON keys, ids, paths, and code snippets unchanged.";
}
