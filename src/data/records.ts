/**
 * Row mapping between the SQLite tables and the store's record shapes.
 * The repository moves rows; this module translates them. Table/column
 * knowledge lives here and in `./resource-kinds.js`, nowhere else.
 */
import type { MemoryRecord, PromptRecord, SkillRecord } from "../store-types.js";

export interface MemoryRow {
	workspace_id: string;
	id: string;
	type: string;
	title: string;
	description: string;
	body: string;
	status: string;
	source_session: string | null;
	source_seqs: string | null;
	source_run: string | null;
	corrects: string | null;
	created_at: string;
	updated_at: string;
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
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
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
