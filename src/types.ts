/**
 * Type model for the continual-evolution harness state.
 *
 * Design provenance: the state model follows the continual-harness design
 * validated in prime-agent's `/refine` subsystem (MIT): versioned entries
 * keyed by kind, an append-only refinement history carrying an evidence
 * trail, atomic persistence, and deterministic inverse-op rollback. The
 * code here is an original implementation, written for the DeepSeek Harness
 * plugin surface.
 */

/** What a harness entry can be. */
export type RefinementKind = "prompt" | "memory" | "skill" | "subagent";

/**
 * Skill-entry form: `executable` skills carry a python reference contract
 * and can be hot-mounted as tools; `guidance` skills are SKILL.md documents
 * (no python reference) that materialize as discoverable skills for the
 * `skill` tool — the form for recurring multi-step workflows. Absent means
 * `executable` (backwards compatible with pre-guidance stores).
 */
export type SkillKind = "executable" | "guidance";

/** How an entry changes. */
export type RefinementAction = "create" | "update" | "delete" | "archive";

/** Where an entry lives: session-scoped or cross-session. */
export type HarnessScope = "local" | "global";

/**
 * Metadata key recording which session an entry's content was distilled from
 * (trajectory citation; see {@link EntrySource}).
 */
export const SOURCE_SESSION_KEY = "sourceSession";
/**
 * Metadata key recording the session-log event seqs (of the direct user
 * messages) the entry cites as its source (trajectory citation).
 */
export const SOURCE_SEQS_KEY = "sourceSeqs";

/**
 * Metadata key recording when an entry was archived. Archived entries are
 * hidden from injection but never deleted — the data stays in the store and
 * the entry can be restored (unarchive) or rolled back like any other edit.
 */
export const ARCHIVED_AT_KEY = "archivedAt";

/**
 * Metadata key stamped on a LOCAL entry that was promoted to the global
 * store by a session wrap-up: the id of the global entry it became. Present
 * means the entry's lifecycle is finished — it must not be offered for
 * promotion again (the global copy is the live one, the local copy is a
 * restorable trace).
 */
export const PROMOTED_TO_KEY = "promotedTo";

/**
 * Metadata key recording when a local entry was promoted to the global
 * store (companion of {@link PROMOTED_TO_KEY}).
 */
export const PROMOTED_AT_KEY = "promotedAt";

/**
 * Metadata key stamped on a GLOBAL entry created by a session wrap-up
 * promotion: `<sessionId>:<localEntryId>` — the反向 provenance link from the
 * cross-session copy back to the session it was distilled from.
 */
export const SOURCED_FROM_KEY = "sourcedFromLocal";

/**
 * True when the entry is archived (hidden from injection, restorable).
 * Absent or empty archivedAt means the entry is active.
 */
export function isArchived(entry: HarnessEntry): boolean {
	const value = entry.metadata[ARCHIVED_AT_KEY];
	return typeof value === "string" && value.length > 0;
}

/**
 * Trajectory citation attached to newly created entries: the session the
 * content came from and the seqs of the direct user messages it was
 * distilled from. Both fields are optional — when they cannot be determined
 * the citation is simply omitted (never an error).
 */
export interface EntrySource {
	sessionId?: string;
	/** Event seqs of the source user messages, in log order. */
	seqs?: number[];
}

/** A single persisted harness entry. */
export interface HarnessEntry {
	id: string;
	kind: RefinementKind;
	title: string;
	content: string;
	path: string;
	scope: HarnessScope;
	/** Skill entries carry an executable contract; see {@link PythonReference}. */
	reference: Record<string, unknown>;
	/** Skill entries declare their accepted inputs here. */
	arguments: Record<string, unknown>;
	/** Skill form: "executable" (default) or "guidance" (SKILL.md document). */
	skill_kind?: SkillKind;
	metadata: Record<string, unknown>;
	source: "evolve";
	created_at: string;
	updated_at: string;
	version: number;
}

/** One entry of the append-only refinement history (the evidence trail). */
export interface HarnessRefinementEvent {
	id: string;
	trigger: string;
	changes: string[];
	/** Where the trajectory evidence for this refinement lives (e.g. seq ranges). */
	evidence: string;
	/** The falsifiable expectation recorded with the edit. */
	outcome: string;
	created_at: string;
}

/** The whole harness state file. */
export interface HarnessState {
	schema: number;
	entries: Record<RefinementKind, Record<string, HarnessEntry>>;
	refinements: HarnessRefinementEvent[];
}

/** A model-proposed edit, before validation and application. */
export interface RefinementEdit {
	action: RefinementAction;
	kind: RefinementKind;
	id?: string;
	title?: string;
	content?: string;
	path?: string;
	reference?: Record<string, unknown>;
	arguments?: Record<string, unknown>;
	/** Skill form: "guidance" for SKILL.md document skills; absent = executable. */
	skill_kind?: SkillKind;
	metadata?: Record<string, unknown>;
	reason?: string;
}

/** The structured output of a planning pass. */
export interface RefinementProposal {
	summary: string;
	rationale: string;
	edits: RefinementEdit[];
	expectedOutcome: string;
}

/** An edit after the apply pass: before/after snapshots and outcome per edit. */
export interface AppliedRefinementEdit extends RefinementEdit {
	id: string;
	before?: HarnessEntry;
	after?: HarnessEntry;
	applied: boolean;
	error?: string;
}

/** The result of applying one refinement. */
export interface RefinementResult {
	id: string;
	summary: string;
	rationale: string;
	expectedOutcome: string;
	appliedEdits: AppliedRefinementEdit[];
	harnessStatePath: string;
	rollbackOf?: string;
	scope?: HarnessScope;
}

/** The executable contract a skill entry must carry (python REPL skills). */
export interface PythonReference {
	type: "python";
	import?: string;
	python_import?: string;
	callable?: string;
	call_pattern?: string;
}

/** A stable id derived from a title. */
export function slug(raw: string, fallback: string): string {
	const normalized = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return normalized || fallback;
}

/** Fresh empty state with the current schema version. */
export function emptyHarnessState(): HarnessState {
	return {
		schema: 1,
		entries: {
			prompt: {},
			memory: {},
			skill: {},
			subagent: {},
		},
		refinements: [],
	};
}

/** Deep clone helper (state is plain JSON data). */
export function cloneEntry(entry: HarnessEntry | undefined): HarnessEntry | undefined {
	return entry ? (JSON.parse(JSON.stringify(entry)) as HarnessEntry) : undefined;
}
