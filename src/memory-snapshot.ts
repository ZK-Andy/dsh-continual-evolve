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
import { MEMORY_FILE_PREVIEW_LIMIT, type MemoryStore, type MemoryRecord } from "./store.js";

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
		files: all.filter((record) => record.status === "active").map(infoOf),
		quarantined: all
			.filter((record) => record.status === "quarantined")
			.map((record) => ({ id: record.id, reason: quarantineReasonOf(store, record) })),
		lastPatrol,
	};
}

function infoOf(record: MemoryRecord): MemoryFileInfo {
	return {
		id: record.id,
		title: record.title,
		description: record.description,
		type: record.type,
		status: record.status,
		updatedAt: Date.parse(record.updatedAt) || 0,
	};
}

/** The patrol reason recorded for a quarantined row, from the last patrol result. */
function quarantineReasonOf(store: MemoryStore, record: MemoryRecord): string {
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
		return store
			.listWorkspaces()
			.filter((workspace) => existsSync(workspace.workspaceId))
			.map((workspace) => ({ root: workspace.workspaceId, label: basename(workspace.workspaceId) }));
	} catch {
		return [];
	}
}
