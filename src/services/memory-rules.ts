/**
 * The mechanical write gates every memory passes before the store accepts it
 * — the "模型提议，代码保证" boundary made literal. Both write paths (the
 * explicit `evolve_write` tool and the proposal-based extraction) funnel
 * through these checks; nothing reaches the database without them.
 *
 * Type taxonomy and the boundary judgment (what deserves a memory at all)
 * live in the extraction prompt (`memory-guide.ts`); this module only holds
 * what code can decide without judgment: enumerations, sizes, id shape, and
 * the feedback body contract (secret screening lives in `../data/secret.js`).
 */
import { createHash } from "node:crypto";
import { secretLeakReason } from "../data/secret.js";

// Re-exported so existing importers keep working; the logic lives in
// `../data/secret.js` (data layer owns screening, services depend on it).
export { secretLeakReason };

/** Memory types a record can carry (the guide's taxonomy, enforced). */
export const MEMORY_TYPES = ["user", "feedback", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * Where a memory's knowledge belongs (`2026-10-13-memory-tiering-and-promotion`):
 * `project` is the default (this workspace's facts), `person` marks a row the
 * extraction or review judged to be about the user or their machine — the
 * promotion candidate that may later move to the global partition. A row's
 * scope is a proposal, never a placement: it still lives in its source
 * partition until a promotion transaction moves it.
 */
export const MEMORY_SCOPES = ["project", "person"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

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

/**
 * Shared single-field gate: empty check, then length cap, with
 * caller-supplied messages — each kind phrases its own contract, the shape
 * stays in one place. Returns the blocking reason, undefined when passing.
 */
export function textFieldGate(value: string, emptyReason: string, limit: number, limitReason: string): string | undefined {
	if (value.trim().length === 0) {
		return emptyReason;
	}
	if (value.length > limit) {
		return limitReason;
	}
	return undefined;
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
	/**
	 * Optional id of the same-workspace memory this proposal corrects or
	 * supersedes. The gate requires the target to exist and be active and
	 * forbids self-links; the link persists on the row for future
	 * correction-chasing. Append/replace only — no unlink path.
	 */
	corrects?: string | undefined;
	/**
	 * Where the fact belongs. Omitted means "unchanged" on update and
	 * `project` on create; `person` only marks a promotion candidate and
	 * changes nothing about where the row lives.
	 */
	scope?: string | undefined;
}

/** The merged field values a create/update would write (delete checks none). */
export interface ProposedFields {
	type: MemoryType;
	title: string;
	description: string;
	body: string;
	/** The row's layer marker (`project` / `person`). */
	scope: MemoryScope;
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
	if (!MEMORY_SCOPES.includes(fields.scope)) {
		reasons.push(`scope must be one of ${MEMORY_SCOPES.join("/")}`);
	}
	for (const reason of [
		textFieldGate(fields.title, "title must not be empty", MEMORY_TITLE_LIMIT, `title exceeds ${MEMORY_TITLE_LIMIT} characters`),
		textFieldGate(
			fields.description,
			"description must not be empty — it is the injection hook",
			MEMORY_DESCRIPTION_LIMIT,
			`description exceeds ${MEMORY_DESCRIPTION_LIMIT} characters`,
		),
		textFieldGate(fields.body, "body must not be empty", MEMORY_BODY_LIMIT, `body exceeds the ${MEMORY_BODY_LIMIT}-character cap`),
	]) {
		if (reason !== undefined) {
			reasons.push(reason);
		}
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
