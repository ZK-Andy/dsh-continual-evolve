/**
 * Secret screening: fixed detection patterns plus the first-match reason.
 * Lives in the data layer so every screener (write gates in `services/*`,
 * quarantine in `./review-accounts.js`) depends downward on it — never the
 * reverse. A security invariant, deliberately NOT configurable: a user
 * pattern typo must never be able to disable secret screening.
 */

/**
 * Fixed secret-detection patterns. Patterns carried over verbatim from the
 * v1 promotion gate (ADR `2026-08-28-secret-leak-guard`), tuned for low
 * false positives — placeholders like "YOUR_API_KEY_HERE" don't match;
 * realistic mixed literals do.
 */
const SECRET_PATTERNS: readonly { label: string; regex: RegExp }[] = [
	{ label: "AnySearch API key", regex: /\bas_sk_[A-Za-z0-9]{8,}\b/ },
	{ label: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/ },
	{ label: "OpenAI-style API key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/ },
	{ label: "GitHub token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
	{ label: "GitHub fine-grained PAT", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
	{ label: "AWS access key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ label: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ label: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
	{ label: "npm grant token", regex: /\bnpm_[A-Za-z0-9]{36}\b/ },
	{ label: "private key block", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
	{
		label: "credential assignment",
		// The credential-name group is manually case-insensitive ("apiKey" in
		// JSON, "API_KEY" in env examples) so the placeholder lookahead stays
		// case-sensitive: it excludes only ALL-CAPS placeholders
		// ("YOUR_KEY_HERE"), not real mixed/lowercase literals.
		regex: /\b(?:[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Dd]|[Pp][Ww][Dd])\b["']?\s*[:=]\s*["'](?!["']*[A-Z0-9_]+["'])[A-Za-z0-9+/_-]{16,}["']/,
	},
];

/** Redact a matched secret for error/audit surfaces: family, never the value. */
function redactSecret(matched: string): string {
	if (matched.length <= 10) {
		return `${matched.slice(0, 3)}…`;
	}
	return `${matched.slice(0, 6)}…${matched.slice(-3)}`;
}

/**
 * First reason the content reads as carrying a live credential, or undefined
 * when it screens clean. Applied to the whole proposed record (title +
 * description + body) at write time, and again by patrol over stored rows.
 * @param content - The text to screen.
 * @returns The blocking reason, undefined when clean.
 */
export function secretLeakReason(content: string): string | undefined {
	for (const { label, regex } of SECRET_PATTERNS) {
		const match = regex.exec(content);
		if (match?.[0]) {
			return `possible ${label} ("${redactSecret(match[0])}") — secrets must never be sedimented into the memory store; rotate the credential and keep it out of the store`;
		}
	}
	return undefined;
}

/**
 * Mask every live-credential match in stored text (P5 `eval_cases` replies):
 * same patterns as detection, but masking instead of blocking — eval rows
 * must stay replayable, so a key blocks nothing and lands masked as
 * `[redacted-<label>]`. Masking is one-way (audit reads masked text).
 * The module patterns carry no `g` flag (detection reads the first match),
 * so each is re-compiled with `g` here.
 * @param content - The text to mask.
 * @returns The text with every secret match masked.
 */
export function redactText(content: string): string {
	let masked = content;
	for (const { label, regex } of SECRET_PATTERNS) {
		masked = masked.replace(new RegExp(regex.source, "g"), `[redacted-${label}]`);
	}
	return masked;
}
