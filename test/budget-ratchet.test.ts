import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRatchet, reasonRefusal, snapshotTree, type BudgetBaseline } from "../scripts/verify-budget-ratchet.js";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function baselineOf(modules: Record<string, { lines: number; outDegree: number }>): BudgetBaseline {
	return { version: 1, modules };
}

describe("checkRatchet", () => {
	it("fails when lines grow", () => {
		const result = checkRatchet(baselineOf({ "a.ts": { lines: 10, outDegree: 0 } }), baselineOf({ "a.ts": { lines: 5, outDegree: 0 } }));
		expect(result.ok).toBe(false);
		expect(result.messages.some((m) => m.includes("lines 5 → 10"))).toBe(true);
	});

	it("fails when out-degree grows", () => {
		const result = checkRatchet(baselineOf({ "a.ts": { lines: 5, outDegree: 3 } }), baselineOf({ "a.ts": { lines: 5, outDegree: 2 } }));
		expect(result.ok).toBe(false);
		expect(result.messages.some((m) => m.includes("out-degree 2 → 3"))).toBe(true);
	});

	it("fails on modules missing from the baseline", () => {
		const result = checkRatchet(baselineOf({ "new.ts": { lines: 1, outDegree: 0 } }), baselineOf({}));
		expect(result.ok).toBe(false);
		expect(result.messages.some((m) => m.includes("new module"))).toBe(true);
	});

	it("stays green on shrinks and reports pruned modules without failing", () => {
		const result = checkRatchet(
			baselineOf({ "a.ts": { lines: 3, outDegree: 1 } }),
			baselineOf({ "a.ts": { lines: 5, outDegree: 2 }, "gone.ts": { lines: 9, outDegree: 0 } }),
		);
		expect(result.ok).toBe(true);
		expect(result.messages.some((m) => m.includes("PRUNED") && m.includes("gone.ts"))).toBe(true);
	});
});

describe("budget-ratchet fixtures", () => {
	it("clean src matches its committed baseline", () => {
		const dir = join(root, "test/fixtures/gates/budget-ratchet/clean");
		const committed = JSON.parse(readFileSync(join(dir, "baseline.json"), "utf-8")) as BudgetBaseline;
		expect(snapshotTree(join(dir, "src"))).toEqual(committed);
		expect(checkRatchet(snapshotTree(join(dir, "src")), committed).ok).toBe(true);
	});

	it("violation src grows past its baseline", () => {
		const dir = join(root, "test/fixtures/gates/budget-ratchet/violation");
		const committed = JSON.parse(readFileSync(join(dir, "baseline.json"), "utf-8")) as BudgetBaseline;
		expect(checkRatchet(snapshotTree(join(dir, "src")), committed).ok).toBe(false);
	});
});

describe("reasonRefusal (--update needs a named Agent Note)", () => {
	it("refuses a bare --update", () => {
		expect(reasonRefusal(undefined)).toContain("--update 需要理由");
		expect(reasonRefusal("  ")).toContain("--update 需要理由");
	});

	it("refuses a `..` path that escapes the notes tree", () => {
		expect(reasonRefusal(".agents/notes/proposed/../../../README.md")).toContain("不认 ..");
	});

	it("refuses a path outside the notes tree or a missing note", () => {
		expect(reasonRefusal("snapshot/budget-baseline.json")).toContain(".agents/notes/");
		expect(reasonRefusal(".agents/notes/proposed/process/no-such-note.md")).toContain("不存在");
	});

	it("accepts a live note under proposed or implemented", () => {
		expect(reasonRefusal(".agents/notes/implemented/process/2026-10-20-architecture-drift-remediation.md")).toBeUndefined();
	});
});
