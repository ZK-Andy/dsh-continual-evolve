import { describe, expect, it } from "vitest";
import { createKnownWorkspaces } from "../src/known-workspaces.js";

describe("createKnownWorkspaces", () => {
	it("ignores relative and blank cwds", () => {
		const known = createKnownWorkspaces();
		known.remember("relative/path");
		known.remember("   ");
		expect(known.list()).toEqual([]);
	});

	it("resolves roots and lists most recently served first", () => {
		const known = createKnownWorkspaces();
		known.remember("/ws/a");
		known.remember("/ws/b");
		known.remember("/ws/a");
		const list = known.list();
		expect(list.map((workspace) => workspace.root)).toEqual(["/ws/a", "/ws/b"]);
		expect(list[0].root).toBe("/ws/a");
		expect(typeof list[0].lastSeen).toBe("string");
	});

	it("evicts the oldest root beyond the LRU bound", () => {
		const known = createKnownWorkspaces(2);
		known.remember("/ws/a");
		known.remember("/ws/b");
		known.remember("/ws/c");
		expect(known.list().map((workspace) => workspace.root)).toEqual(["/ws/c", "/ws/b"]);
	});

	it("refreshing a root keeps it in the list and moves it to most recent", () => {
		const known = createKnownWorkspaces(2);
		known.remember("/ws/a");
		known.remember("/ws/b");
		known.remember("/ws/a");
		known.remember("/ws/c");
		expect(known.list().map((workspace) => workspace.root)).toEqual(["/ws/c", "/ws/a"]);
	});

	it("never exceeds a bound of one", () => {
		const known = createKnownWorkspaces(0);
		known.remember("/ws/a");
		known.remember("/ws/b");
		expect(known.list().map((workspace) => workspace.root)).toEqual(["/ws/b"]);
	});
});
