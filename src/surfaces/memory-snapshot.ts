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
import { GLOBAL_WORKSPACE, MEMORY_FILE_PREVIEW_LIMIT, type MemoryScopeTag, type MemoryStore, type MergedMemoryRow } from "../store.js";
import { buildIdentity, type BuildIdentity } from "../services/build-identity.js";
import { injectionStats, type InjectionStats } from "../services/injection-stats.js";

export { MEMORY_FILE_PREVIEW_LIMIT };

/** One memory row the card renders. */
export interface MemoryFileInfo {
	id: string;
	title: string;
	description: string;
	type: string;
	/** Row status; quarantined rows render in the patrol section, not here. */
	status: string;
	/** Where the row lives — promoted memories keep showing up in their origin workspace. */
	scope: MemoryScopeTag;
	/** Update time in epoch milliseconds (the card's "updated" line). */
	updatedAt: number;
	/** The reviewer advised moving this fact into the repo docs (advice only). */
	suggestExport: boolean;
	/** The caveat rendered with the hook ("不适用：…"), empty when none. */
	notWhen: string;
}

/** One archived row the card's archive zone renders (read-only, no actions). */
export interface ArchivedFileInfo {
	id: string;
	title: string;
	/** The archive reason, `""` when unclassified (the client renders the empty label). */
	reason: string;
	/** The surviving row id for merges, `null` otherwise (plain text, not a link). */
	mergedInto: string | null;
	/**
	 * The global row id holding this memory's live copy, `null` when the global
	 * partition has no live row of this id (or this view *is* the global one).
	 * The pointer answers one direction only — a promoted source row archived
	 * here whose content lives on in the global partition; a demoted global row
	 * points nowhere, because its live copy is in the origin partition, which
	 * this view cannot see.
	 */
	globalCopyId: string | null;
	/** Update (archive) time in epoch milliseconds. */
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
	/** Archived rows, newest first, capped at 50 (the folded archive zone). */
	archived: ArchivedFileInfo[];
	/** Rows quarantined by patrol — displayed as 巡检异常, never in the list. */
	quarantined: { id: string; scope: MemoryScopeTag; reason: string }[];
	/** The last patrol pass this process recorded (null before the first). */
	lastPatrol: { ts: string; orphanFtsRows: number; quarantined: number } | null;
	/** Which build this process runs versus what is on disk (null when unreadable). */
	build: BuildIdentity | null;
	/** Recent injection volume and how much of it was read (null when unreadable). */
	injection: InjectionStats | null;
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
		archived: [],
		quarantined: [],
		lastPatrol: null,
		build: safeBuild(),
		injection: null,

	};
	let all;
	try {
		// The projection rule lives in the store: this surface renders what it
		// answers, so the card cannot fork from the injection index's view.
		all = store.mergedVisible(workspaceRoot);
		if (all.length === 0) {
			return { ...absent, archived: safeArchived(store, workspaceRoot), exists: all.length > 0 };
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
		fileCount: all.filter((entry) => entry.record.status === "active").length,
		files: all.filter((entry) => entry.record.status === "active").map((entry) => infoOf(entry, store)),
		archived: safeArchived(store, workspaceRoot),
		quarantined: all
			.filter((entry) => entry.record.status === "quarantined")
			.map((entry) => ({ id: entry.record.id, scope: entry.scope, reason: quarantineReasonOf(store, entry.record) })),
		lastPatrol,
		build: safeBuild(),
		injection: safeInjection(store, workspaceRoot),

	};
}

/** The archive zone, degrading to empty when the read itself fails. */
function safeArchived(store: MemoryStore, workspaceRoot: string): ArchivedFileInfo[] {
	try {
		// One read for the whole zone, never one per row. The pointer set is the
		// global partition's live rows *promoted out of this workspace*: the ids
		// are partitioned per workspace, so an unrelated partition's global row
		// of the same id is not this memory's live copy.
		const promotedHere = new Set(
			workspaceRoot === GLOBAL_WORKSPACE
				? []
				: store
						.list(GLOBAL_WORKSPACE)
						.filter((record) => record.originWorkspace === workspaceRoot)
						.map((record) => record.id),
		);
		return store.listArchived(workspaceRoot, 50).map((record) => ({
			id: record.id,
			title: record.title,
			reason: record.archiveReason,
			mergedInto: record.mergedInto,
			// Only a promotion archives a source row while the content lives on.
			globalCopyId: record.archiveReason === "promoted-source" && promotedHere.has(record.id) ? record.id : null,
			updatedAt: Date.parse(record.updatedAt) || 0,
		}));
	} catch {
		return [];
	}
}

/** The build identity, degrading to null when the read itself fails. */
function safeBuild(): BuildIdentity | null {
	try {
		return buildIdentity();
	} catch {
		return null;
	}
}

/** The injection reading for one workspace, degrading to null. */
function safeInjection(store: MemoryStore, workspaceRoot: string): InjectionStats | null {
	try {
		return injectionStats(store, workspaceRoot === GLOBAL_WORKSPACE ? GLOBAL_WORKSPACE : workspaceRoot);
	} catch {
		return null;
	}
}

function infoOf(entry: MergedMemoryRow, store: MemoryStore): MemoryFileInfo {
	const record = entry.record;
	return {
		id: record.id,
		title: record.title,
		description: record.description,
		type: record.type,
		status: record.status,
		scope: entry.scope,
		updatedAt: Date.parse(record.updatedAt) || 0,
		// The review's advice exits are read-only suggestions: the card is the
		// only place a human learns "this belongs in the repo docs".
		suggestExport: store.latestVerdict(record.workspaceId, "memory", record.id) === "export-suggestion",
		notWhen: record.notWhen,
	};
}

/** The patrol reason recorded for a quarantined row, from the last patrol result. */
export function quarantineReasonOf(store: MemoryStore, record: { id: string }): string {
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
