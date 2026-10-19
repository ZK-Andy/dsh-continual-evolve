import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildValueGraph, checkDepCycles, findCycles } from "../scripts/verify-dep-cycles.js";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

describe("findCycles", () => {
	it("accepts an acyclic diamond", () => {
		const graph = new Map<string, readonly string[]>([
			["a.ts", ["b.ts", "c.ts"]],
			["b.ts", ["d.ts"]],
			["c.ts", ["d.ts"]],
			["d.ts", []],
		]);
		expect(findCycles(graph)).toEqual([]);
	});

	it("reports a two-node cycle as a closed path", () => {
		const graph = new Map<string, readonly string[]>([
			["a.ts", ["b.ts"]],
			["b.ts", ["a.ts"]],
		]);
		expect(findCycles(graph)).toEqual([["a.ts", "b.ts", "a.ts"]]);
	});

	it("reports a self import as a cycle", () => {
		expect(findCycles(new Map([["a.ts", ["a.ts"]]]))).toEqual([["a.ts", "a.ts"]]);
	});
});

describe("checkDepCycles on fixtures", () => {
	it("is red on the a-to-b-to-a violation", () => {
		const result = checkDepCycles(join(root, "test/fixtures/gates/dep-cycles/violation"));
		expect(result.ok).toBe(false);
		expect(result.cycles).toEqual([["a.ts", "b.ts", "a.ts"]]);
	});

	it("is green on the import-free clean sample", () => {
		const result = checkDepCycles(join(root, "test/fixtures/gates/dep-cycles/clean"));
		expect(result.ok).toBe(true);
	});
});

describe("checkDepCycles on the real tree", () => {
	it("holds the ring-propose break: the value graph is acyclic", () => {
		const result = checkDepCycles(join(root, "src"));
		expect(result.cycles).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it("still sees the shared leaf's type-only edges as non-runtime", () => {
		const graph = buildValueGraph(join(root, "src"));
		expect(graph.get("services/extraction-propose.ts")).not.toContain("services/extraction-ring.ts");
		expect(graph.get("services/extraction-ring.ts")).toContain("services/extraction-propose.ts");
	});
});
