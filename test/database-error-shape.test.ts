import { describe, expect, it, vi } from "vitest";

// The degrade path for a non-Error throw: the message degrades to String()
// instead of assuming `.message` exists.
vi.mock("node:sqlite", () => ({
	DatabaseSync: class {
		constructor() {
			throw "string failure from the loader";
		}
	},
}));

describe("openMemoryStore on a runtime whose sqlite import throws a non-Error", () => {
	it("still throws a typed StoreUnavailableError", async () => {
		const { openMemoryStore, StoreUnavailableError } = await import("../src/store.js");
		const failure = await openMemoryStore("/tmp/evolve-unavailable/memory.db").catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(StoreUnavailableError);
		expect(String((failure as Error).message)).toContain("string failure from the loader");
	});
});
