/**
 * Token budgeting for the injected index (`docs/architecture-standard.md` §2
 * budgets, ADR `2026-10-18-absorb-memory-plugin-strengths`).
 *
 * The injected index used to be capped in *characters*, while every surface
 * (README, card, this repo's own docs) described the cap in tokens. Chinese
 * costs roughly 1.5 tokens per character, so a 6000-character cap silently
 * shipped ~7000–9000 tokens. The budget is now tokens, estimated here — one
 * pure function, no dependencies, no state.
 *
 * The estimate is deliberately coarse: it decides what fits, and the model's
 * tokenizer is not available in this process. CJK-dense text is priced at 1.5
 * tokens/character, everything else at 4 characters/token.
 */

/** Tokens per CJK character (conservative for zh/ja/ko mixed indexes). */
const CJK_TOKENS_PER_CHAR = 1.5;
/** Characters per token for non-CJK text. */
const CHARS_PER_TOKEN = 4;

/** Whether a code point is priced at the CJK rate. */
function isCjk(codePoint: number): boolean {
	return (
		(codePoint >= 0x2e80 && codePoint <= 0x9fff) || // CJK radicals, kana, unified ideographs
		(codePoint >= 0xac00 && codePoint <= 0xd7af) || // Hangul syllables
		(codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compatibility ideographs
		(codePoint >= 0xff00 && codePoint <= 0xffef) // fullwidth forms
	);
}

/**
 * Estimate the token cost of one string.
 * @param text - The text to price.
 * @returns Estimated tokens, rounded up; `""` costs 0.
 */
export function estimateTokens(text: string): number {
	if (text === "") {
		return 0;
	}
	let cjk = 0;
	let other = 0;
	for (const char of text) {
		if (isCjk(char.codePointAt(0) ?? 0)) {
			cjk += 1;
		} else {
			other += 1;
		}
	}
	return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + other / CHARS_PER_TOKEN);
}

/** One index row offered to the tiered fit: the full line plus the id it names. */
export interface IndexRow {
	/** The memory id this row names (rendered alone in the id-only tier). */
	id: string;
	/** The full hook line (`- [id] title — description（type）`). */
	line: string;
}

/** What a tiered fit produced. */
export interface TieredFit {
	/** The rendered index text (full rows, then id-only rows, then the counter). */
	text: string;
	/** Estimated tokens of {@link text}. */
	tokens: number;
	/** Rows rendered in full. */
	fullCount: number;
	/** Rows rendered as ids only. */
	idOnlyCount: number;
	/** Rows neither rendered in full nor as ids (counted in the counter line). */
	omittedCount: number;
}

/** Id-only row shape; kept short so one budget unit still buys several ids. */
function idRow(id: string): string {
	return `- [${id}]`;
}

/** The counter line appended when rows were dropped entirely. */
function omittedLine(count: number): string {
	return `（其余 ${String(count)} 条未展开，用 \`evolve_read\` 关键词检索）`;
}

/**
 * Fit the index into a token budget in three tiers: full hook lines first, then
 * id-only rows, then a counter line naming what was dropped. Whole rows only —
 * a partial line would corrupt the line the model reads.
 *
 * @param rows - Index rows in display order (the store's own order).
 * @param maxTokens - The budget; `<= 0` renders nothing.
 * @returns The tiered fit with per-tier counts.
 */
export function fitTiered(rows: readonly IndexRow[], maxTokens: number): TieredFit {
	const budget = Math.max(0, maxTokens);
	if (budget === 0 || rows.length === 0) {
		return { text: "", tokens: 0, fullCount: 0, idOnlyCount: 0, omittedCount: rows.length };
	}
	const full: string[] = [];
	let used = 0;
	let index = 0;
	for (; index < rows.length; index += 1) {
		const row = rows[index] as IndexRow;
		const cost = estimateTokens(row.line) + 1; // + newline
		if (used + cost > budget) {
			break;
		}
		full.push(row.line);
		used += cost;
	}
	const ids: string[] = [];
	for (; index < rows.length; index += 1) {
		const row = rows[index] as IndexRow;
		const cost = estimateTokens(idRow(row.id)) + 1;
		if (used + cost > budget) {
			break;
		}
		ids.push(idRow(row.id));
		used += cost;
	}
	const omitted = rows.length - index;
	const parts = [...full, ...ids];
	if (parts.length === 0) {
		// Nothing could be named: the caller renders its own "not even one row" hint.
		return { text: "", tokens: 0, fullCount: 0, idOnlyCount: 0, omittedCount: rows.length };
	}
	if (omitted > 0) {
		// The counter line is charged outside the row budget, like the guide text:
		// a truncation the reader cannot see is worse than a coarse estimate.
		parts.push(omittedLine(omitted));
	}
	const text = parts.join("\n");
	return { text, tokens: estimateTokens(text), fullCount: full.length, idOnlyCount: ids.length, omittedCount: omitted };
}

/** Budget resolution inputs: the new key, the legacy key, and the migration marker. */
export interface IndexBudgetInput {
	/** `memoryIndex.maxTokens` when configured. */
	maxTokens?: number | undefined;
	/** `memoryIndex.maxChars` (legacy) when configured. */
	maxChars?: number | undefined;
	/** Whether the one-time legacy migration already ran for this profile. */
	migrated?: boolean | undefined;
}

/** The resolved budget, plus whether it came from the legacy key. */
export interface IndexBudget {
	tokens: number;
	/** True when the legacy character cap supplied the value (migration owed). */
	fromLegacy: boolean;
}

/** Default token budget for the injected index. */
export const DEFAULT_INDEX_MAX_TOKENS = 6000;

/**
 * Resolve the token budget from the live config, converting the legacy
 * character cap exactly once. Explicit `maxTokens` always wins; the legacy key
 * is read only until the migration marker says it has been consumed.
 *
 * @param input - The configured keys and the migration marker.
 * @returns The token budget and whether the legacy key was used.
 */
export function resolveIndexBudget(input: IndexBudgetInput): IndexBudget {
	if (typeof input.maxTokens === "number" && input.maxTokens > 0) {
		return { tokens: Math.floor(input.maxTokens), fromLegacy: false };
	}
	const legacy = input.maxChars;
	if (input.migrated !== true && typeof legacy === "number" && legacy > 0) {
		// A character cap bought ~1/1.5 of that in CJK tokens.
		return { tokens: Math.max(1, Math.floor(legacy / CJK_TOKENS_PER_CHAR)), fromLegacy: true };
	}
	return { tokens: DEFAULT_INDEX_MAX_TOKENS, fromLegacy: false };
}

/** State key marking that the legacy character cap has been consumed. */
export const INDEX_BUDGET_MIGRATION_KEY = "budget:index.migrated";

/** The slice of the store the budget resolution needs (structural, no import). */
export interface BudgetStoreLike {
	state(workspaceId: string, key: string): string | undefined;
	setState(workspaceId: string, key: string, value: string): void;
}

/**
 * Resolve the budget against the store's own migration marker, consuming the
 * legacy character cap exactly once. The first read that still sees the
 * legacy key records the migration; every later read ignores that key, so the
 * token budget is the single live source from then on.
 *
 * @param store - The open store, or undefined while it is loading.
 * @param input - The configured keys.
 * @param globalWorkspace - The partition that holds the marker (`""`).
 * @returns The token budget.
 */
export function resolveStoredBudget(
	store: BudgetStoreLike | undefined,
	input: IndexBudgetInput,
	globalWorkspace: string,
): IndexBudget {
	if (store === undefined) {
		return resolveIndexBudget({ maxTokens: input.maxTokens });
	}
	let migrated: boolean;
	try {
		migrated = store.state(globalWorkspace, INDEX_BUDGET_MIGRATION_KEY) !== undefined;
	} catch {
		migrated = false;
	}
	const resolved = resolveIndexBudget({ ...input, migrated });
	if (resolved.fromLegacy && !migrated) {
		try {
			store.setState(globalWorkspace, INDEX_BUDGET_MIGRATION_KEY, String(resolved.tokens));
		} catch {
			// A failed marker write only costs a second conversion on the next read.
		}
	}
	return resolved;
}
