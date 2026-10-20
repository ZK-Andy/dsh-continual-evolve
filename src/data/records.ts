/**
 * The single home for storage shapes: each kind's row (snake_case columns
 * as stored) next to its record (camelCased as served) plus the mapping
 * between them. The repository moves rows; the mapping here translates
 * them. Table/column knowledge lives here and in `./resource-kinds.js`,
 * nowhere else. The memories table's DDL and its copy list live here too:
 * a table's shape follows the table's module, and the schema guard
 * aggregates them.
 */

export interface MemoryRow {
	workspace_id: string;
	id: string;
	type: string;
	title: string;
	description: string;
	body: string;
	status: string;
	scope: string;
	probation_until: string | null;
	origin_workspace: string | null;
	not_when: string;
	source_session: string | null;
	source_seqs: string | null;
	source_run: string | null;
	corrects: string | null;
	/** Why the row was archived (`''` = unclassified migration placeholder). */
	archive_reason: string;
	/** The active row id a `merged-duplicate` row was folded into, `null` otherwise. */
	merged_into: string | null;
	created_at: string;
	updated_at: string;
}

/**
 * The closed `archive_reason` value set (P4): the only writers are promotion,
 * review-archive, demotion, and same-session duplicate merges. `''` is the
 * migration placeholder for rows archived before the column existed.
 */
export const ARCHIVE_REASONS = ["", "promoted-source", "review-archive", "demoted-source", "merged-duplicate"] as const;

/** One `archive_reason` value (derived from {@link ARCHIVE_REASONS}, never hand-written). */
export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

/** The memories table's columns in DDL order: the rebuild's explicit copy list (P4). */
export const MEMORIES_COLUMNS = [
	"workspace_id",
	"id",
	"type",
	"title",
	"description",
	"body",
	"status",
	"source_session",
	"source_seqs",
	"source_run",
	"corrects",
	"scope",
	"probation_until",
	"origin_workspace",
	"not_when",
	"archive_reason",
	"merged_into",
	"created_at",
	"updated_at",
] as const;

/**
 * The memories table's DDL, parameterized by table name so the fresh-file path
 * (`migrate.ts` `SCHEMA_DDL`), the rebuild, and the G6 snapshot share one text.
 * The `archive_reason` whitelist is generated from {@link ARCHIVE_REASONS}.
 * @param name - The table to create (the rebuild passes its temporary name).
 * @returns The `CREATE TABLE` statement.
 */
export function memoriesDdl(name: string): string {
	const reasons = ARCHIVE_REASONS.map((reason) => `'${reason}'`).join(",");
	return `CREATE TABLE IF NOT EXISTS ${name} (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('user','feedback','reference')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) <= 65536),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','quarantined','archived')),
  source_session TEXT,
  source_seqs TEXT,
  source_run TEXT,
  corrects TEXT,
  scope TEXT NOT NULL DEFAULT 'project',
  probation_until TEXT,
  origin_workspace TEXT,
  not_when TEXT NOT NULL DEFAULT '',
  archive_reason TEXT NOT NULL DEFAULT '' CHECK (archive_reason IN (${reasons})),
  merged_into TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
) STRICT`;
}

/**
 * The closed eval arm value set (P5): the four GDPevo arms, the `eval_cases`
 * whitelist's single home (its write path retired with the runner, so no
 * record shape references them any more).
 */
export const EVAL_ARMS = ["base", "current", "candidate", "reflect"] as const;

/** One stored memory record (snake_case columns camelCased). */
export interface MemoryRecord {
	workspaceId: string;
	id: string;
	type: "user" | "feedback" | "reference";
	title: string;
	description: string;
	body: string;
	status: "active" | "quarantined" | "archived";
	/** Origin session id, `null` for imports. */
	sourceSession: string | null;
	/** Trajectory seq range the fact came from ("820-831"), `null` when unknown. */
	sourceSeqs: string | null;
	/** The extraction run that wrote it; `'explicit'` for tool writes. */
	sourceRun: string | null;
	/** Id of the memory this row corrects/supersedes in the same workspace, `null` when standalone. */
	corrects: string | null;
	/** Layer marker: `project` (default) or `person` (a promotion candidate). */
	scope: "project" | "person";
	/** Why the row was archived (`''` = unclassified); meaningless unless `status` is `archived`. */
	archiveReason: ArchiveReason;
	/** The active row id a `merged-duplicate` row was folded into, `null` otherwise. */
	mergedInto: string | null;
	/** End of the global probation window, `null` when the row is not on probation. */
	probationUntil: string | null;
	/** For a promoted (global) row: the partition it came from, `null` otherwise. */
	originWorkspace: string | null;
	/** The caveat rendered with the hook ("不适用：…"); empty when none was given. */
	notWhen: string;
	createdAt: string;
	updatedAt: string;
}

/**
 * Map one memories row to its record shape.
 * @param row - The raw memories row.
 * @returns The camelCased record.
 */
export function recordOf(row: MemoryRow): MemoryRecord {
	return {
		workspaceId: row.workspace_id,
		id: row.id,
		type: row.type as MemoryRecord["type"],
		title: row.title,
		description: row.description,
		body: row.body,
		status: row.status as MemoryRecord["status"],
		sourceSession: row.source_session,
		sourceSeqs: row.source_seqs,
		sourceRun: row.source_run,
		corrects: row.corrects ?? null,
		scope: row.scope === "person" ? "person" : "project",
		archiveReason: (ARCHIVE_REASONS as readonly string[]).includes(row.archive_reason)
			? (row.archive_reason as ArchiveReason)
			: "",
		mergedInto: row.merged_into ?? null,
		probationUntil: row.probation_until ?? null,
		originWorkspace: row.origin_workspace ?? null,
		notWhen: row.not_when ?? "",
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** One injection write: what the index named for one session. */
export interface InjectionWrite {
	workspaceId: string;
	sessionId: string;
	/** ISO timestamp of the build. */
	ts: string;
	/** Memory ids the index named (full rows and id-only rows alike). */
	ids: string[];
	/** Estimated tokens of the rendered index. */
	estTokens: number;
}

/** One stored injection row. */
export interface InjectionRow {
	workspaceId: string;
	sessionId: string;
	ts: string;
	ids: string[];
	estTokens: number;
}

export interface PromptRow {
	workspace_id: string;
	id: string;
	title: string;
	description: string;
	body: string;
	status: string;
	source_session: string | null;
	source_seqs: string | null;
	source_run: string | null;
	created_at: string;
	updated_at: string;
}

/** One stored prompt supplement (workspace-scoped reusable prompt text). Prompts carry no type and no scope. */
export interface PromptRecord {
	workspaceId: string;
	id: string;
	title: string;
	description: string;
	body: string;
	status: "active" | "quarantined" | "archived";
	/** Origin session id, `null` for imports. */
	sourceSession: string | null;
	/** Trajectory seq range the supplement came from ("820-831"), `null` when unknown. */
	sourceSeqs: string | null;
	/** The run that wrote it; `'explicit'` for tool writes. */
	sourceRun: string | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * Map one prompts row to its record shape.
 * @param row - The raw prompts row.
 * @returns The camelCased record.
 */
export function promptRecordOf(row: PromptRow): PromptRecord {
	return {
		workspaceId: row.workspace_id,
		id: row.id,
		title: row.title,
		description: row.description,
		body: row.body,
		status: row.status as PromptRecord["status"],
		sourceSession: row.source_session,
		sourceSeqs: row.source_seqs,
		sourceRun: row.source_run,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export interface SkillRow {
	workspace_id: string;
	id: string;
	title: string;
	description: string;
	body: string;
	status: string;
	source_session: string | null;
	source_seqs: string | null;
	source_run: string | null;
	created_at: string;
	updated_at: string;
}

/** One stored skill record (snake_case columns camelCased). Skills carry no type. */
export interface SkillRecord {
	workspaceId: string;
	id: string;
	title: string;
	description: string;
	body: string;
	status: "active" | "quarantined" | "archived";
	/** Origin session id, `null` for imports. */
	sourceSession: string | null;
	/** Trajectory seq range the skill came from ("820-831"), `null` when unknown. */
	sourceSeqs: string | null;
	/** The run that wrote it; `'explicit'` for tool writes. */
	sourceRun: string | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * Map one skills row to its record shape.
 * @param row - The raw skills row.
 * @returns The camelCased record.
 */
export function skillRecordOf(row: SkillRow): SkillRecord {
	return {
		workspaceId: row.workspace_id,
		id: row.id,
		title: row.title,
		description: row.description,
		body: row.body,
		status: row.status as SkillRecord["status"],
		sourceSession: row.source_session,
		sourceSeqs: row.source_seqs,
		sourceRun: row.source_run,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
