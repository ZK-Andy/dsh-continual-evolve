/**
 * Opening the central SQLite file: directory creation plus the typed
 * unavailability signal the entry point degrades on. Schema and later
 * migrations live in ./migrate.js — this module only gets a handle.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** Thrown when the runtime lacks `node:sqlite` — the degrade signal. */
export class StoreUnavailableError extends Error {}

/**
 * Open (creating on first use) the database file at a resolved path.
 * @param path - Resolved database file path; the parent directory is created.
 * @returns The open database; the caller applies migrations next.
 * @throws {StoreUnavailableError} When `node:sqlite` cannot load or the file cannot open.
 */
export async function openDatabase(path: string): Promise<DatabaseSync> {
	try {
		const { DatabaseSync } = await import("node:sqlite");
		// The parent directory must exist before SQLite opens the file — a
		// fresh `~/.dsh` has no `evolve/` yet.
		mkdirSync(dirname(path), { recursive: true });
		return new DatabaseSync(path);
	} catch (error) {
		throw new StoreUnavailableError(
			`node:sqlite unavailable (Node ≥ 22.5 required) — memory store disabled: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
