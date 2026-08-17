/**
 * Tests for structured evolve_complete events (gap C4): event building
 * and reviews.jsonl emission.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildEvolveCompleteEvent, emitEvolveComplete, type EvolveCompleteEvent } from "../src/evolve-event.js";
import type { RefinementResult } from "../src/types.js";

function fakeResult(overrides?: Partial<RefinementResult>): RefinementResult {
	return {
		id: "evolve_test123",
		summary: "test refinement",
		rationale: "r",
		expectedOutcome: "o",
		appliedEdits: [
			{ action: "create", kind: "memory", id: "mem1", title: "M", content: "c", applied: true, path: "general", reference: {}, arguments: {}, metadata: {}, source: "evolve", created_at: "", updated_at: "", version: 1 },
			{ action: "update", kind: "prompt", id: "p1", title: "P", content: "p", applied: false, error: "conflict", path: "general", reference: {}, arguments: {}, metadata: {}, source: "evolve", created_at: "", updated_at: "", version: 1 },
		],
		harnessStatePath: "/tmp/test",
		...overrides,
	};
}

describe("buildEvolveCompleteEvent", () => {
	it("builds a valid event from a refinement result", () => {
		const event = buildEvolveCompleteEvent(fakeResult(), "auto_review:turn_interval", "session-abc");
		expect(event.type).toBe("evolve_complete");
		expect(event.refinementId).toBe("evolve_test123");
		expect(event.summary).toBe("test refinement");
		expect(event.appliedEdits).toBe(1);
		expect(event.failedEdits).toBe(1);
		expect(event.scope).toBe("local");
		expect(event.trigger).toBe("auto_review:turn_interval");
		expect(event.sessionId).toBe("session-abc");
		expect(event.timestamp).toBeTruthy();
		expect(event.edits).toHaveLength(2);
		expect(event.edits[0]?.applied).toBe(true);
		expect(event.edits[1]?.applied).toBe(false);
	});

	it("uses result scope when available", () => {
		const event = buildEvolveCompleteEvent(fakeResult({ scope: "global" }), "manual_tool", "s1");
		expect(event.scope).toBe("global");
	});

	it("defaults scope to local when absent", () => {
		const event = buildEvolveCompleteEvent(fakeResult({ scope: undefined }), "manual_plan", "s1");
		expect(event.scope).toBe("local");
	});
});

describe("emitEvolveComplete", () => {
	it("writes to reviews.jsonl", () => {
		const base = mkdtempSync(join(process.cwd(), "test/.tmp/"));
		try {
			const event = buildEvolveCompleteEvent(fakeResult(), "manual_tool", "session-x");
			emitEvolveComplete(base, event);
			const path = join(base, "evolve", "reviews.jsonl");
			expect(existsSync(path)).toBe(true);
			const line = readFileSync(path, "utf8").trim();
			const parsed = JSON.parse(line) as EvolveCompleteEvent;
			expect(parsed.type).toBe("evolve_complete");
			expect(parsed.refinementId).toBe("evolve_test123");
			expect(parsed.trigger).toBe("manual_tool");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("appends multiple events", () => {
		const base = mkdtempSync(join(process.cwd(), "test/.tmp/"));
		try {
			emitEvolveComplete(base, buildEvolveCompleteEvent(fakeResult({ id: "r1" }), "trigger1", "s1"));
			emitEvolveComplete(base, buildEvolveCompleteEvent(fakeResult({ id: "r2" }), "trigger2", "s2"));
			const lines = readFileSync(join(base, "evolve", "reviews.jsonl"), "utf8").trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(JSON.parse(lines[0] as string).refinementId).toBe("r1");
			expect(JSON.parse(lines[1] as string).refinementId).toBe("r2");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("does not throw on write failure", () => {
		// Write to a path that doesn't exist and can't be created
		expect(() => emitEvolveComplete("/nonexistent/path", buildEvolveCompleteEvent(fakeResult(), "t", "s"))).not.toThrow();
	});
});
