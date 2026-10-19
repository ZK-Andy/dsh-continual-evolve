/**
 * The usage counters: one aggregate row per item, bumped only when a body is
 * served by id — a presence heartbeat, never a per-hit ledger, so the tables
 * cannot grow without bound and need no prune. Accounting rides on reads and
 * never fails them.
 */
import type { DatabaseSync } from "node:sqlite";
import type { MemoryStore } from "../store-types.js";
import type { MemoryRow, PromptRow, SkillRow } from "./records.js";
import type { Repository } from "./repository.js";

type UsageMethods = Pick<
	MemoryStore,
	"recordSkillUse" | "getSkillUse" | "recordMemoryUse" | "getMemoryUse" | "recordPromptUse" | "getPromptUse"
>;

/**
 * Carry a memory's usage heartbeat to its versioned successor, so probation
 * evidence (counted by memory id across partitions) does not split when the
 * text versions. Counts sum when the successor already carries reads from an
 * earlier incarnation; the timestamp keeps the latest. A missing source row
 * is a no-op — never invent reads.
 * @param database - The open database handle.
 * @param workspaceId - The partition.
 * @param fromId - The folded row id.
 * @param toId - The surviving row id.
 */
export function moveMemoryUsage(database: DatabaseSync, workspaceId: string, fromId: string, toId: string): void {
	const source = database
		.prepare("SELECT use_count, last_used_at FROM memory_usage WHERE workspace_id = ? AND memory_id = ?")
		.get(workspaceId, fromId) as { use_count: number; last_used_at: string | null } | undefined;
	if (source === undefined) {
		return;
	}
	database.prepare("DELETE FROM memory_usage WHERE workspace_id = ? AND memory_id = ?").run(workspaceId, fromId);
	database
		.prepare(
			"INSERT INTO memory_usage (workspace_id, memory_id, use_count, last_used_at) VALUES (?, ?, ?, ?) " +
				"ON CONFLICT (workspace_id, memory_id) DO UPDATE SET use_count = use_count + excluded.use_count, " +
				"last_used_at = CASE WHEN excluded.last_used_at IS NULL THEN last_used_at " +
				"WHEN last_used_at IS NULL THEN excluded.last_used_at " +
				"WHEN excluded.last_used_at > last_used_at THEN excluded.last_used_at ELSE last_used_at END",
		)
		.run(workspaceId, toId, source.use_count, source.last_used_at);
}

/**
 * Build the six usage-counter methods over the three repositories.
 * @param memories - The memories repository.
 * @param skills - The skills repository.
 * @param prompts - The prompts repository.
 * @returns The six store methods, spread into the assembled store.
 */
export function createUsageCounters(
	memories: Repository<MemoryRow>,
	skills: Repository<SkillRow>,
	prompts: Repository<PromptRow>,
): UsageMethods {
	return {
		recordSkillUse(workspaceId: string, skillId: string, scope: string) {
			try {
				skills.recordUsage(workspaceId, [skillId, scope], new Date().toISOString());
			} catch {
				// Accounting never fails the read it rides on.
			}
		},
		getSkillUse(workspaceId: string, skillId: string, scope: string) {
			try {
				const row = skills.getUsage(workspaceId, [skillId, scope]);
				if (row === undefined) {
					return undefined;
				}
				return { useCount: row.use_count, lastUsedAt: row.last_used_at };
			} catch {
				return undefined;
			}
		},
		recordMemoryUse(workspaceId: string, memoryId: string) {
			try {
				memories.recordUsage(workspaceId, [memoryId], new Date().toISOString());
			} catch {
				// Accounting never fails the read it rides on.
			}
		},
		getMemoryUse(workspaceId: string, memoryId: string) {
			try {
				const row = memories.getUsage(workspaceId, [memoryId]);
				if (row === undefined) {
					return undefined;
				}
				return { useCount: row.use_count, lastUsedAt: row.last_used_at };
			} catch {
				return undefined;
			}
		},
		recordPromptUse(workspaceId: string, promptId: string) {
			try {
				prompts.recordUsage(workspaceId, [promptId], new Date().toISOString());
			} catch {
				// Accounting never fails the read it rides on.
			}
		},
		getPromptUse(workspaceId: string, promptId: string) {
			try {
				const row = prompts.getUsage(workspaceId, [promptId]);
				if (row === undefined) {
					return undefined;
				}
				return { useCount: row.use_count, lastUsedAt: row.last_used_at };
			} catch {
				return undefined;
			}
		},
	};
}
