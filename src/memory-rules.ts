/**
 * The mechanical write gates every memory passes before the store accepts it
 * — the "模型提议，代码保证" boundary made literal. Both write paths (the
 * explicit `memory_write` tool and the proposal-based extraction) funnel
 * through these checks; nothing reaches the database without them.
 *
 * Type taxonomy and the boundary judgment (what deserves a memory at all)
 * live in the extraction prompt (`memory-guide.ts`); this module only holds
 * what code can decide without judgment: enumerations, sizes, id shape, the
 * feedback body contract, and secret screening.
 */
import { createHash } from "node:crypto";

/** Memory types a record can carry (the guide's taxonomy, enforced). */
export const MEMORY_TYPES = ["user", "feedback", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Record lifecycle statuses. `quarantined` is set by patrol, never shown. */
export const MEMORY_STATUSES = ["active", "quarantined", "archived"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** Hard body size cap: the one unbounded-growth entry point, killed at write. */
export const MEMORY_BODY_LIMIT = 65_536;
/** Sanity caps for the injection-facing fields (hook text, not prose). */
export const MEMORY_TITLE_LIMIT = 200;
export const MEMORY_DESCRIPTION_LIMIT = 500;

/** Kebab-slug id shape: lowercase alphanumerics joined by single dashes. */
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Full id bound (slug + hash-fallback suffix headroom). */
export const MEMORY_ID_LIMIT = 80;

/**
 * Fixed secret-detection patterns — a security invariant, deliberately NOT
 * configurable: a user pattern typo must never be able to disable secret
 * screening. Patterns carried over verbatim from the v1 promotion gate
 * (ADR `2026-08-28-secret-leak-guard`), tuned for low false positives —
 * placeholders like "YOUR_API_KEY_HERE" don't match; realistic mixed
 * literals do.
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
 * Derive a kebab-slug id from a title. CJK (or any non-ASCII-only) titles
 * produce an empty slug, so a short sha1 hash stands in — same fallback the
 * v1 store used (ADR `2026-09-25-cjk-slug-hash-fallback`).
 */
export function slugifyId(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MEMORY_ID_LIMIT)
		.replace(/-+$/g, "");
	if (slug.length > 0) {
		return slug;
	}
	return `m-${createHash("sha1").update(title).digest("hex").slice(0, 8)}`;
}

/** Whether `id` is a well-formed store id. */
export function isValidMemoryId(id: string): boolean {
	return id.length <= MEMORY_ID_LIMIT && ID_PATTERN.test(id);
}

/** The feedback body contract: rule first, then **Why:** and **How to apply:**. */
const FEEDBACK_WHY = /(?:\*\*)?Why:(?:\*\*)?/i;
const FEEDBACK_HOW = /(?:\*\*)?How to apply:(?:\*\*)?/i;

/** Labels of the feedback body lines that are missing, empty string when complete. */
export function feedbackWhyHowMissing(body: string): string {
	const missing: string[] = [];
	if (!FEEDBACK_WHY.test(body)) {
		missing.push("Why:");
	}
	if (!FEEDBACK_HOW.test(body)) {
		missing.push("How to apply:");
	}
	return missing.join("、");
}

/** One proposed mutation — the closed proposal shape both write paths speak. */
export interface MemoryProposal {
	action: "create" | "update" | "delete";
	/** Required for update/delete; optional for create (derived from title). */
	id?: string | undefined;
	type?: string | undefined;
	title?: string | undefined;
	description?: string | undefined;
	body?: string | undefined;
	/** Trajectory provenance for extraction writes ("820-831"). */
	sourceSeqs?: string | undefined;
}

/** The merged field values a create/update would write (delete checks none). */
export interface ProposedFields {
	type: MemoryType;
	title: string;
	description: string;
	body: string;
}

/**
 * Gates that depend only on the merged field values (not on store state).
 * Returns the blocking reasons, empty when the record would pass. Runs the
 * secret screen over the full visible text so a secret smuggled into any
 * field blocks the write.
 */
export function fieldGateReasons(fields: ProposedFields): string[] {
	const reasons: string[] = [];
	if (!MEMORY_TYPES.includes(fields.type)) {
		reasons.push(`type must be one of ${MEMORY_TYPES.join("/")}`);
	}
	if (fields.title.trim().length === 0) {
		reasons.push("title must not be empty");
	} else if (fields.title.length > MEMORY_TITLE_LIMIT) {
		reasons.push(`title exceeds ${MEMORY_TITLE_LIMIT} characters`);
	}
	if (fields.description.trim().length === 0) {
		reasons.push("description must not be empty — it is the injection hook");
	} else if (fields.description.length > MEMORY_DESCRIPTION_LIMIT) {
		reasons.push(`description exceeds ${MEMORY_DESCRIPTION_LIMIT} characters`);
	}
	if (fields.body.trim().length === 0) {
		reasons.push("body must not be empty");
	} else if (fields.body.length > MEMORY_BODY_LIMIT) {
		reasons.push(`body exceeds the ${MEMORY_BODY_LIMIT}-character cap`);
	}
	if (fields.type === "feedback") {
		const missing = feedbackWhyHowMissing(fields.body);
		if (missing.length > 0) {
			reasons.push(`feedback body must carry the ${missing} lines`);
		}
	}
	const leak = secretLeakReason(`${fields.title}\n${fields.description}\n${fields.body}`);
	if (leak !== undefined) {
		reasons.push(leak);
	}
	return reasons;
}
