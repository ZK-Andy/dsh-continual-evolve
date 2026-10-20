/**
 * The memory reads: the partition's own rows with the global (L0) partition
 * merged in, and the one place the projection rule lives (a local row shadows
 * the global row of the same id — `2026-10-13-memory-tiering-and-promotion`).
 *
 * They live in the data layer, not in `store.ts`: the merge and the shadow
 * fence are statements about rows, and the assembly root only spreads the
 * methods a factory returns. The card, the injection index, and keyword search
 * all read through here, so they cannot answer "what does this workspace see"
 * differently.
 */
import { GLOBAL_WORKSPACE, type MemoryRecord, type MemoryStore, type MergedMemoryRow } from "../store-types.js";
import { recordOf, type MemoryRow } from "./records.js";
import type { Repository } from "./repository.js";

/**
 * The memory reads, with the global (L0) partition merged in: a project
 * session sees person-level rows without owning them.
 * @param memories - The memories repository.
 * @returns The six read methods.
 */
export function createMemoryReads(
	memories: Repository<MemoryRow>,
): Pick<MemoryStore, "get" | "list" | "listAll" | "mergedVisible" | "listArchived" | "search"> {
	return {
		get(workspaceId, id) {
			// A local row shadows the global one unless it is archived: promotion
			// archives the source row, and the promoted copy must then be what a
			// read returns (the archived row is history, not a shadow).
			const local = memories.getRow(workspaceId, id);
			if (local !== undefined && local.status !== "archived") {
				return recordOf(local);
			}
			const global = workspaceId === GLOBAL_WORKSPACE ? undefined : memories.getRow(GLOBAL_WORKSPACE, id);
			if (global !== undefined && global.status !== "archived") {
				return recordOf(global);
			}
			return local === undefined ? undefined : recordOf(local);
		},
		list(workspaceId) {
			// L0 first: the injection index is this list, so a person-level fact
			// outranks project detail inside the section budget.
			if (workspaceId === GLOBAL_WORKSPACE) {
				return memories.listRows(GLOBAL_WORKSPACE).map(recordOf);
			}
			const local = memories.listRows(workspaceId).map(recordOf);
			return [...globalOnly(local, memories.listRows(GLOBAL_WORKSPACE).map(recordOf)), ...local];
		},
		listAll(workspaceId) {
			// The partition-scoped projection: the global partition lists itself,
			// and merging here would show every row twice.
			return memories.listVisibleRows(workspaceId).map(recordOf);
		},
		mergedVisible(workspaceId) {
			const local = memories.listVisibleRows(workspaceId).map(recordOf);
			const rows: MergedMemoryRow[] = local.map((record) => ({ record, scope: "project" as const }));
			if (workspaceId === GLOBAL_WORKSPACE) {
				return rows;
			}
			for (const record of globalOnly(local, memories.listVisibleRows(GLOBAL_WORKSPACE).map(recordOf))) {
				rows.push({ record, scope: "global" });
			}
			return rows;
		},
		listArchived(workspaceId, limit = 50) {
			return memories.listArchivedRows(workspaceId, limit).map(recordOf);
		},
		search(workspaceId, query, limit = 20) {
			const local = memories.searchRows(workspaceId, query, limit).map(recordOf);
			if (workspaceId === GLOBAL_WORKSPACE) {
				return local;
			}
			return [...globalOnly(local, memories.listRows(GLOBAL_WORKSPACE).map(recordOf)), ...local].slice(0, limit);
		},
	};
}

/**
 * The global rows no local record shadows — the L0/L1 rule in one place, so
 * the injection list, keyword search, and the card's merged projection cannot
 * answer "which global rows are visible here" differently.
 * @param local - The partition's own records (whatever set that read selected).
 * @param global - The candidate global records.
 * @returns The global records whose id no local record claims.
 */
function globalOnly(local: readonly MemoryRecord[], global: readonly MemoryRecord[]): MemoryRecord[] {
	const shadowed = new Set(local.map((record) => record.id));
	return global.filter((record) => !shadowed.has(record.id));
}
