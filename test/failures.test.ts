/**
 * Tests for failure-signature aggregation (D1 observation layer):
 * classification rules, summary math, and the reviews.jsonl / scoreboard
 * readers.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	classifyFailure,
	collectFailureSummary,
	formatFailureSummary,
	readBenchmarkFailures,
	readReviewFailures,
	summarizeFailures,
	type FailureRecord,
} from "../src/failures.js";

describe("classifyFailure", () => {
	it("classifies known signatures by prefix rules", () => {
		expect(classifyFailure("rubric decrypt failed: bad key")).toBe("rubric-decrypt");
		expect(classifyFailure("executor failed: provider down")).toBe("executor");
		expect(classifyFailure("reviewer failed: crash")).toBe("reviewer");
		expect(classifyFailure("materials changed: case a hash x ≠ reference y")).toBe("material-drift");
		expect(classifyFailure("fate assessment error: boom")).toBe("fate-assessor");
		expect(classifyFailure("gate error: review gate produced no text")).toBe("gate");
		expect(classifyFailure("trajectory unavailable: none")).toBe("trajectory");
		expect(classifyFailure("evolve: LLM output budget exhausted (max-tokens)")).toBe("max-tokens");
		expect(classifyFailure("evolve: LLM call aborted")).toBe("aborted");
		expect(classifyFailure("evolve: LLM call failed: provider 500")).toBe("llm");
	});

	it("falls back to other for unknown text", () => {
		expect(classifyFailure("something unexpected happened")).toBe("other");
		expect(classifyFailure("")).toBe("other");
	});
});

describe("summarizeFailures", () => {
	it("counts by class and source, most frequent first", () => {
		const records: FailureRecord[] = [
			{ source: "review-gate:turn_interval", kind: "gate", message: "gate error" },
			{ source: "review-gate:turn_interval", kind: "gate", message: "gate error" },
			{ source: "benchmark:b1:a", kind: "executor", message: "executor failed" },
		];
		const summary = summarizeFailures(records);
		expect(summary.total).toBe(3);
		expect(Object.entries(summary.byKind)).toEqual([["gate", 2], ["executor", 1]]);
		expect(summary.bySource["review-gate:turn_interval"]).toBe(2);
		expect(summary.bySource["benchmark:b1:a"]).toBe(1);
	});

	it("handles empty input", () => {
		const summary = summarizeFailures([]);
		expect(summary.total).toBe(0);
		expect(summary.byKind).toEqual({});
		expect(summary.bySource).toEqual({});
	});
});

function tmpBase(): string {
	const base = mkdtempSync(join(process.cwd(), "test/.tmp/"));
	return base;
}

function withDir(fn: (base: string) => void): void {
	const base = tmpBase();
	try {
		fn(base);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}

describe("readReviewFailures", () => {
	it("collects only failed records and tolerates corrupt/missing files", () => {
		withDir((base) => {
			// No file yet → empty
			expect(readReviewFailures(base)).toEqual([]);
			const dir = join(base, "evolve");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "reviews.jsonl"),
				[
					JSON.stringify({ timestamp: "t1", sessionId: "s", reason: "turn_interval", outcome: "armed" }),
					JSON.stringify({ timestamp: "t2", sessionId: "s", reason: "turn_interval", outcome: "failed", rationale: "gate error: review gate produced no text" }),
					JSON.stringify({ timestamp: "t3", sessionId: "s", reason: "compact", outcome: "failed", rationale: "trajectory unavailable: broken" }),
					JSON.stringify({ timestamp: "t4", sessionId: "s", reason: "turn_interval", outcome: "declined", rationale: "not useful" }),
					"NOT JSON\n",
				].join("\n"),
				"utf8",
			);
			const records = readReviewFailures(base);
			expect(records).toHaveLength(2);
			expect(records[0]?.kind).toBe("gate");
			expect(records[1]?.kind).toBe("trajectory");
		});
	});
});

describe("readBenchmarkFailures", () => {
	it("collects failed cells across reference and candidates of every benchmark", () => {
		withDir((base) => {
			expect(readBenchmarkFailures(base)).toEqual([]);
			const dir = join(base, "evolve", "benchmarks", "b1");
			
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "scoreboard.json"),
				JSON.stringify({
					reference: { label: "reference", cells: [{ caseId: "a", status: "ok" }, { caseId: "b", status: "failed", notes: "executor failed: timeout" }] },
					candidates: [
						{ label: "cand:r1", cells: [{ caseId: "a", status: "failed", notes: "materials changed: case a hash x ≠ reference y" }] },
						{ label: "cand:r2", cells: [{ caseId: "a", status: "ok" }] },
					],
				}),
				"utf8",
			);
			const records = readBenchmarkFailures(base);
			expect(records).toHaveLength(2);
			expect(records.map((r) => r.kind).sort()).toEqual(["executor", "material-drift"]);
			expect(records[0]?.source).toMatch(/^benchmark:b1:/);
		});
	});

	it("skips benchmarks with corrupt scoreboards", () => {
		withDir((base) => {
			
			mkdirSync(join(base, "evolve", "benchmarks", "bad"), { recursive: true });
			writeFileSync(join(base, "evolve", "benchmarks", "bad", "scoreboard.json"), "{{{{", "utf8");
			expect(readBenchmarkFailures(base)).toEqual([]);
		});
	});
});

describe("integration", () => {
	it("collectFailureSummary combines both sources and renders a report", () => {
		withDir((base) => {
			
			mkdirSync(join(base, "evolve"), { recursive: true });
			writeFileSync(join(base, "evolve", "reviews.jsonl"), JSON.stringify({ outcome: "failed", rationale: "gate error: x", timestamp: "t" }) + "\n", "utf8");
			mkdirSync(join(base, "evolve", "benchmarks", "b2"), { recursive: true });
			writeFileSync(join(base, "evolve", "benchmarks", "b2", "scoreboard.json"), JSON.stringify({ candidates: [{ cells: [{ status: "failed", notes: "reviewer failed: crash" }] }] }), "utf8");
			const { summary } = collectFailureSummary(base);
			expect(summary.total).toBe(2);
			const report = formatFailureSummary(summary);
			expect(report).toContain("failure summary: 2 total");
			expect(report).toContain("gate: 1");
			expect(report).toContain("reviewer: 1");
			expect(report).toContain("by source:");
		});
	});
});