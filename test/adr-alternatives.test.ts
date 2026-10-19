import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAlternatives } from "../scripts/verify-adr-alternatives.js";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function noteWith(bullets: string): string {
	return `# Agent Note: probe\n\nStatus: proposed\n\n## Problem\n\nX.\n\n## Alternatives considered\n\n${bullets}\n\n## Proposal\n\nY.\n`;
}

describe("checkAlternatives", () => {
	it("fails a missing section", () => {
		expect(checkAlternatives("# T\n").ok).toBe(false);
	});

	it("fails a single bullet", () => {
		const result = checkAlternatives(noteWith("- Rewrite the module now and pay the migration cost today.\n"));
		expect(result.ok).toBe(false);
		expect(result.bullets).toBe(1);
	});

	it("fails two empty shells", () => {
		const result = checkAlternatives(noteWith("- 不适用\n- 无\n"));
		expect(result.ok).toBe(false);
		expect(result.substantive).toBe(0);
	});

	it("fails short bullets", () => {
		const result = checkAlternatives(noteWith("- Keep it.\n- Drop it.\n"));
		expect(result.ok).toBe(false);
	});

	it("passes two substantive bullets", () => {
		const result = checkAlternatives(
			noteWith("- Keep the current shape and accept the drift it keeps causing.\n- Rewrite the module now and pay the migration cost today.\n"),
		);
		expect(result.ok).toBe(true);
		expect(result.substantive).toBe(2);
	});

	it("counts content starting with 无 as substantive", () => {
		const result = checkAlternatives(
			noteWith("- 无法在现有预算内完成，只能推迟到下个版本再做决定。\n- 保持现状并承担漂移面积继续扩大的长期风险。\n"),
		);
		expect(result.ok).toBe(true);
	});

	it("stops at the next section", () => {
		const result = checkAlternatives(noteWith("- Keep the current shape and accept the drift it keeps causing.\n## Decision\n\n- Not a bullet.\n"));
		expect(result.substantive).toBe(1);
		expect(result.ok).toBe(false);
	});
});

describe("adr-alternatives fixtures", () => {
	it("is red on the thin note and green on the full one", () => {
		const bad = readFileSync(join(root, "test/fixtures/gates/adr-alternatives/violation/notes/proposed/bad.md"), "utf-8");
		const good = readFileSync(join(root, "test/fixtures/gates/adr-alternatives/clean/notes/proposed/good.md"), "utf-8");
		expect(checkAlternatives(bad).ok).toBe(false);
		expect(checkAlternatives(good).ok).toBe(true);
	});
});
