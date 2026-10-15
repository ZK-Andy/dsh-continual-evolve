/**
 * The store patrol: bring every managed projection back in line with the
 * store in one pass — drop orphan FTS rows per kind, quarantine secret
 * leaks, reconcile skill files, and persist the patrol account itself.
 * File side-effects arrive as callbacks (the data layer never imports the
 * presentation layer); the store assembly passes the real projection
 * functions. Row shapes live in `./records.js`, secret screening in
 * `./review-accounts.js`.
 */
import { quarantineSecrets } from "./review-accounts.js";
import type { MemoryRow, PromptRow, SkillRow } from "./records.js";
import type { Repository } from "./repository.js";
import { GLOBAL_WORKSPACE, PATROL_STATE_KEY, type PatrolResult, type SkillFileWarning } from "../store-types.js";

/** The file-projection operations patrol syncs after the database (presentation side). */
export interface PatrolFileOps {
	/** The materialized directory for one skill partition. */
	rootOf(partition: string): string;
	/** Drop one skill's materialized directory (managed files only). */
	removeFile(root: string, id: string): SkillFileWarning[];
	/** Rewrite missing/drifted managed files and drop orphan managed files. */
	reconcile(skills: Repository<SkillRow>, result: PatrolResult): void;
}

/**
 * Run one patrol pass over the three repositories.
 * @param memories - The memories repository.
 * @param skills - The skills repository.
 * @param prompts - The prompts repository.
 * @param setState - The state writer (for the patrol account row).
 * @param files - The file-projection operations.
 * @returns The patrol account, also persisted under the patrol state key.
 */
export function runPatrol(
	memories: Repository<MemoryRow>,
	skills: Repository<SkillRow>,
	prompts: Repository<PromptRow>,
	setState: (workspaceId: string, key: string, value: string) => void,
	files: PatrolFileOps,
): PatrolResult {
	const result: PatrolResult = {
		ts: new Date().toISOString(),
		orphanFtsRows: 0,
		quarantined: [] as { workspaceId: string; id: string; reason: string }[],
		skillOrphanFtsRows: 0,
		skillQuarantined: [] as { workspaceId: string; id: string; reason: string }[],
		skillFilesReconciled: 0,
		skillOrphanFilesRemoved: 0,
		skillFileErrors: 0,
		promptOrphanFtsRows: 0,
		promptQuarantined: [] as { workspaceId: string; id: string; reason: string }[],
	};
	for (const rid of memories.ftsOrphanIds()) {
		memories.dropFtsRow(rid);
		result.orphanFtsRows += 1;
	}
	for (const rid of skills.ftsOrphanIds()) {
		skills.dropFtsRow(rid);
		result.skillOrphanFtsRows += 1;
	}
	for (const rid of prompts.ftsOrphanIds()) {
		prompts.dropFtsRow(rid);
		result.promptOrphanFtsRows += 1;
	}
	quarantineSecrets(memories, skills, prompts, result, (workspaceId, id) => {
		// A quarantined skill must stop loading immediately: drop
		// its managed file (hand-written files stay, with an error
		// counted so the residue stays visible).
		for (const warning of files.removeFile(files.rootOf(workspaceId), id)) {
			void warning;
			result.skillFileErrors += 1;
		}
	});
	files.reconcile(skills, result);
	setState(GLOBAL_WORKSPACE, PATROL_STATE_KEY, JSON.stringify(result));
	return result;
}
