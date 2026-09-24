/**
 * Direct-call token ledger tests: provider totals and old-peer fallback,
 * explicit missing usage, strict versioned loading, private file mode,
 * synchronous tail retention, and honest retained-window reporting.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	TOKEN_USAGE_LEDGER_VERSION,
	aggregateTokenUsage,
	appendTokenUsage,
	createTokenUsageObserver,
	exactTokenTotal,
	loadTokenUsage,
	renderTokenUsageReport,
	tokenUsagePath,
	type TokenUsageRecord,
} from "../src/token-usage.js";

function record(overrides: Partial<TokenUsageRecord> = {}): TokenUsageRecord {
	const usage = Object.prototype.hasOwnProperty.call(overrides, "usage")
		? overrides.usage
		: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 7, reasoningTokens: 1 };
	return {
		version: TOKEN_USAGE_LEDGER_VERSION,
		timestamp: "2026-09-24T00:00:00.000Z",
		sessionId: "session-token",
		phase: "review",
		provider: "test-provider",
		model: "test-model",
		outcome: "success",
		usageStatus: "reported",
		...(usage ? { usage } : {}),
		totalSource: usage?.totalTokens !== undefined ? "provider" : "derived",
		...overrides,
	};
}

describe("exactTokenTotal", () => {
	it("uses a provider total including zero", () => {
		expect(exactTokenTotal({ inputTokens: 99, outputTokens: 99, totalTokens: 0 })).toBe(0);
		expect(exactTokenTotal({ inputTokens: 2, outputTokens: 3, totalTokens: 20 })).toBe(20);
	});

	it("derives the old-peer total from disjoint cache-aware buckets without double-counting reasoning", () => {
		expect(exactTokenTotal({ inputTokens: 2, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 7, reasoningTokens: 1 })).toBe(17);
	});
});

describe("token-usage ledger", () => {
	it("persists reported and missing settlements with a 0600 file and strict shape", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-token-usage-"));
		try {
			const target = { baseDir: dir, sessionId: "session-token", retain: 10 };
			appendTokenUsage(target, record());
			appendTokenUsage(target, record({ phase: "planner", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, totalSource: "provider" }));
			const observer = createTokenUsageObserver(target, "fate", "p", "m");
			observer({ outcome: "max-tokens" });
			const loaded = loadTokenUsage(dir);
			expect(loaded.corruptLines).toBe(0);
			expect(loaded.records).toHaveLength(3);
			expect(loaded.records[1]).toMatchObject({ phase: "planner", usageStatus: "reported", usage: { totalTokens: 0 } });
			expect(loaded.records[2]).toMatchObject({ phase: "fate", outcome: "max-tokens", usageStatus: "missing", totalSource: "unavailable" });
			expect(statSync(tokenUsagePath(dir)).mode & 0o777).toBe(0o600);
			expect(() => appendTokenUsage(target, { version: 99 } as unknown as TokenUsageRecord)).toThrow(/invalid token-usage record/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips corrupt and unknown-version lines while retaining valid records", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-token-corrupt-"));
		try {
			appendTokenUsage({ baseDir: dir, sessionId: "s", retain: 10 }, record());
			writeFileSync(tokenUsagePath(dir), `{bad\n${JSON.stringify({ ...record(), version: 99 })}\n`, { encoding: "utf8", flag: "a" });
			const loaded = loadTokenUsage(dir);
			expect(loaded.records).toHaveLength(1);
			expect(loaded.corruptLines).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps only the configured tail across concurrent observer settlements", async () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-token-tail-"));
		try {
			const target = { baseDir: dir, sessionId: "s", retain: 5 };
			await Promise.all(
				Array.from({ length: 20 }, async (_, index) => {
					createTokenUsageObserver(target, "planner", "p", `m-${index}`)({
						usage: { inputTokens: index, outputTokens: 1, totalTokens: index + 1 },
						outcome: "success",
					});
					await Promise.resolve();
				}),
			);
			const loaded = loadTokenUsage(dir);
			expect(loaded.records).toHaveLength(5);
			expect(loaded.records.map((item) => item.model)).toEqual(["m-15", "m-16", "m-17", "m-18", "m-19"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("token-usage aggregation and report", () => {
	it("aggregates only reported usage and labels missing/corrupt coverage", () => {
		const records = [
			record({ phase: "review", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, totalSource: "provider" }),
			record({ phase: "planner", usage: { inputTokens: 4, outputTokens: 6, cacheReadTokens: 8, cacheWriteTokens: 1 }, totalSource: "derived" }),
			record({ phase: "fate", usageStatus: "missing", usage: undefined, totalSource: "unavailable", outcome: "error" }),
		];
		expect(aggregateTokenUsage(records)).toEqual({
			calls: 3,
			reportedCalls: 2,
			missingUsageCalls: 1,
			uncachedInputTokens: 6,
			cacheReadTokens: 8,
			cacheWriteTokens: 1,
			outputTokens: 9,
			reasoningTokens: 0,
			totalTokens: 24,
		});
		const report = renderTokenUsageReport({ records, corruptLines: 1 }, 25).join("\n");
		expect(report).toContain("2 reported usage, 1 missing");
		expect(report).toContain("1 corrupt line(s) ignored");
		expect(report).toContain("exact total:    24 (reported calls only)");
		expect(report).toContain("window: last 25 call(s), not a lifetime total");
		expect(report).toContain("host benchmark subagents");
	});

	it("reports the dedicated memory phase in totals and scope", () => {
		const report = renderTokenUsageReport({
			records: [record({ phase: "memory", usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 }, totalSource: "provider" })],
			corruptLines: 0,
		}, 10).join("\n");
		expect(report).toContain("memory  1 calls · 5 tokens");
		expect(report).toContain("review/memory/planner/wrapup/fate only");
	});

	it("reports an empty retained window with explicit scope", () => {
		const report = renderTokenUsageReport({ records: [], corruptLines: 0 }, 50).join("\n");
		expect(report).toContain("no valid calls in the retained tail");
		expect(report).toContain("per-entry injection cost are excluded");
	});

	it("keeps raw JSONL free of prompt or response text", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-token-private-"));
		try {
			appendTokenUsage({ baseDir: dir, sessionId: "s", retain: 2 }, record());
			const raw = readFileSync(tokenUsagePath(dir), "utf8");
			expect(raw).not.toContain("system prompt");
			expect(raw).not.toContain("assistant text");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
