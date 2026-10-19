/**
 * Read-only skill projection for the plugin management card: the same
 * degrade contract as the memory snapshot (unknown partitions read empty,
 * failing queries report instead of throwing). Split from
 * `memory-snapshot.ts` under the module budget (P4a).
 */
import { type MemoryStore, type SkillRecord } from "../store.js";
import { skillUsagePartition } from "../services/skill-rules.js";
import { MEMORY_FILE_PREVIEW_LIMIT, quarantineReasonOf } from "./memory-snapshot.js";

/** One skill row the card renders (scope resolved: project shadows global). */
export interface SkillFileInfo {
	id: string;
	title: string;
	description: string;
	/** `project` or `global` — which partition the row was read from. */
	scope: string;
	/** Row status; quarantined rows render in the patrol section, not here. */
	status: string;
	/** Update time in epoch milliseconds (the card's "updated" line). */
	updatedAt: number;
	/** Bodies served by id (V2 usage loop); 0 when never consumed. */
	useCount: number;
	/** Last consumption in epoch milliseconds, `null` when never consumed. */
	lastUsedAt: number | null;
}

/** The full read-only skill snapshot the card renders for one workspace root. */
export interface SkillSnapshot {
	root: string;
	exists: boolean;
	/** Set when the store query failed; null otherwise. */
	readError: string | null;
	/** Active row count (the number the card's stats line shows). */
	fileCount: number;
	/** Active rows, project first (the list the card renders). */
	files: SkillFileInfo[];
	/** Rows quarantined by patrol — displayed as 巡检异常, never in the list. */
	quarantined: { id: string; scope: string; reason: string }[];
}

/** Project-first merge of one partition's skills with the global scope. */
function scopedSkills(store: MemoryStore, root: string): { record: SkillRecord; scope: string }[] {
	const seen = new Set<string>();
	const merged: { record: SkillRecord; scope: string }[] = [];
	for (const record of store.listAllSkills(root)) {
		if (seen.has(record.id)) {
			continue;
		}
		seen.add(record.id);
		merged.push({ record, scope: "project" });
	}
	for (const record of store.listAllSkills("")) {
		if (seen.has(record.id)) {
			continue;
		}
		seen.add(record.id);
		merged.push({ record, scope: "global" });
	}
	return merged;
}

function skillInfoOf(store: MemoryStore, entry: { record: SkillRecord; scope: string }): SkillFileInfo {
	let useCount = 0;
	let lastUsedAt: number | null = null;
	try {
		const use = store.getSkillUse(
			skillUsagePartition(entry.scope, entry.record.workspaceId),
			entry.record.id,
			entry.scope,
		);
		if (use !== undefined) {
			useCount = use.useCount;
			lastUsedAt = use.lastUsedAt === null ? null : Date.parse(use.lastUsedAt) || 0;
		}
	} catch {
		// Usage is decoration: the snapshot degrades to zeros, never throws.
	}
	return {
		id: entry.record.id,
		title: entry.record.title,
		description: entry.record.description,
		scope: entry.scope,
		status: entry.record.status,
		updatedAt: Date.parse(entry.record.updatedAt) || 0,
		useCount,
		lastUsedAt,
	};
}

/**
 * The read-only skill snapshot for one workspace partition. Mirrors the
 * memory snapshot's degrade contract: unknown partitions read `exists:
 * false`, failing queries report `readError` instead of throwing.
 */
export function skillSnapshot(store: MemoryStore, root: string): SkillSnapshot {
	const absent: SkillSnapshot = { root, exists: false, readError: null, fileCount: 0, files: [], quarantined: [] };
	let entries;
	try {
		entries = scopedSkills(store, root);
		if (entries.length === 0) {
			return absent;
		}
	} catch (error) {
		return { ...absent, exists: true, readError: error instanceof Error ? error.message : String(error) };
	}
	return {
		root,
		exists: true,
		readError: null,
		fileCount: entries.filter((entry) => entry.record.status === "active").length,
		files: entries.filter((entry) => entry.record.status === "active").map((entry) => skillInfoOf(store, entry)),
		quarantined: entries
			.filter((entry) => entry.record.status === "quarantined")
			.map((entry) => ({ id: entry.record.id, scope: entry.scope, reason: quarantineReasonOf(store, entry.record) })),
	};
}

/** The content endpoint's outcomes for one skill body. */
export type SkillEntryContent = { ok: true; id: string; scope: string; content: string; updatedAtMs: number } | { ok: false; reason: "absent" | "too-large" };

/**
 * Read one skill's body for the card's content preview — project shadowing
 * global, keyed by id, never by file name. Bodies are schema-capped at 64KB,
 * so `too-large` is dead code kept for the day the preview limit shrinks.
 */
export function skillEntryContent(store: MemoryStore, root: string, id: string): SkillEntryContent {
	if (id.length === 0) {
		return { ok: false, reason: "absent" };
	}
	let entries: { record: SkillRecord; scope: string }[];
	try {
		entries = scopedSkills(store, root);
	} catch {
		return { ok: false, reason: "absent" };
	}
	const hit = entries.find((entry) => entry.record.id === id);
	if (hit === undefined) {
		return { ok: false, reason: "absent" };
	}
	/* v8 ignore next 3 */
	if (hit.record.body.length > MEMORY_FILE_PREVIEW_LIMIT) {
		return { ok: false, reason: "too-large" };
	}
	return { ok: true, id: hit.record.id, scope: hit.scope, content: hit.record.body, updatedAtMs: Date.parse(hit.record.updatedAt) || 0 };
}
