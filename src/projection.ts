/**
 * Readable Markdown projection (P1): a ZCode-style `MEMORY.md` index plus
 * one file per memory fact, materialized from the JSON store.
 *
 * The JSON harness state stays the single source of truth (versions,
 * rollback, audit). The projection is a derived, human-trustable view:
 * it is rewritten from the post-apply state inside the engine, so the
 * model can never write it directly and rollback/archive stay in sync.
 *
 * Layout per store directory:
 *
 *   <stateDir>/MEMORY.md          one line per memory entry
 *   <stateDir>/memory/<file>.md   one fact per file with frontmatter
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isArchived, isMemoryType, MEMORY_TYPE_KEY } from "./types.js";
import type { HarnessEntry, HarnessState } from "./types.js";

/** Index file name at the store root. */
export const MEMORY_INDEX_FILE = "MEMORY.md";
/** Per-fact file directory inside the store. */
export const MEMORY_FACTS_DIR = "memory";

/** Map a memory id to a flat filename (`:` is legal on disk but hostile to tools). */
export function memoryFactFilename(id: string): string {
	return `${id.replace(/:/g, "_")}.md`;
}

/**
 * Rewrite the whole projection from the post-apply state: index, one file
 * per memory entry (including archived ones, flagged), and deletion of
 * files whose ids no longer exist. Deterministic — the same state always
 * produces the same files.
 *
 * @param stateDir The store directory holding harness_state.json.
 * @param state The freshly persisted state (post-apply, post-rollback).
 */
export function materializeMemoryProjection(stateDir: string, state: HarnessState): void {
	const entries = Object.values(state.entries.memory).sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);
	const factsDir = join(stateDir, MEMORY_FACTS_DIR);
	mkdirSync(factsDir, { recursive: true });

	const expected = new Map<string, HarnessEntry>();
	for (const entry of entries) {
		let filename = memoryFactFilename(entry.id);
		let suffix = 1;
		while (expected.has(filename)) {
			suffix += 1;
			filename = `${memoryFactFilename(entry.id).replace(/\.md$/, "")}~${suffix}.md`;
		}
		expected.set(filename, entry);
	}
	for (const [filename, entry] of expected) {
		writeFileSync(join(factsDir, filename), renderMemoryFact(entry), { encoding: "utf8", mode: 0o600 });
	}
	// Sweep facts whose entries vanished (delete); archived entries keep
	// their file with archived:true frontmatter.
	let existing: string[];
	try {
		existing = readdirSync(factsDir).filter((file) => file.endsWith(".md"));
	} catch {
		existing = [];
	}
	for (const file of existing) {
		if (!expected.has(file)) {
			try {
				unlinkSync(join(factsDir, file));
			} catch {
				// A stale fact file must not break the apply path; the next
				// materialization retries the sweep.
			}
		}
	}
	writeFileSync(join(stateDir, MEMORY_INDEX_FILE), renderMemoryIndex([...expected]), { encoding: "utf8", mode: 0o600 });
}

/** Read back one projected fact file (round-trip helper for tests and tools). */
export function readMemoryFact(factsDir: string, filename: string): string {
	return readFileSync(join(factsDir, filename), "utf8");
}

/** True when the store directory carries a projection from a previous apply. */
export function hasMemoryProjection(stateDir: string): boolean {
	return existsSync(join(stateDir, MEMORY_INDEX_FILE)) && existsSync(join(stateDir, MEMORY_FACTS_DIR));
}

function renderMemoryFact(entry: HarnessEntry): string {
	const type = isMemoryType(entry.metadata[MEMORY_TYPE_KEY]) ? String(entry.metadata[MEMORY_TYPE_KEY]) : "untyped";
	const frontmatter = [
		"---",
		`id: ${entry.id}`,
		`scope: ${entry.scope}`,
		`kind: memory`,
		`memoryType: ${type}`,
		`version: ${entry.version}`,
		`path: ${entry.path}`,
		`archived: ${isArchived(entry)}`,
		`created_at: ${entry.created_at}`,
		`updated_at: ${entry.updated_at}`,
		"---",
	].join("\n");
	return `${frontmatter}\n\n# ${entry.title}\n\n${entry.content}\n`;
}

function renderMemoryIndex(files: [string, HarnessEntry][]): string {
	const lines = ["# Memory Index", "", "Derived from the JSON harness state — do not edit by hand; it is rewritten on every memory apply.", ""];
	if (files.length === 0) {
		lines.push("(no memory entries yet)");
		return `${lines.join("\n")}\n`;
	}
	for (const [file, entry] of files) {
		const type = isMemoryType(entry.metadata[MEMORY_TYPE_KEY]) ? String(entry.metadata[MEMORY_TYPE_KEY]) : "untyped";
		const archived = isArchived(entry) ? ", archived" : "";
		lines.push(`- [${entry.scope}:${entry.id}] ${entry.title} (type=${type}, v${entry.version}${archived}) → ${MEMORY_FACTS_DIR}/${file}`);
	}
	return `${lines.join("\n")}\n`;
}
