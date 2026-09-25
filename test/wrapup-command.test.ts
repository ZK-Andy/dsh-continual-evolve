/**
 * Tests for the `/evolve wrapup` subcommand handler (wrapup-command.ts).
 * The LLM classifier is mocked; everything downstream of it — partitioning,
 * approval gating, engine writes (promote/split/archive), and the review
 * guard — runs for real against a tmp harness store.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createEvolutionEngine } from "../src/service.js";
import { executeWrapupCommand } from "../src/wrapup-command.js";
import { PROMOTED_TO_KEY, ARCHIVED_AT_KEY, VALENCE_NEGATIVE_KEY, isArchived } from "../src/types.js";

vi.mock("../src/wrapup.js", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../src/wrapup.js")>();
	return { ...mod, assessLocalEntries: vi.fn() };
});

import { assessLocalEntries } from "../src/wrapup.js";
const assessMock = vi.mocked(assessLocalEntries);

function tmpBase(): string {
	const base = join(process.cwd(), "test/.tmp");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "/"));
}

function agentOf(id: string): Agent {
	return { id, options: { provider: "p", model: "m" } } as unknown as Agent;
}

function invocationOf(agent: Agent) {
	return { agent, signal: undefined } as never;
}

interface Questions {
	answers?: { id: string; selected?: string[] }[];
}

function ctxOf(questions?: Questions) {
	const userQuestions = questions ? { ask: async () => questions } : undefined;
	return { userQuestions, get: () => undefined } as never;
}

/** Seed the local store with one memory entry of the given shape. */
function seedLocal(engine: ReturnType<typeof createEvolutionEngine>, sessionId: string, id: string, metadata: Record<string, unknown> = {}) {
	return engine.apply("local", sessionId, {
		summary: `create ${id}`,
		rationale: "test",
		expectedOutcome: "entry exists",
		edits: [{ action: "create", kind: "memory", id, title: `Entry ${id}`, content: PROMOTABLE_COMMAND_BODY, metadata: { memoryType: "reference", ...metadata } }],
	});
}

const approvedQuestions: Questions = { answers: [{ id: "approve-global-evolve", selected: ["批准"] }] };
const declinedQuestions: Questions = { answers: [{ id: "approve-global-evolve", selected: ["拒绝"] }] };
const archiveConfirmedQuestions: Questions = { answers: [{ id: "evolve-wrapup-archive-review", selected: ["归档"] }] };
const archiveDeclinedQuestions: Questions = { answers: [{ id: "evolve-wrapup-archive-review", selected: ["保留"] }] };

/** Portable fixture body clearing the promotion floor (>=100 chars). */
const PROMOTABLE_COMMAND_BODY =
	"Durable cross-session lesson distilled from this session; portable phrasing with no project-scoped paths or session identifiers inside.";

describe("executeWrapupCommand", () => {
	it("reports nothing to wrap up on an empty local store", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const result = await executeWrapupCommand(ctxOf(), engine, invocationOf(agentOf("session-x")));
			expect(result.kind).toBe("success");
			expect(result.text).toContain("(nothing to wrap up: session-x's local store has no active, un-promoted entries");
			expect(assessMock).not.toHaveBeenCalled();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("promotes with approval: global copy created, local stamped and retired", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			seedLocal(engine, "session-x", "mem_1");
			assessMock.mockResolvedValue({
				rationale: "durable preference",
				items: [{ key: "memory:mem_1", verdict: "promote", reason: "cross-session durable" }],
			});
			const result = await executeWrapupCommand(ctxOf(approvedQuestions), engine, invocationOf(agentOf("session-x")));
			expect(result.kind).toBe("success");
			expect(assessMock).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ id: "session-x" }),
				expect.any(Array),
				expect.objectContaining({
					tokenUsagePhase: "wrapup",
					tokenUsage: expect.objectContaining({ baseDir: base, sessionId: "session-x", retain: engine.retention.tokenUsage }),
				}),
			);
			expect(result.text).toContain("PROMOTE (to global): 1");
			expect(result.text).toMatch(/promoted memory:mem_1 → global:mem_1/);
			const globalEntry = Object.values(engine.load("global", undefined).entries.memory)[0];
			expect(globalEntry?.title).toBe("Entry mem_1");
			const localEntry = engine.load("local", "session-x").entries.memory["mem_1"];
			expect(localEntry?.metadata[PROMOTED_TO_KEY]).toBe(globalEntry?.id);
			expect(isArchived(localEntry!)).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("writes nothing to global when approval is declined", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			seedLocal(engine, "session-x", "mem_1");
			assessMock.mockResolvedValue({
				rationale: "durable preference",
				items: [{ key: "memory:mem_1", verdict: "promote", reason: "cross-session durable" }],
			});
			const result = await executeWrapupCommand(ctxOf(declinedQuestions), engine, invocationOf(agentOf("session-x")));
			expect(result.kind).toBe("success");
			expect(result.text).toContain("global 写入未批准");
			expect(result.text).toContain("整条提升与拆解提升均未写入");
			expect(engine.load("global", undefined).entries.memory["mem_1"]).toBeUndefined();
			// Local stays untouched (not archived, not stamped).
			const localEntry = engine.load("local", "session-x").entries.memory["mem_1"];
			expect(localEntry).toBeDefined();
			expect(isArchived(localEntry!)).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("fails safe when the question service is missing", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			seedLocal(engine, "session-x", "mem_1");
			assessMock.mockResolvedValue({
				rationale: "durable preference",
				items: [{ key: "memory:mem_1", verdict: "promote", reason: "cross-session durable" }],
			});
			const result = await executeWrapupCommand(ctxOf(), engine, invocationOf(agentOf("session-x")));
			expect(result.kind).toBe("success");
			expect(result.text).toContain("global 写入未批准");
			expect(result.text).toContain("require the userQuestions service");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("archives a covered or operational entry silently", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			seedLocal(engine, "session-x", "op_1");
			assessMock.mockResolvedValue({
				rationale: "operational",
				items: [{ key: "memory:op_1", verdict: "archive", reason: "no source, operational" }],
			});
			const result = await executeWrapupCommand(ctxOf(), engine, invocationOf(agentOf("session-x")));
			expect(result.kind).toBe("success");
			expect(result.text).toContain("ARCHIVE: 1");
			expect(result.text).toContain("archived memory:op_1");
			expect(isArchived(engine.load("local", "session-x").entries.memory["op_1"]!)).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("asks before archiving a sourced, uncovered entry and honors the answer", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			seedLocal(engine, "session-x", "sourced_1", { sourceSeqs: [5], sourceSession: "session-x" });
			assessMock.mockResolvedValue({
				rationale: "session-specific",
				items: [{ key: "memory:sourced_1", verdict: "archive", reason: "one-off" }],
			});
			const kept = await executeWrapupCommand(ctxOf(archiveDeclinedQuestions), engine, invocationOf(agentOf("session-x")));
			expect(kept.text).toContain("ARCHIVE (needs review): 1");
			expect(kept.text).toContain("kept memory:sourced_1 — user declined the archive");
			expect(isArchived(engine.load("local", "session-x").entries.memory["sourced_1"]!)).toBe(false);

			const archived = await executeWrapupCommand(ctxOf(archiveConfirmedQuestions), engine, invocationOf(agentOf("session-x")));
			expect(archived.text).toContain("archived memory:sourced_1 (user-confirmed");
			expect(isArchived(engine.load("local", "session-x").entries.memory["sourced_1"]!)).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("keeps a review-archive pending when no question service exists (conservative)", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			seedLocal(engine, "session-x", "sourced_2", { sourceSeqs: [7], sourceSession: "session-x" });
			assessMock.mockResolvedValue({
				rationale: "session-specific",
				items: [{ key: "memory:sourced_2", verdict: "archive", reason: "one-off" }],
			});
			const result = await executeWrapupCommand(ctxOf(), engine, invocationOf(agentOf("session-x")));
			expect(result.text).toContain("kept memory:sourced_2 — archive pending user confirmation (no question service)");
			expect(isArchived(engine.load("local", "session-x").entries.memory["sourced_2"]!)).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("splits on approval: cleaned global part written, original archived", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			seedLocal(engine, "session-x", "mixed_1", { sourceSeqs: [1], sourceSession: "session-x" });
			assessMock.mockResolvedValue({
				rationale: "mixed entry",
				items: [
					{
						key: "memory:mixed_1",
						verdict: "archive",
						reason: "snapshot half",
						promote: { title: "Clean durable vision", content: PROMOTABLE_COMMAND_BODY + " Cleaned durable conclusion." },
					},
				],
			});
			const result = await executeWrapupCommand(ctxOf(approvedQuestions), engine, invocationOf(agentOf("session-x")));
			expect(result.kind).toBe("success");
			expect(result.text).toContain("SPLIT (archive + promote durable part): 1");
			expect(result.text).toMatch(/split memory:mixed_1: promoted cleaned part → global:mixed_1/);
			const globalEntries = Object.values(engine.load("global", undefined).entries.memory);
			expect(globalEntries).toHaveLength(1);
			expect(globalEntries[0]?.title).toBe("Clean durable vision");
			expect(globalEntries[0]?.content).toContain("Cleaned durable conclusion.");
			expect(isArchived(engine.load("local", "session-x").entries.memory["mixed_1"]!)).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("archives the original plain when a split promotion is declined", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			seedLocal(engine, "session-x", "mixed_2", { sourceSeqs: [2], sourceSession: "session-x" });
			assessMock.mockResolvedValue({
				rationale: "mixed entry",
				items: [
					{
						key: "memory:mixed_2",
						verdict: "archive",
						reason: "snapshot half",
						promote: { title: "Clean durable vision", content: PROMOTABLE_COMMAND_BODY + " Cleaned durable conclusion." },
					},
				],
			});
			const result = await executeWrapupCommand(ctxOf(declinedQuestions), engine, invocationOf(agentOf("session-x")));
			expect(result.kind).toBe("success");
			expect(result.text).toContain("promotion not approved — original archived plain");
			expect(engine.load("global", undefined).entries.memory["mixed_2"]).toBeUndefined();
			expect(isArchived(engine.load("local", "session-x").entries.memory["mixed_2"]!)).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("keeps everything when the model says keep", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			seedLocal(engine, "session-x", "keep_1");
			assessMock.mockResolvedValue({
				rationale: "keep all",
				items: [{ key: "memory:keep_1", verdict: "keep", reason: "still relevant" }],
			});
			const result = await executeWrapupCommand(ctxOf(approvedQuestions), engine, invocationOf(agentOf("session-x")));
			expect(result.kind).toBe("success");
			expect(result.text).toContain("KEEP: 1");
			expect(result.text).toContain("(no changes applied — all entries kept)");
			const localEntry = engine.load("local", "session-x").entries.memory["keep_1"];
			expect(localEntry).toBeDefined();
			expect(isArchived(localEntry!)).toBe(false);
			expect(localEntry?.metadata[ARCHIVED_AT_KEY]).toBeUndefined();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("stamps the negative-valence counter on a keep verdict marked contradicted (P1)", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			seedLocal(engine, "session-x", "keep_1");
			assessMock.mockResolvedValue({
				rationale: "user corrected this fact mid-session",
				items: [{ key: "memory:keep_1", verdict: "keep", reason: "still used but contradicted", contradicted: true }],
			});
			const result = await executeWrapupCommand(ctxOf(), engine, invocationOf(agentOf("session-x")));
			expect(result.kind).toBe("success");
			expect(result.text).toContain("contradicted stamp memory:keep_1 → valenceNegative=1");
			const localEntry = engine.load("local", "session-x").entries.memory["keep_1"];
			expect(localEntry?.metadata[VALENCE_NEGATIVE_KEY]).toBe(1);
			expect(isArchived(localEntry!)).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("does not stamp valence when the contradicted flag is absent", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			seedLocal(engine, "session-x", "keep_1");
			assessMock.mockResolvedValue({
				rationale: "keep all",
				items: [{ key: "memory:keep_1", verdict: "keep", reason: "still relevant" }],
			});
			await executeWrapupCommand(ctxOf(), engine, invocationOf(agentOf("session-x")));
			const localEntry = engine.load("local", "session-x").entries.memory["keep_1"];
			expect(localEntry?.metadata[VALENCE_NEGATIVE_KEY]).toBeUndefined();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("contains token-usage ledger failures with a warning (onError)", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			seedLocal(engine, "session-x", "mem_1");
			let onError: ((cause: unknown) => void) | undefined;
			assessMock.mockImplementationOnce(async (_ctx, _agent, _candidates, opts) => {
				onError = (opts?.tokenUsage as { onError?: (cause: unknown) => void } | undefined)?.onError;
				return { rationale: "keep", items: [{ key: "memory:mem_1", verdict: "keep", reason: "still relevant" }] };
			});
			const warnings: string[] = [];
			const ctx = {
				userQuestions: undefined,
				get: () => undefined,
				logger: () => ({ info: () => {}, warn: (msg: string) => warnings.push(msg), error: () => {} }),
			} as never;
			const result = await executeWrapupCommand(ctx, engine, invocationOf(agentOf("session-x")));
			expect(result.kind).toBe("success");
			expect(onError).toBeDefined();
			onError!(new Error("disk full"));
			expect(warnings.some((w) => w.includes("token-usage ledger failed for session-x: disk full"))).toBe(true);
			onError!("string failure");
			expect(warnings.some((w) => w.includes("token-usage ledger failed for session-x: string failure"))).toBe(true);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("reports skipped promotes for ghost keys and globally covered topics", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			seedLocal(engine, "session-x", "dup_1");
			engine.apply(
				"global",
				undefined,
				{
					summary: "seed global duplicate",
					rationale: "test",
					expectedOutcome: "duplicate exists",
					edits: [{ action: "create", kind: "memory", title: "Entry dup_1", content: PROMOTABLE_COMMAND_BODY, metadata: { memoryType: "reference" } }],
				},
				{ scope: "global" },
			);
			assessMock.mockResolvedValue({
				rationale: "mixed",
				items: [
					{ key: "memory:dup_1", verdict: "promote", reason: "durable" },
					{ key: "memory:ghost", verdict: "promote", reason: "model hallucinated" },
				],
			});
			const result = await executeWrapupCommand(ctxOf(), engine, invocationOf(agentOf("session-x")));
			expect(result.kind).toBe("success");
			expect(result.text).toContain("1 covered globally");
			expect(result.text).toContain("- promote skipped: memory:dup_1 — already covered globally");
			expect(result.text).toContain("- promote skipped: memory:ghost — not in the audited candidate list");
			expect(engine.load("global", undefined).entries.memory["dup_1"]).toBeUndefined();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("reports split skips for ghost keys and globally duplicated splits", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			seedLocal(engine, "session-x", "dup_1");
			engine.apply(
				"global",
				undefined,
				{
					summary: "seed global duplicate",
					rationale: "test",
					expectedOutcome: "duplicate exists",
					edits: [{ action: "create", kind: "memory", title: "Entry dup_1", content: PROMOTABLE_COMMAND_BODY, metadata: { memoryType: "reference" } }],
				},
				{ scope: "global" },
			);
			assessMock.mockResolvedValue({
				rationale: "mixed splits",
				items: [
					{ key: "memory:ghost", verdict: "archive", reason: "stale", promote: { title: "Ghost part", content: PROMOTABLE_COMMAND_BODY } },
					{ key: "memory:dup_1", verdict: "archive", reason: "dup", promote: { title: "Entry dup_1", content: PROMOTABLE_COMMAND_BODY } },
				],
			});
			const result = await executeWrapupCommand(ctxOf(), engine, invocationOf(agentOf("session-x")));
			expect(result.kind).toBe("success");
			expect(result.text).toContain("- split skipped: memory:ghost — not in the audited candidate list");
			expect(result.text).toContain("- split skipped: memory:dup_1");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("silently skips ghost archive and keep entries without crashing", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			seedLocal(engine, "session-x", "mem_1");
			assessMock.mockResolvedValue({
				rationale: "ghosts",
				items: [
					{ key: "memory:ghost", verdict: "archive", reason: "stale" },
					{ key: "memory:ghost_keep", verdict: "keep", reason: "x", contradicted: true },
				],
			});
			const result = await executeWrapupCommand(ctxOf(), engine, invocationOf(agentOf("session-x")));
			expect(result.kind).toBe("success");
			expect(result.text).toContain("memory:ghost");
			expect(engine.load("local", "session-x").entries.memory["mem_1"]).toBeDefined();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("reports a string-valued approval failure without throwing", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			seedLocal(engine, "session-x", "mem_1");
			assessMock.mockResolvedValue({
				rationale: "durable preference",
				items: [{ key: "memory:mem_1", verdict: "promote", reason: "cross-session durable" }],
			});
			const ctx = {
				userQuestions: {
					ask: async () => {
						throw "boom-string";
					},
				},
				get: () => undefined,
			} as never;
			const result = await executeWrapupCommand(ctx, engine, invocationOf(agentOf("session-x")));
			expect(result.kind).toBe("success");
			expect(result.text).toContain("global 写入未批准");
			expect(result.text).toContain("boom-string");
			expect(engine.load("global", undefined).entries.memory["mem_1"]).toBeUndefined();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("keeps a review-archive when the question call throws or malforms", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			seedLocal(engine, "session-x", "sourced_3", { sourceSeqs: [9], sourceSession: "session-x" });
			assessMock.mockResolvedValue({
				rationale: "session-specific",
				items: [{ key: "memory:sourced_3", verdict: "archive", reason: "one-off" }],
			});
			const throwing = {
				userQuestions: {
					ask: async () => {
						throw new Error("ask offline");
					},
				},
				get: () => undefined,
			} as never;
			const kept = await executeWrapupCommand(throwing, engine, invocationOf(agentOf("session-x")));
			expect(kept.kind).toBe("success");
			expect(kept.text).toContain("kept memory:sourced_3 — user declined the archive");
			const malformed = {
				userQuestions: { ask: async () => ({}) },
				get: () => undefined,
			} as never;
			const keptAgain = await executeWrapupCommand(malformed, engine, invocationOf(agentOf("session-x")));
			expect(keptAgain.text).toContain("kept memory:sourced_3 — user declined the archive");
			expect(isArchived(engine.load("local", "session-x").entries.memory["sourced_3"]!)).toBe(false);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});