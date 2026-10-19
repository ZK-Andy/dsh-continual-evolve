import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUARDED_TABLES } from "../src/data/schema.js";
import { checkSnapshot, renderSnapshot } from "../scripts/verify-schema-snapshot.js";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

describe("renderSnapshot", () => {
	it("covers all three guarded tables with their whitelists", () => {
		const text = renderSnapshot();
		for (const table of ["extraction_log", "item_events", "review_log"]) {
			expect(text).toContain(`-- table: ${table}`);
		}
		// G6 acceptance: the eight verdicts are pinned in the snapshot —
		// deleting one value diverges the text (red).
		for (const verdict of ["keep", "rewrite", "quarantine", "skip", "archive", "promote", "demote", "export-suggestion"]) {
			expect(text).toContain(`'${verdict}'`);
		}
		for (const trigger of ["turn-debounce", "compaction", "close-drain", "explicit", "import", "item-review"]) {
			expect(text).toContain(`'${trigger}'`);
		}
	});

	it("is deterministic across calls", () => {
		expect(renderSnapshot()).toBe(renderSnapshot());
	});
});

describe("checkSnapshot", () => {
	const migrateText = readFileSync(join(root, "src/data/migrate.ts"), "utf-8");

	it("passes against the committed snapshot (green)", () => {
		const actual = readFileSync(join(root, "snapshot/schema.sql"), "utf-8");
		expect(checkSnapshot(actual, migrateText).ok).toBe(true);
	});

	it("fails when a verdict value is dropped from the snapshot (red)", () => {
		const actual = renderSnapshot().replace("'export-suggestion'", "");
		const result = checkSnapshot(actual, migrateText);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("过期");
	});

	it("fails when a column is added without updating the snapshot (red)", () => {
		const actual = renderSnapshot().replace("-- columns: run_id,", "-- columns: run_id, ghost_col,");
		expect(checkSnapshot(actual, migrateText).ok).toBe(false);
	});

	it("fails when the migration chain does not know a guarded table (red)", () => {
		const actual = renderSnapshot();
		const table = GUARDED_TABLES[0]?.table ?? "extraction_log";
		expect(checkSnapshot(actual, "no tables here").ok).toBe(false);
		expect(checkSnapshot(actual, "no tables here").message).toContain(table);
	});

	it("fails when the snapshot file is absent (red)", () => {
		expect(checkSnapshot(undefined, migrateText).ok).toBe(false);
	});
});
