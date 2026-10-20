import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

/**
 * The merged reads (B3.1): one projection rule — a local row shadows the
 * global row of the same id — expressed once in `data/memory-reads.ts` and
 * applied by every reader that merges the global (L0) partition.
 */
const WS = "/tmp/work/memory-reads";

let store: MemoryStore;

beforeEach(async () => {
	store = await openMemoryStore(join(mkdtempSync(join(tmpdir(), "evolve-reads-")), "memory.db"));
});

afterEach(() => {
	store.close();
});

function seed(id: string, body: string = "Fedora 44"): boolean {
	const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [
		{ action: "create", id, type: "user", title: `${id} 标题`, description: `${id} 的钩子`, body },
	]);
	return outcome?.ok === true;
}

describe("mergedVisible", () => {
	it("lists the partition's own rows first, then the global-only ones", () => {
		expect(seed("fedora-env")).toBe(true);
		expect(seed("project-note")).toBe(true);
		expect(store.promoteMemory(WS, "fedora-env").ok).toBe(true);
		expect(store.mergedVisible(WS).map((row) => [row.record.id, row.scope])).toEqual([
			["project-note", "project"],
			["fedora-env", "global"],
		]);
	});

	it("lets a surviving local row shadow the global row of the same id", () => {
		expect(seed("fedora-env")).toBe(true);
		expect(store.promoteMemory(WS, "fedora-env").ok).toBe(true);
		// Below the write gates: resurrect the archived origin so both partitions
		// hold the id. The local row is the newer truth and must win exactly once.
		const raw = new DatabaseSync(store.path);
		raw.prepare("UPDATE memories SET status = 'active' WHERE workspace_id = ? AND id = 'fedora-env'").run(WS);
		raw.close();
		expect(store.mergedVisible(WS).map((row) => [row.record.id, row.scope])).toEqual([["fedora-env", "project"]]);
	});

	it("reads the global partition as a project view of itself", () => {
		expect(seed("fedora-env")).toBe(true);
		expect(store.promoteMemory(WS, "fedora-env").ok).toBe(true);
		expect(store.mergedVisible("").map((row) => [row.record.id, row.scope])).toEqual([["fedora-env", "project"]]);
	});

	it("keeps the injection list's active set equal to the card's active rows", () => {
		expect(seed("fedora-env")).toBe(true);
		expect(seed("project-note")).toBe(true);
		expect(store.promoteMemory(WS, "fedora-env").ok).toBe(true);
		const cardActive = store
			.mergedVisible(WS)
			.filter((row) => row.record.status === "active")
			.map((row) => row.record.id)
			.sort();
		expect(cardActive).toEqual(store.list(WS).map((record) => record.id).sort());
	});

	it("applies the same fence to keyword search", () => {
		expect(seed("fedora-env")).toBe(true);
		expect(store.promoteMemory(WS, "fedora-env").ok).toBe(true);
		const hits = store.search(WS, "Fedora").map((record) => record.id);
		expect(hits.filter((id) => id === "fedora-env")).toHaveLength(1);
	});
});
