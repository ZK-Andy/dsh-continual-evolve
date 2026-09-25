/**
 * Memory-phase token-usage onError containment: the ledger-failure callback
 * built in runMemoryExtractionPhase is captured from the (mocked) memory
 * agent call and invoked directly — no filesystem destruction, no timing.
 */
import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createEvolutionEngine } from "../src/service.js";
import { runMemoryExtractionPhase } from "../src/auto.js";
import type { AutoReviewConfig, GateState } from "../src/auto.js";
import type { MemoryAgentOptions } from "../src/memory-agent.js";
import type { TurnSnapshot } from "../src/turn-snapshot.js";

const stash = vi.hoisted(() => ({
	onError: undefined as ((cause: unknown) => void) | undefined,
}));

vi.mock("../src/memory-agent.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/memory-agent.js")>();
	return {
		...actual,
		runMemoryAgent: async (_ctx: unknown, options: MemoryAgentOptions) => {
			stash.onError = options.tokenUsage?.onError;
			return {
				proposal: { summary: "nothing durable", rationale: "empty", expectedOutcome: "no edits", edits: [] },
				turns: 1,
				searches: 0,
			};
		},
	};
});

describe("runMemoryExtractionPhase token-usage onError", () => {
	it("captures the ledger-failure callback and contains its failure as a warning", async () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-mem-onerror-"));
		try {
			const engine = createEvolutionEngine(dir);
			const warnings: string[] = [];
			const infos: string[] = [];
			const rows: Array<{ outcome?: string }> = [];
			const ctx = {
				logger: () => ({
					info: (msg: string) => infos.push(msg),
					warn: (msg: string) => warnings.push(msg),
					error: () => {},
				}),
			} as unknown as Context;
			const agent = { id: "session-mem", options: { provider: "test-provider", model: "test-model" } } as unknown as Agent;
			const config: AutoReviewConfig = {
				intervalTurns: 3,
				maxInputChars: 2000,
				budgetTokens: 512,
				notifyOnAutoReview: false,
				localFate: false,
				fateIntervalTurns: 5,
				goalBlockedWrapupTurns: 0,
			};
			const gate: GateState = {
				turns: 4,
				completedTurn: 4,
				lastSnapshotTurn: 4,
				memoryDecisions: {},
				lastReviewAt: 0,
				running: false,
				skillRejects: new Map(),
				lastFateAt: 0,
				fateRejects: new Map(),
				goalBlockStreak: 0,
			};
			const snapshot = {
				sessionId: "session-mem",
				turn: 4,
				reason: "turn_snapshot",
				cursor: "seq:5",
				events: [],
				trajectory: "user researched real error handling notes for the review",
				userText: "user researched real error handling notes for the review",
				sourceSeqs: [],
				maxChars: 100,
				minUserWords: 3,
				eligible: true,
			} as unknown as TurnSnapshot;
			await runMemoryExtractionPhase(ctx, engine, agent, config, gate, snapshot, (entry) => rows.push(entry));

			expect(rows.some((row) => row.outcome === "noop")).toBe(true);
			expect(stash.onError).toBeDefined();
			stash.onError!(new Error("disk full"));
			expect(warnings.some((w) => w.includes("token-usage ledger failed for session-mem"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
