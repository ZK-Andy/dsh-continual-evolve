/**
 * The usage counters: one aggregate row per item, bumped only when a body is
 * served by id — a presence heartbeat, never a per-hit ledger, so the tables
 * cannot grow without bound and need no prune. Accounting rides on reads and
 * never fails them.
 */
import type { MemoryStore } from "../store-types.js";
import type { MemoryRow, PromptRow, SkillRow } from "./records.js";
import type { Repository } from "./repository.js";

type UsageMethods = Pick<
	MemoryStore,
	"recordSkillUse" | "getSkillUse" | "recordMemoryUse" | "getMemoryUse" | "recordPromptUse" | "getPromptUse"
>;

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
