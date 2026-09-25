/**
 * Plan-command token-usage onError containment: the ledger-failure callback
 * built in the plan path is captured from the (mocked) planner call and
 * invoked directly — no filesystem destruction, no timing.
 */
import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import { registerEvolveCommand } from "../src/command.js";
import { createEvolutionEngine } from "../src/service.js";
import type { PlanOptions } from "../src/planner.js";

const stash = vi.hoisted(() => ({
	onError: undefined as ((cause: unknown) => void) | undefined,
}));

vi.mock("../src/planner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/planner.js")>();
	return {
		...actual,
		planWithLlm: async (_ctx: unknown, options: PlanOptions) => {
			stash.onError = options.tokenUsage?.onError;
			return { summary: "nothing to plan", rationale: "empty", expectedOutcome: "no edits", edits: [] };
		},
	};
});

describe("executeEvolveCommand — plan token-usage onError", () => {
	it("captures the ledger-failure callback and contains its failure as a warning", async () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-cmd-plan-onerror-"));
		try {
			const engine = createEvolutionEngine(dir);
			const warnings: string[] = [];
			let handler: ((invocation: CommandInvocation) => Promise<CommandResult>) | undefined;
			const ctx = {
				commands: {
					register: (def: { handler: (invocation: CommandInvocation) => Promise<CommandResult> }) => {
						handler = def.handler;
					},
				},
				get: () => undefined,
				logger: () => ({ info: () => {}, warn: (msg: string) => warnings.push(msg), error: () => {} }),
			} as unknown as Context;
			registerEvolveCommand(ctx, engine, { requireGlobalApproval: false }, { rubricKey: Buffer.alloc(32, 7), autoRollbackOnReject: true });
			if (!handler) throw new Error("evolve command was not registered");
			const result = await handler({ rawInput: "plan", agent: { id: "session-cmd" }, signal: undefined } as never);
			expect(result.kind).toBe("success");
			expect(stash.onError).toBeDefined();
			stash.onError!(new Error("disk full"));
			expect(warnings.some((w) => w.includes("token-usage ledger failed for session-cmd"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
