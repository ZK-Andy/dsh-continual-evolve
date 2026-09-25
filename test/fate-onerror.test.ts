/**
 * Fate token-usage onError containment: the ledger-failure callback built in
 * runLocalFatePhase is captured from the (mocked) assessor call and invoked
 * directly — no filesystem destruction, no timing. Driving the real phase
 * with an empty assessment also pins the assessed-audit record.
 */
import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { emptyHarnessState, type HarnessEntry } from "../src/types.js";
import { createEvolutionEngine } from "../src/service.js";
import { saveHarnessState } from "../src/state.js";
import { storePaths } from "../src/store.js";
import { runLocalFatePhase } from "../src/fate.js";
import type { AutoReviewConfig, GateState, ReviewRecord } from "../src/auto.js";

const stash = vi.hoisted(() => ({
	onError: undefined as ((cause: unknown) => void) | undefined,
}));

vi.mock("../src/wrapup.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/wrapup.js")>();
	return {
		...actual,
		assessLocalEntries: async (
			_ctx: unknown,
			_agent: unknown,
			_candidates: unknown,
			opts: { tokenUsage?: { onError?: (cause: unknown) => void } },
		) => {
			stash.onError = opts.tokenUsage?.onError;
			return { rationale: "nothing durable", items: [] };
		},
	};
});

function seedLocal(engine: ReturnType<typeof createEvolutionEngine>, sessionId: string): void {
	const local = emptyHarnessState();
	const entry: HarnessEntry = {
		id: "m1",
		kind: "memory",
		title: "候选条目",
		content: "跨测试稳定的本地候选条目正文。",
		path: "general",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: { memoryType: "reference" },
		source: "evolve",
		created_at: "2026-09-25T00:00:00.000Z",
		updated_at: "2026-09-25T00:00:00.000Z",
		version: 1,
	};
	local.entries.memory["m1"] = entry;
	saveHarnessState(storePaths(engine.baseDir, "local", sessionId).stateDir, local);
}

describe("runLocalFatePhase token-usage onError", () => {
	it("captures the ledger-failure callback and contains its failure as a warning", async () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-fate-onerror-"));
		try {
			const engine = createEvolutionEngine(dir);
			seedLocal(engine, "session-x");
			const warnings: string[] = [];
			const records: Array<Omit<ReviewRecord, "timestamp">> = [];
			const ctx = {
				logger: () => ({ info: () => {}, warn: (msg: string) => warnings.push(msg), error: () => {} }),
			} as unknown as Context;
			const agent = { id: "session-x" } as unknown as Agent;
			const config: AutoReviewConfig = {
				intervalTurns: 6,
				maxInputChars: 40000,
				budgetTokens: 4096,
				notifyOnAutoReview: false,
				localFate: true,
				fateIntervalTurns: 1,
				goalBlockedWrapupTurns: 0,
			};
			const gate: GateState = {
				turns: 6,
				completedTurn: 6,
				lastSnapshotTurn: 6,
				memoryDecisions: {},
				lastReviewAt: 0,
				running: false,
				skillRejects: new Map(),
				lastFateAt: 0,
				fateRejects: new Map(),
				goalBlockStreak: 0,
			};
			await runLocalFatePhase(ctx, engine, agent, config, gate, "turn_snapshot", (entry) => records.push(entry));

			expect(stash.onError).toBeDefined();
			// Empty assessment pins the assessed-audit record on the same path.
			expect(records.some((entry) => entry.outcome === "assessed")).toBe(true);
			stash.onError!(new Error("disk full"));
			expect(warnings.some((w) => w.includes("token-usage ledger failed for session-x"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
