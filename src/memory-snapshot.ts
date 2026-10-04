/**
 * Read-only projection of one workspace memory store for the plugin
 * management card. Everything here is computed from disk at call time — the
 * card is a viewer, never a second store: no caching, no writes, no bootstrap
 * (unlike the injection path, a missing store is reported, not created).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { memoryDirFor } from "./memory-section.js";

/** The index file name (same store contract as the injection path). */
export const MEMORY_SNAPSHOT_INDEX_FILE = "MEMORY.md";

/**
 * Preview size cap for the file content endpoint — files above it answer
 * `too-large` instead of their body (ZCode's memory viewer uses the same 5 MiB).
 */
export const MEMORY_FILE_PREVIEW_LIMIT = 5 * 1024 * 1024;

/** One memory file with its frontmatter fields ("" when absent). */
export interface MemoryFileInfo {
	file: string;
	name: string;
	description: string;
	type: string;
	/** File modification time in epoch milliseconds (the card's "updated" line). */
	updatedAt: number;
}

/** One parsed index row: `- [title](file.md) — hook`. */
export interface MemoryIndexRow {
	title: string;
	file: string;
}

/** The full read-only snapshot the card renders for one workspace root. */
export interface MemorySnapshot {
	root: string;
	memoryDir: string;
	exists: boolean;
	fileCount: number;
	indexEntryCount: number;
	files: MemoryFileInfo[];
	/** Index rows whose referenced file no longer exists on disk. */
	missingFiles: string[];
	/** .md files on disk that no index row references. */
	unindexedFiles: string[];
	/** Set when the store exists but could not be read; null otherwise. */
	readError: string | null;
}

/** Minimal frontmatter fields the card shows. */
export interface MemoryFrontmatter {
	name: string;
	description: string;
	type: string;
}

/**
 * Parse `- [title](file.md) …` rows out of an index text. Anything else
 * (headings, the bootstrap hint comment, blank lines) is ignored.
 */
export function parseMemoryIndexRows(indexText: string): MemoryIndexRow[] {
	const rows: MemoryIndexRow[] = [];
	for (const line of indexText.split("\n")) {
		const match = /^-\s+\[(.+?)\]\(([^()\s]+\.md)\)/.exec(line.trim());
		if (match?.[1] !== undefined && match?.[2] !== undefined) {
			rows.push({ title: match[1], file: match[2] });
		}
	}
	return rows;
}

/**
 * Read the card-relevant frontmatter fields (`name`, `description`, `type`)
 * from a leading `---` block. A missing or malformed block yields "" fields —
 * the body text remains the source of truth the user opens in the editor.
 */
export function parseMemoryFrontmatter(text: string): MemoryFrontmatter {
	const fields: MemoryFrontmatter = { name: "", description: "", type: "" };
	if (!text.startsWith("---")) {
		return fields;
	}
	const blockEnd = text.indexOf("\n---", 3);
	if (blockEnd < 0) {
		return fields;
	}
	for (const line of text.slice(3, blockEnd).split("\n")) {
		const match = /^(name|description|type):\s*(.*)$/.exec(line.trim());
		if (match?.[1] === undefined || match?.[2] === undefined) {
			continue;
		}
		const value = match[2].trim().replace(/^["']|["']$/g, "");
		if (match[1] === "name") {
			fields.name = value;
		} else if (match[1] === "description") {
			fields.description = value;
		} else {
			fields.type = value;
		}
	}
	return fields;
}

/** Store files the card inspects: every .md except the index, sorted. */
function listStoreFiles(memoryDir: string): string[] {
	return readdirSync(memoryDir)
		.filter((file) => file.endsWith(".md") && file !== MEMORY_SNAPSHOT_INDEX_FILE)
		.sort();
}

interface StoreState {
	indexRows: MemoryIndexRow[];
	diskFiles: string[];
	files: MemoryFileInfo[];
}

/** Single read pass over the store; throws on any filesystem failure. */
function readStoreState(memoryDir: string): StoreState {
	const indexText = readFileSync(join(memoryDir, MEMORY_SNAPSHOT_INDEX_FILE), "utf8");
	const diskFiles = listStoreFiles(memoryDir);
	const files = diskFiles.map((file) => {
		const frontmatter = parseMemoryFrontmatter(readFileSync(join(memoryDir, file), "utf8"));
		const updatedAt = statSync(join(memoryDir, file)).mtimeMs;
		return { file, name: frontmatter.name, description: frontmatter.description, type: frontmatter.type, updatedAt };
	});
	return { indexRows: parseMemoryIndexRows(indexText), diskFiles, files };
}

/**
 * The read-only memory snapshot for one workspace root. A missing store
 * reports `exists: false` (the card shows the empty state); a store that
 * exists but fails to read reports `readError` instead of throwing — the
 * card must observe, never break.
 */
export function memorySnapshot(root: string): MemorySnapshot {
	const workspaceRoot = resolve(root);
	const memoryDir = memoryDirFor(workspaceRoot);
	const absent = {
		root: workspaceRoot,
		memoryDir,
		exists: false,
		fileCount: 0,
		indexEntryCount: 0,
		files: [] as MemoryFileInfo[],
		missingFiles: [] as string[],
		unindexedFiles: [] as string[],
		readError: null,
	};
	if (!existsSync(memoryDir)) {
		return absent;
	}
	let state: StoreState;
	try {
		state = readStoreState(memoryDir);
	} catch (error) {
		// Filesystem read failure degrades to an error field: the card shows
		// what went wrong instead of taking the host down with it.
		return {
			...absent,
			exists: true,
			readError: error instanceof Error ? error.message : String(error),
		};
	}
	const referenced = new Set(state.indexRows.map((row) => row.file));
	return {
		root: workspaceRoot,
		memoryDir,
		exists: true,
		fileCount: state.diskFiles.length,
		indexEntryCount: state.indexRows.length,
		files: state.files,
		missingFiles: state.indexRows
			.map((row) => row.file)
			.filter((file) => !state.diskFiles.includes(file)),
		unindexedFiles: state.diskFiles.filter((file) => !referenced.has(file)),
		readError: null,
	};
}

/** The content endpoint's outcomes: the body, or why there is none. */
export type MemoryFileContent =
	| { ok: true; file: string; content: string; mtimeMs: number; changed: boolean }
	| { ok: false; reason: "outside" | "absent" | "too-large" };

/**
 * Read one memory file's body for the card's content preview — the viewer
 * side of the same read-only fence as `memorySnapshot`. The requested file
 * name must be a plain entry of the workspace's memory directory (no path
 * separators, no traversal, resolved location stays inside the directory);
 * anything else answers `outside` without touching the filesystem, so the
 * endpoint cannot become a path oracle. Oversized files answer `too-large`
 * with the body unread.
 */
export function memoryFileContent(root: string, file: string): MemoryFileContent {
	const memoryDir = memoryDirFor(resolve(root));
	if (
		file.length === 0 ||
		!file.endsWith(".md") ||
		file.includes("/") ||
		file.includes("\\") ||
		basename(file) !== file
	) {
		return { ok: false, reason: "outside" };
	}
	const target = resolve(memoryDir, file);
	if (!target.startsWith(memoryDir + "/") && target !== memoryDir) {
		return { ok: false, reason: "outside" };
	}
	let before: ReturnType<typeof statSync>;
	try {
		before = statSync(target);
	} catch {
		return { ok: false, reason: "absent" };
	}
	if (!before.isFile()) {
		return { ok: false, reason: "absent" };
	}
	if (before.size > MEMORY_FILE_PREVIEW_LIMIT) {
		return { ok: false, reason: "too-large" };
	}
	let content: string;
	try {
		content = readFileSync(target, "utf8");
	} catch {
		return { ok: false, reason: "absent" };
	}
	// The file may have been rewritten between stat and read — surface that
	// instead of silently showing stale bytes (same guard shape as ZCode's
	// memory viewer's "changed during read" state).
	const after = statSync(target);
	return { ok: true, file, content, mtimeMs: after.mtimeMs, changed: after.mtimeMs !== before.mtimeMs };
}
