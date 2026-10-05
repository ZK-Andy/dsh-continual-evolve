import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

// Failure injection: the rename-aside step failing must not lose the import
// or break the caller — the flag is still set (imports are idempotent) and
// the result reports the archive failure.
const renameSync = vi.hoisted(() => vi.fn(() => {
	throw new Error("EACCES: mocked rename failure");
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, renameSync };
});

let workspace = "";
let store: MemoryStore;

beforeEach(async () => {
	workspace = mkdtempSync(join(tmpdir(), "evolve-import-fail-"));
	store = await openMemoryStore(join(mkdtempSync(join(tmpdir(), "evolve-import-fail-db-")), "memory.db"));
});

describe("importWorkspaceMd when the rename aside fails", () => {
	it("keeps the import, reports the failure, and sets the flag anyway", async () => {
		const { importWorkspaceMd } = await import("../src/import-md.js");
		mkdirSync(join(workspace, ".evolve", "memory"), { recursive: true });
		writeFileSync(
			join(workspace, ".evolve", "memory", "a.md"),
			["---", "name: a", "description: d", "type: reference", "---", "", "b"].join("\n"),
			"utf8",
		);
		const result = importWorkspaceMd(store, workspace);
		expect(result.imported).toBe(1);
		expect(result.archiveDir).toBeNull();
		expect(result.errors[0]).toContain("could not be renamed");
		expect(store.state(workspace, "md-imported")).toBeDefined();
	});
});
