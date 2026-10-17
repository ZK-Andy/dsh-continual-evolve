/**
 * Read-only projection of the central memory store for the plugin
 * management card. Everything here is computed from the database at call
 * time — the card is a viewer, never a second store: no caching, no writes.
 * A workspace reads as its `workspace_id` partition; the only filesystem
 * contact is the existence check behind the workspace list (rows whose
 * directory vanished stay in the database but are not listed — 失联不阻塞).
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { MEMORY_FILE_PREVIEW_LIMIT, type MemoryStore, type MemoryRecord, type SkillRecord } from "../store.js";
import { skillUsagePartition } from "../services/skill-rules.js";

export { MEMORY_FILE_PREVIEW_LIMIT };

/** One memory row the card renders. */
export interface MemoryFileInfo {
	id: string;
	title: string;
	description: string;
	type: string;
	/** Row status; quarantined rows render in the patrol section, not here. */
	status: string;
	/** Update time in epoch milliseconds (the card's "updated" line). */
	updatedAt: number;
	/** The reviewer advised moving this fact into the repo docs (advice only). */
	suggestExport: boolean;
}

/** The full read-only snapshot the card renders for one workspace root. */
export interface MemorySnapshot {
	root: string;
	exists: boolean;
	/** Set when the store query failed; null otherwise. */
	readError: string | null;
	/** Active row count (the number the card's stats line shows). */
	fileCount: number;
	/** Active rows (the list the card renders). */
	files: MemoryFileInfo[];
	/** Rows quarantined by patrol — displayed as 巡检异常, never in the list. */
	quarantined: { id: string; reason: string }[];
	/** The last patrol pass this process recorded (null before the first). */
	lastPatrol: { ts: string; orphanFtsRows: number; quarantined: number } | null;
}

/**
 * The read-only snapshot for one workspace partition. A workspace without
 * rows reports `exists: false` (the card shows the empty state); a failing
 * query reports `readError` instead of throwing — the card must observe,
 * never break.
 */
export function memorySnapshot(store: MemoryStore, root: string): MemorySnapshot {
	const workspaceRoot = root;
	const absent: MemorySnapshot = {
		root: workspaceRoot,
		exists: false,
		readError: null,
		fileCount: 0,
		files: [],
		quarantined: [],
		lastPatrol: null,
	};
	let all;
	try {
		all = store.listAll(workspaceRoot);
		if (all.length === 0) {
			return absent;
		}
	} catch (error) {
		return { ...absent, exists: true, readError: error instanceof Error ? error.message : String(error) };
	}
	const lastPatrolRaw = store.state("", "patrol:last");
	let lastPatrol: MemorySnapshot["lastPatrol"] = null;
	if (typeof lastPatrolRaw === "string") {
		try {
			const parsed = JSON.parse(lastPatrolRaw) as { ts?: unknown; orphanFtsRows?: unknown; quarantined?: unknown };
			if (typeof parsed.ts === "string") {
				lastPatrol = {
					ts: parsed.ts,
					orphanFtsRows: typeof parsed.orphanFtsRows === "number" ? parsed.orphanFtsRows : 0,
					quarantined: Array.isArray(parsed.quarantined) ? parsed.quarantined.length : 0,
				};
			}
		} catch {
			lastPatrol = null;
		}
	}
	return {
		root: workspaceRoot,
		exists: true,
		readError: null,
		fileCount: all.filter((record) => record.status === "active").length,
		files: all.filter((record) => record.status === "active").map((record) => infoOf(record, store)),
		quarantined: all
			.filter((record) => record.status === "quarantined")
			.map((record) => ({ id: record.id, reason: quarantineReasonOf(store, record) })),
		lastPatrol,
	};
}

function infoOf(record: MemoryRecord, store: MemoryStore): MemoryFileInfo {
	return {
		id: record.id,
		title: record.title,
		description: record.description,
		type: record.type,
		status: record.status,
		updatedAt: Date.parse(record.updatedAt) || 0,
		// The review's advice exits are read-only suggestions: the card is the
		// only place a human learns "this belongs in the repo docs".
		suggestExport: store.latestVerdict(record.workspaceId, "memory", record.id) === "export-suggestion",
	};
}

/** The patrol reason recorded for a quarantined row, from the last patrol result. */
function quarantineReasonOf(store: MemoryStore, record: { id: string }): string {
	const raw = store.state("", "patrol:last");
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw) as { quarantined?: { id?: unknown; reason?: unknown }[] };
			const hit = Array.isArray(parsed.quarantined)
				? parsed.quarantined.find((entry) => entry?.id === record.id)
				: undefined;
			if (hit !== undefined && typeof hit.reason === "string") {
				return hit.reason;
			}
		} catch {
			// fall through to the generic reason
		}
	}
	return "巡检异常（疑似密钥泄漏），条目已隔离";
}

/** The content endpoint's outcomes: the body, or why there is none. */
export type MemoryEntryContent =
	| { ok: true; id: string; content: string; updatedAtMs: number }
	| { ok: false; reason: "absent" | "too-large" };

/**
 * Read one memory record's body for the card's content preview — keyed by
 * id, never by file name (the store is a database; there are no files to
 * path-check). An unknown id answers `absent`; bodies are capped at 64KB by
 * the schema, so `too-large` can only fire if the preview limit were ever
 * lowered below that.
 */
export function memoryEntryContent(store: MemoryStore, root: string, id: string): MemoryEntryContent {
	if (id.length === 0) {
		return { ok: false, reason: "absent" };
	}
	let record;
	try {
		record = store.get(root, id);
	} catch {
		return { ok: false, reason: "absent" };
	}
	if (record === undefined) {
		return { ok: false, reason: "absent" };
	}
	// Unreachable today: bodies are schema-capped at 64KB, far below the 5 MiB
	// preview limit — kept so the day the limit shrinks, the endpoint stays honest.
	/* v8 ignore next 3 */
	if (record.body.length > MEMORY_FILE_PREVIEW_LIMIT) {
		return { ok: false, reason: "too-large" };
	}
	return { ok: true, id: record.id, content: record.body, updatedAtMs: Date.parse(record.updatedAt) || 0 };
}

/** The workspace rows the card lists: active partitions whose directory survives. */
export function listCardWorkspaces(store: MemoryStore): { root: string; label: string }[] {
	try {
		const seen = new Set<string>();
		const rows: { root: string; label: string }[] = [];
		// One fence for every card route: partitions holding memories,
		// skills, or prompt supplements. A skills-only or prompts-only
		// workspace lists (its memory snapshot reads empty); global skills
		// ride along with whichever workspace is open.
		for (const workspace of [...store.listWorkspaces(), ...store.listSkillWorkspaces(), ...store.listPromptWorkspaces()]) {
			if (workspace.workspaceId === "" || seen.has(workspace.workspaceId)) {
				continue;
			}
			seen.add(workspace.workspaceId);
			if (!existsSync(workspace.workspaceId)) {
				continue;
			}
			rows.push({ root: workspace.workspaceId, label: basename(workspace.workspaceId) });
		}
		return rows;
	} catch {
		return [];
	}
}

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
