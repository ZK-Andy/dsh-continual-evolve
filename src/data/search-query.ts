/**
 * Query vocabulary for keyword search: tokenizing, CJK trigram
 * alternatives, and LIKE escaping. Pure functions shared by every kind
 * repository — one home so FTS and LIKE can never disagree on a token.
 */

/** Quote one token as an FTS5 phrase (trigram needs ≥3 chars to match). */
export function ftsPhrase(token: string): string {
	return `"${token.replaceAll('"', '""')}"`;
}

/**
 * Split a query into keyword tokens on ASCII or full-width whitespace. Each
 * token is matched on its own and AND-combined: trigram FTS can only match
 * ≥3-char runs, so a keyword pair like `中文 交接` is unrepresentable as one
 * FTS phrase and silently returns nothing under a phrase match.
 */
export function queryTokens(query: string): string[] {
	return query.split(/[\s\u3000]+/).filter((token) => token.length > 0);
}

/** Whether a string contains any CJK code point. */
function hasCjk(text: string): boolean {
	for (const char of text) {
		const cp = char.codePointAt(0) ?? 0;
		if ((cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef)) {
			return true;
		}
	}
	return false;
}

/**
 * Expand one query token into match alternatives. A CJK run longer than three
 * characters is a sentence fragment, not a keyword: requiring the whole run
 * ("什么时候可以") finds nothing in a title that says "发版前必须 CI 全绿",
 * while each trigram window is a usable key. Windows are OR-ed within the
 * token and tokens stay AND-combined, so precision is bounded by the tokens the
 * caller typed (ADR `2026-10-18-absorb-memory-plugin-strengths`, finding F8).
 */
export function searchAlternatives(token: string): string[] {
	if (token.length <= 3 || !hasCjk(token)) {
		return [token];
	}
	const windows: string[] = [];
	for (let index = 0; index + 3 <= token.length; index += 1) {
		windows.push(token.slice(index, index + 3));
	}
	return [...new Set(windows)];
}

/** `%token%` with LIKE metacharacters escaped — keywords match literally. */
export function likePattern(token: string): string {
	return `%${token.replaceAll(/[\\%_]/g, "\\$&")}%`;
}
