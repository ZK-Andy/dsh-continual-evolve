#!/usr/bin/env -S ../../node_modules/.bin/tsx
/**
 * Verify Schema / enum snapshot (G6): the guarded-table DDL the code
 * generates must match the committed snapshot.
 *
 * Snapshot source (single homes, see docs/plans/2026-10-19-architecture-supplement-plan.md P0):
 *   src/data/schema.ts (GUARDED_TABLES: memories / extraction_log / item_events / review_log / eval_cases)
 *   +- src/data/records.ts (ARCHIVE_REASONS + EVAL_ARMS, the memories/eval_cases whitelists)
 *   +- src/data/eval-cases.ts (evalCasesDdl + EVAL_CASES_COLUMNS)
 *   +- src/data/review-accounts.ts (REVIEW_VERDICTS, 8-value whitelist)
 *   +- src/store-types.ts (LEDGER_TRIGGERS) + src/data/item-events.ts (ITEM_EVENT_KINDS)
 *   +- src/data/migrate.ts (ensure* chain must know every guarded table)
 *
 * Why a snapshot instead of trusting the drift probe: the probe
 * (`driftedTables`) heals a live store at runtime, but it cannot tell a
 * reviewer that a whitelist value was silently retired or a column was
 * added without a migration. The committed snapshot makes that diff
 * visible in code review: any DDL/whitelist change without `--update`
 * fails this gate.
 *
 * Acceptance (backlog G6):
 *   - delete one verdict value -> red (generated DDL diverges from snapshot)
 *   - add one column without updating the snapshot -> red
 *
 * Usage: tsx scripts/verify-schema-snapshot.ts [--snapshot PATH] [--migrate PATH] [--update]
 * Exit code 0 = pass, 1 = violations found.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { GUARDED_TABLES } from "../src/data/schema.js";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

/** The canonical snapshot text the code generates (deterministic, trailing newline). */
export function renderSnapshot(): string {
	const lines: string[] = [
		"-- dsh-continual-evolve schema snapshot (G6)",
		"-- source: src/data/schema.ts GUARDED_TABLES (+ review-accounts / store-types / item-events single homes)",
		"-- update: tsx scripts/verify-schema-snapshot.ts --update",
		"",
	];
	for (const spec of GUARDED_TABLES) {
		lines.push(`-- table: ${spec.table}`);
		lines.push(`-- columns: ${spec.columns.join(", ")}`);
		for (const check of spec.checks) {
			lines.push(`-- check ${check.column} IN (${check.values.map((v) => `'${v}'`).join(",")})`);
		}
		lines.push(`${spec.ddl(spec.table)};`);
		lines.push("");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

export interface SnapshotCheck {
	readonly ok: boolean;
	readonly message: string;
}

/**
 * Pure check (importable by tests): compare one snapshot text against the
 * generated one, and confirm the migration chain knows every guarded table.
 */
export function checkSnapshot(actual: string | undefined, migrateText: string | undefined): SnapshotCheck {
	const expected = renderSnapshot();
	if (actual === undefined) {
		return { ok: false, message: "FAIL snapshot 缺失（跑 `tsx scripts/verify-schema-snapshot.ts --update` 生成）" };
	}
	if (actual !== expected) {
		return { ok: false, message: "FAIL snapshot 过期：与 src/data/schema.ts 生成的不一致" };
	}
	if (migrateText === undefined) {
		return { ok: false, message: "FAIL 迁移链缺失" };
	}
	const missing = GUARDED_TABLES.filter((spec) => !migrateText.includes(spec.table)).map((spec) => spec.table);
	if (missing.length > 0) {
		return { ok: false, message: `FAIL 迁移链未覆盖表：${missing.join(", ")}` };
	}
	return { ok: true, message: `OK（${GUARDED_TABLES.length} guarded tables / snapshot fresh / migrate covers all）` };
}

function main(): number {
	const snapshotPath = argValue("--snapshot") ?? join(root, "snapshot/schema.sql");
	const migratePath = argValue("--migrate") ?? join(root, "src/data/migrate.ts");
	const update = process.argv.includes("--update");

	if (update) {
		mkdirSync(dirname(snapshotPath), { recursive: true });
		writeFileSync(snapshotPath, renderSnapshot());
		console.log(`UPDATED ${snapshotPath}`);
		return 0;
	}

	const actual = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf-8") : undefined;
	const migrateText = existsSync(migratePath) ? readFileSync(migratePath, "utf-8") : undefined;
	const result = checkSnapshot(actual, migrateText);
	console.log(result.message);
	if (!result.ok && actual !== undefined && actual !== renderSnapshot()) {
		console.log("跑 `tsx scripts/verify-schema-snapshot.ts --update` 同步快照，并在同 PR 给出迁移说明");
	}
	return result.ok ? 0 : 1;
}

/** Run main only under direct execution (tests import the helpers without side effects). */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main();
}
