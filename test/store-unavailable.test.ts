import { describe, expect, it, vi } from "vitest";

// The degrade path: a runtime without `node:sqlite` must surface a typed
// error, not an unhandled dynamic-import failure.
vi.mock("node:sqlite", () => {
	throw new Error("No such built-in module: node:sqlite");
});

describe("openMemoryStore on a runtime without node:sqlite", () => {
	it("throws StoreUnavailableError", async () => {
		const { openMemoryStore, StoreUnavailableError } = await import("../src/store.js");
		await expect(openMemoryStore("/tmp/evolve-unavailable/memory.db")).rejects.toBeInstanceOf(
			StoreUnavailableError,
		);
	});
});
