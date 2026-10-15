/**
 * Read-only prompt-supplement projection for the plugin management card.
 * Mirrors `memory-snapshot.ts`' degrade contract (unknown partitions read
 * `exists: false`, failing queries report `readError` instead of throwing)
 * over the workspace's `prompts` partition. Prompts project to no files,
 * so the snapshot lists store rows directly; usage decorates each row.
 */
import { MEMORY_FILE_PREVIEW_LIMIT, type MemoryStore, type PromptRecord } from "../store.js";

export { MEMORY_FILE_PREVIEW_LIMIT };

/** One prompt row the card renders. */
export interface PromptFileInfo {
	id: string;
	title: string;
	description: string;
	/** Row status; quarantined rows render in the patrol section, not here. */
	status: string;
	/** Update time in epoch milliseconds (the card's "updated" line). */
	updatedAt: number;
	/** Bodies served by id; 0 when never consumed. */
	useCount: number;
	/** Last consumption in epoch milliseconds, `null` when never consumed. */
	lastUsedAt: number | null;
}

/** The full read-only prompt snapshot the card renders for one workspace root. */
export interface PromptSnapshot {
	root: string;
	exists: boolean;
	/** Set when the store query failed; null otherwise. */
	readError: string | null;
	/** Active row count (the number the card's stats line shows). */
	fileCount: number;
	/** Active rows, newest first (the list the card renders). */
	files: PromptFileInfo[];
	/** Rows quarantined by patrol — displayed as 巡检异常, never in the list. */
	quarantined: { id: string; reason: string }[];
}

/**
 * The read-only prompt snapshot for one workspace partition. A workspace
 * without rows reports `exists: false` (the card shows the empty state).
 * @param store - The open central store.
 * @param root - The workspace partition to snapshot.
 * @returns The snapshot; never throws past it.
 */
export function promptSnapshot(store: MemoryStore, root: string): PromptSnapshot {
	const absent: PromptSnapshot = { root, exists: false, readError: null, fileCount: 0, files: [], quarantined: [] };
	let all: PromptRecord[];
	try {
		all = store.listAllPrompts(root);
		if (all.length === 0) {
			return absent;
		}
	} catch (error) {
		return { ...absent, exists: true, readError: error instanceof Error ? error.message : String(error) };
	}
	return {
		root,
		exists: true,
		readError: null,
		fileCount: all.filter((record) => record.status === "active").length,
		files: all.filter((record) => record.status === "active").map((record) => promptInfoOf(store, record)),
		quarantined: all
			.filter((record) => record.status === "quarantined")
			.map((record) => ({ id: record.id, reason: promptQuarantineReasonOf(store, record) })),
	};
}

function promptInfoOf(store: MemoryStore, record: PromptRecord): PromptFileInfo {
	let useCount = 0;
	let lastUsedAt: number | null = null;
	try {
		const use = store.getPromptUse(record.workspaceId, record.id);
		if (use !== undefined) {
			useCount = use.useCount;
			lastUsedAt = use.lastUsedAt === null ? null : Date.parse(use.lastUsedAt) || 0;
		}
	} catch {
		// Usage is decoration: the snapshot degrades to zeros, never throws.
	}
	return {
		id: record.id,
		title: record.title,
		description: record.description,
		status: record.status,
		updatedAt: Date.parse(record.updatedAt) || 0,
		useCount,
		lastUsedAt,
	};
}

/** The patrol reason recorded for a quarantined prompt, from the last patrol result. */
function promptQuarantineReasonOf(store: MemoryStore, record: { id: string }): string {
	const raw = store.state("", "patrol:last");
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw) as { promptQuarantined?: { id?: unknown; reason?: unknown }[] };
			const hit = Array.isArray(parsed.promptQuarantined)
				? parsed.promptQuarantined.find((entry) => entry?.id === record.id)
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

/** The content endpoint's outcomes for one prompt body. */
export type PromptEntryContent = { ok: true; id: string; content: string; updatedAtMs: number } | { ok: false; reason: "absent" | "too-large" };

/**
 * Read one prompt supplement's body for the card's content preview — keyed
 * by id, never by file name. Bodies are schema-capped at 64KB, so
 * `too-large` is dead code kept for the day the preview limit shrinks.
 * @param store - The open central store.
 * @param root - The workspace partition to read from.
 * @param id - The prompt id.
 * @returns The body, or why there is none.
 */
export function promptEntryContent(store: MemoryStore, root: string, id: string): PromptEntryContent {
	if (id.length === 0) {
		return { ok: false, reason: "absent" };
	}
	let record;
	try {
		record = store.getPrompt(root, id);
	} catch {
		return { ok: false, reason: "absent" };
	}
	if (record === undefined) {
		return { ok: false, reason: "absent" };
	}
	/* v8 ignore next 3 */
	if (record.body.length > MEMORY_FILE_PREVIEW_LIMIT) {
		return { ok: false, reason: "too-large" };
	}
	return { ok: true, id: record.id, content: record.body, updatedAtMs: Date.parse(record.updatedAt) || 0 };
}
