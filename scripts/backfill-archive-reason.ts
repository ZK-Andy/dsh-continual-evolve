#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Backfill `archive_reason` for rows archived before P4 (one-shot, idempotent).
 * Projects each unclassified archived row's reason from the ledgers and stamps
 * rows with exactly one evidence; ambiguous rows stay `''` for a human.
 *
 * The database path is required and explicit — this writes a real user store,
 * never a default. The script migrates first so the columns exist, then
 * backfills, then prints the counts.
 *
 * Usage: tsx scripts/backfill-archive-reason.ts --db ~/.dsh/evolve/memory.db
 * Exit code 0 = pass, 1 = usage/database failure.
 */
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migrate.js";
import { backfillArchiveReasons } from "../src/data/archive-backfill.js";

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
	const dbPath = argValue("--db");
	if (dbPath === undefined || dbPath.length === 0) {
		console.log("FAIL: --db <path> is required (this script writes a real store, never a default)");
		return 1;
	}
	const database = await openDatabase(dbPath);
	try {
		migrateDatabase(database);
		const result = backfillArchiveReasons(database);
		console.log(`OK（stamped ${String(result.updated)}, skipped ${String(result.skipped.length)}）`);
		for (const row of result.skipped) {
			console.log(`  skipped ${row.workspaceId} / ${row.id}`);
		}
		return 0;
	} finally {
		database.close();
	}
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error) => {
		console.log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	},
);
