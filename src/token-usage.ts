/**
 * Provider-reported token accounting for plugin-owned direct LLM calls.
 *
 * The review gate, planner, wrap-up command, and local-fate classifier all use
 * the shared `streamText` helper. These calls do not belong to an Agent turn
 * (they pass no sessionId), so the host session token-meter cannot attribute
 * them. This ledger records the exact `TokenUsage` emitted by the adapter at
 * the one shared stream boundary instead.
 *
 * Storage: `<baseDir>/evolve/token-usage.jsonl`. The file contains route and
 * count metadata only — never prompts, responses, or tool arguments — and is
 * trimmed to its dedicated retention budget after each synchronous append.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenUsage } from "@deepseek-ai/dsh-llm";
import type { StreamTextObservation, StreamTextUsageObserver } from "./llm-text.js";
import { EVOLVE_DIR, pruneJsonlFile } from "./store.js";

const TOKEN_USAGE_FILE = "token-usage.jsonl";
export const TOKEN_USAGE_LEDGER_VERSION = 1;

/** Plugin-owned direct call paths represented in the ledger. */
export const TOKEN_USAGE_PHASES = ["review", "planner", "wrapup", "fate"] as const;
export type TokenUsagePhase = (typeof TOKEN_USAGE_PHASES)[number];

/** Whether the provider supplied a usage sample; missing is never treated as zero. */
export type TokenUsageStatus = "reported" | "missing";

/** How the exact full-call total was obtained. */
export type TokenTotalSource = "provider" | "derived" | "unavailable";

/** One retained direct-call observation. */
export interface TokenUsageRecord {
	version: typeof TOKEN_USAGE_LEDGER_VERSION;
	timestamp: string;
	sessionId: string;
	phase: TokenUsagePhase;
	provider: string;
	model: string;
	outcome: StreamTextObservation["outcome"];
	usageStatus: TokenUsageStatus;
	/** Absent exactly when {@link usageStatus} is `missing`. */
	usage?: TokenUsage;
	totalSource: TokenTotalSource;
}

/** Caller-owned destination and failure hook; phase/provider/model are supplied by the call site. */
export interface TokenUsageTarget {
	baseDir: string;
	sessionId: string;
	retain: number;
	onError?: (cause: unknown) => void;
}

/** Loaded retained window plus corrupt-line count for honest coverage reporting. */
export interface LoadedTokenUsage {
	records: TokenUsageRecord[];
	corruptLines: number;
}

/** Aggregate provider-reported buckets over a retained ledger window. */
export interface TokenUsageTotals {
	calls: number;
	reportedCalls: number;
	missingUsageCalls: number;
	uncachedInputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	totalTokens: number;
}

/** Absolute path of the direct-call token ledger. */
export function tokenUsagePath(baseDir: string): string {
	return join(baseDir, EVOLVE_DIR, TOKEN_USAGE_FILE);
}

/** Exact full-call total, with the old-peer fallback only when `totalTokens` is absent. */
export function exactTokenTotal(usage: TokenUsage): number {
	if (usage.totalTokens !== undefined) return usage.totalTokens;
	return usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

/** Build the observer attached to one `streamText` call. Errors are diagnostic-only. */
export function createTokenUsageObserver(
	target: TokenUsageTarget,
	phase: TokenUsagePhase,
	provider: string,
	model: string,
): StreamTextUsageObserver {
	return (observation) => {
		try {
			appendTokenUsage(target, {
				version: TOKEN_USAGE_LEDGER_VERSION,
				timestamp: new Date().toISOString(),
				sessionId: target.sessionId,
				phase,
				provider,
				model,
				outcome: observation.outcome,
				usageStatus: observation.usage ? "reported" : "missing",
				...(observation.usage ? { usage: observation.usage } : {}),
				totalSource: observation.usage
					? observation.usage.totalTokens !== undefined
						? "provider"
						: "derived"
					: "unavailable",
			});
		} catch (cause) {
			target.onError?.(cause);
		}
	};
}

/**
 * Append one call and enforce the dedicated tail budget. Append + conditional
 * prune stay in one synchronous block, so concurrent async callers in one DSH
 * process cannot interleave the read/truncate/write. Multiple DSH processes
 * sharing one baseDir are outside the plugin's storage contract.
 */
export function appendTokenUsage(target: TokenUsageTarget, record: TokenUsageRecord): void {
	if (!isTokenUsageRecord(record)) {
		throw new Error("evolve: refusing to append an invalid token-usage record");
	}
	const dir = join(target.baseDir, EVOLVE_DIR);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(tokenUsagePath(target.baseDir), `${JSON.stringify(record)}\n`, {
		encoding: "utf8",
		flag: "a",
		mode: 0o600,
	});
	pruneJsonlFile(tokenUsagePath(target.baseDir), target.retain);
}

/** Load valid records from the retained ledger; malformed lines never break `/evolve usage`. */
export function loadTokenUsage(baseDir: string): LoadedTokenUsage {
	const path = tokenUsagePath(baseDir);
	if (!existsSync(path)) return { records: [], corruptLines: 0 };
	let lines: string[];
	try {
		lines = readFileSync(path, "utf8").split("\n");
	} catch {
		return { records: [], corruptLines: 0 };
	}
	const records: TokenUsageRecord[] = [];
	let corruptLines = 0;
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (isTokenUsageRecord(parsed)) records.push(parsed);
			else corruptLines += 1;
		} catch {
			corruptLines += 1;
		}
	}
	return { records, corruptLines };
}

/** Sum exact provider-reported buckets without double-counting reasoning or cache fields. */
export function aggregateTokenUsage(records: readonly TokenUsageRecord[]): TokenUsageTotals {
	const totals: TokenUsageTotals = {
		calls: records.length,
		reportedCalls: 0,
		missingUsageCalls: 0,
		uncachedInputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
	};
	for (const record of records) {
		if (record.usageStatus === "missing" || !record.usage) {
			totals.missingUsageCalls += 1;
			continue;
		}
		totals.reportedCalls += 1;
		totals.uncachedInputTokens += record.usage.inputTokens;
		totals.cacheReadTokens += record.usage.cacheReadTokens ?? 0;
		totals.cacheWriteTokens += record.usage.cacheWriteTokens ?? 0;
		totals.outputTokens += record.usage.outputTokens;
		totals.reasoningTokens += record.usage.reasoningTokens ?? 0;
		totals.totalTokens += exactTokenTotal(record.usage);
	}
	return totals;
}

/** Render the human-facing direct-call ledger section. */
export function renderTokenUsageReport(ledger: LoadedTokenUsage, retain: number): string[] {
	const { records, corruptLines } = ledger;
	if (records.length === 0) {
		const corrupt = corruptLines > 0 ? ` ${corruptLines} corrupt line(s) ignored.` : "";
		return [
			`direct LLM token usage: no valid calls in the retained tail.${corrupt}`,
			`window: last ${retain} call(s), not a lifetime total.`,
			"scope: review/planner/wrapup/fate only; host benchmark subagents, their agent-loop calls, and per-entry injection cost are excluded.",
		];
	}
	const totals = aggregateTokenUsage(records);
	const lines = [
		`direct LLM token usage: ${totals.calls} valid calls (${totals.reportedCalls} reported usage, ${totals.missingUsageCalls} missing)${corruptLines > 0 ? `; ${corruptLines} corrupt line(s) ignored` : ""}`,
		`  uncached input: ${totals.uncachedInputTokens}`,
		`  cache read:     ${totals.cacheReadTokens}`,
		`  cache write:    ${totals.cacheWriteTokens}`,
		`  output:         ${totals.outputTokens}`,
		`  reasoning:      ${totals.reasoningTokens}${records.some((record) => record.usageStatus === "reported" && record.usage?.reasoningTokens === undefined) ? " (partial provider reports)" : ""}`,
		`  exact total:    ${totals.totalTokens} (reported calls only)`,
		`window: last ${retain} call(s), not a lifetime total.`,
		"by phase:",
	];
	for (const phase of TOKEN_USAGE_PHASES) {
		const phaseRecords = records.filter((record) => record.phase === phase);
		if (phaseRecords.length === 0) continue;
		const phaseTotals = aggregateTokenUsage(phaseRecords);
		lines.push(`  ${phase.padEnd(7)} ${phaseTotals.calls} calls · ${phaseTotals.totalTokens} tokens`);
	}
	const last = records.at(-1);
	if (last) {
		const lastTotal = last.usage ? exactTokenTotal(last.usage) : "usage unavailable";
		lines.push(
			`last: ${last.phase} ${last.provider}/${last.model} · ${last.outcome} · ${lastTotal} tokens · ${last.timestamp}`,
		);
	}
	lines.push("scope: review/planner/wrapup/fate only; host benchmark subagents, their agent-loop calls, and per-entry injection cost are excluded.");
	return lines;
}

function isTokenUsageRecord(value: unknown): value is TokenUsageRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (
		record["version"] !== TOKEN_USAGE_LEDGER_VERSION ||
		typeof record["timestamp"] !== "string" ||
		typeof record["sessionId"] !== "string" ||
		typeof record["provider"] !== "string" ||
		typeof record["model"] !== "string" ||
		typeof record["outcome"] !== "string" ||
		!TOKEN_USAGE_PHASES.includes(record["phase"] as TokenUsagePhase) ||
		!["success", "max-tokens", "error", "aborted", "empty"].includes(record["outcome"]) ||
		!["reported", "missing"].includes(record["usageStatus"] as TokenUsageStatus) ||
		!["provider", "derived", "unavailable"].includes(record["totalSource"] as TokenTotalSource)
	) {
		return false;
	}
	if (record["usageStatus"] === "missing") {
		return record["usage"] === undefined && record["totalSource"] === "unavailable";
	}
	if (!isTokenUsage(record["usage"])) return false;
	const expectedSource = record["usage"]["totalTokens"] !== undefined ? "provider" : "derived";
	return record["totalSource"] === expectedSource;
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTokenUsage(value: unknown): value is TokenUsage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const usage = value as Record<string, unknown>;
	if (!isCount(usage["inputTokens"]) || !isCount(usage["outputTokens"])) return false;
	for (const key of ["totalTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"]) {
		if (usage[key] !== undefined && !isCount(usage[key])) return false;
	}
	return true;
}
