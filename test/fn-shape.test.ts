import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectViolations, compareFnShape, countViolations, type FnCounts } from "../scripts/verify-fn-shape.js";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function countsOf(source: string): FnCounts {
	return countViolations(collectViolations(source));
}

describe("collectViolations", () => {
	it("flags functions with more than four parameters", () => {
		const counts = countsOf("export function f(a: string, b: string, c: string, d: string, e: string): void {}\n");
		expect(counts.params).toBe(1);
	});

	it("accepts four parameters", () => {
		expect(countsOf("export function f(a: string, b: string, c: string, d: string): void {}\n").params).toBe(0);
	});

	it("flags explicit any returns but not other annotations", () => {
		expect(countsOf("export function f(): any { return 1; }\n")["return-any"]).toBe(1);
		expect(countsOf("export function f(): unknown { return 1; }\n")["return-any"]).toBe(0);
	});

	it("flags empty catch blocks including comment-only ones", () => {
		expect(countsOf("try { f(); } catch { /* ignored */ }\n")["empty-catch"]).toBe(1);
		expect(countsOf("try { f(); } catch { return; }\n")["empty-catch"]).toBe(0);
	});

	it("flags console.log but not other console methods", () => {
		expect(countsOf('console.log("x");\n')["console-log"]).toBe(1);
		expect(countsOf('console.warn("x");\n')["console-log"]).toBe(0);
	});

	it("skips overload signatures without bodies", () => {
		expect(countsOf("export function f(a: string): void;\nexport function f(a: string): void {}\n").params).toBe(0);
	});
});

describe("compareFnShape", () => {
	const base = { version: 1 as const, rules: { "src/a.ts": { params: 1, "return-any": 0, "empty-catch": 1, "console-log": 0 } } };

	it("fails growth and names the rule", () => {
		const result = compareFnShape({ "src/a.ts": { params: 2, "return-any": 0, "empty-catch": 1, "console-log": 0 } }, base);
		expect(result.ok).toBe(false);
		expect(result.messages.some((m) => m.includes("params 1 → 2"))).toBe(true);
	});

	it("fails files missing from the baseline", () => {
		expect(compareFnShape({ "src/new.ts": { params: 0, "return-any": 0, "empty-catch": 0, "console-log": 0 } }, base).ok).toBe(false);
	});

	it("stays green on deleted files with a stale-until-update note", () => {
		const result = compareFnShape({}, base);
		expect(result.ok).toBe(true);
		expect(result.messages.some((m) => m.includes("PRUNED") && m.includes("src/a.ts"))).toBe(true);
	});

	it("stays green on shrinkage", () => {
		const result = compareFnShape({ "src/a.ts": { params: 0, "return-any": 0, "empty-catch": 1, "console-log": 0 } }, base);
		expect(result.ok).toBe(true);
	});
});

describe("fn-shape fixtures", () => {
	it("is red on the four-rule violation and green on the clean file", () => {
		const evil = readFileSync(join(root, "test/fixtures/gates/fn-shape/violation/evil.ts"), "utf-8");
		const small = readFileSync(join(root, "test/fixtures/gates/fn-shape/clean/small.ts"), "utf-8");
		expect(countViolations(collectViolations(evil))).toEqual({ params: 1, "return-any": 1, "empty-catch": 1, "console-log": 1 });
		expect(countViolations(collectViolations(small))).toEqual({ params: 0, "return-any": 0, "empty-catch": 0, "console-log": 0 });
	});
});
