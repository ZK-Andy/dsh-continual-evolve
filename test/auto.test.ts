/**
 * Tests for the gate turn counter, the review-model override parser, the
 * event wiring of registerAutoReview (armed marker, interval check,
 * goal-driven override, compaction trigger, failure containment), and the
 * D3 goal-blocked fate trigger.
 */
import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
	consultSkillEdits,
	drainSchedulerOnDispose,
	loadGateHarnessView,
	isDedicatedMemoryOnlyProposal,
	parseReviewModel,
	registerAutoReview,
	resolveSessionCloseDrainMs,
	runGoalBlockedFate,
	runMemoryExtractionPhase,
	SESSION_CLOSE_DRAIN_MS_DEFAULT,
	SKILL_CONSULT_COOLDOWN_TURNS,
	splitSkillEdits,
	stripDedicatedMemoryEdits,
	type AutoReviewConfig,
	type GateState,
} from "../src/auto.js";
import { createEvolutionEngine } from "../src/service.js";
import { saveHarnessState } from "../src/state.js";
import { storePaths } from "../src/store.js";
import { emptyHarnessState, type HarnessEntry, type RefinementProposal } from "../src/types.js";
import type { Context } from "@deepseek-ai/cordis";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { loadTokenUsage } from "../src/token-usage.js";

function fresh(): GateState {
	return { turns: 0, completedTurn: 0, lastSnapshotTurn: 0, memoryDecisions: {}, lastReviewAt: 0, running: false, skillRejects: new Map(), lastFateAt: 0, fateRejects: new Map(), goalBlockStreak: 0 };
}

function baseConfig(overrides: Partial<AutoReviewConfig> = {}): AutoReviewConfig {
	return {
		intervalTurns: 3,
		maxInputChars: 2000,
		budgetTokens: 512,
		notifyOnAutoReview: false,
		localFate: false,
		fateIntervalTurns: 5,
		goalBlockedWrapupTurns: 0,
		...overrides,
	};
}

function fullEntry(id: string, kind: HarnessEntry["kind"], title: string): HarnessEntry {
	return {
		id,
		kind,
		title,
		content: "body",
		path: "general",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "evolve",
		created_at: "2026-08-14T00:00:00.000Z",
		updated_at: "2026-08-14T00:00:00.000Z",
		version: 1,
	};
}


describe("loadGateHarnessView", () => {
	it("merges global entries into the gate's view with their real scope", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-gateview-"));
		try {
			const engine = createEvolutionEngine(dir);
			const global = emptyHarnessState();
			global.entries.memory["readme"] = fullEntry("readme", "memory", "README upkeep");
			global.entries.memory["readme"].scope = "global";
			saveHarnessState(storePaths(dir, "global", undefined).stateDir, global);

			const local = emptyHarnessState();
			local.entries.memory["lint"] = fullEntry("lint", "memory", "Lint first");
			saveHarnessState(storePaths(dir, "local", "session-gate").stateDir, local);

			const view = loadGateHarnessView(engine, "session-gate");
			expect(view.entries.memory["readme"]?.scope).toBe("global");
			expect(view.entries.memory["lint"]?.scope).toBe("local");
			expect(Object.keys(view.entries.memory)).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps both sides visible on id collision (global keeps the id, local is prefixed)", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-gateview-"));
		try {
			const engine = createEvolutionEngine(dir);
			const global = emptyHarnessState();
			const g = fullEntry("shared", "memory", "Global version");
			g.scope = "global";
			global.entries.memory["shared"] = g;
			saveHarnessState(storePaths(dir, "global", undefined).stateDir, global);

			const local = emptyHarnessState();
			local.entries.memory["shared"] = fullEntry("shared", "memory", "Local version");
			saveHarnessState(storePaths(dir, "local", "session-gate").stateDir, local);

			const view = loadGateHarnessView(engine, "session-gate");
			expect(view.entries.memory["shared"]?.title).toBe("Global version");
			expect(view.entries.memory["local:shared"]?.title).toBe("Local version");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

function proposalWith(edits: RefinementProposal["edits"]): RefinementProposal {
	return { summary: "s", rationale: "r", expectedOutcome: "o", edits };
}

const skillEdit = {
	action: "create",
	kind: "skill" as const,
	title: "会话交接流程",
	content: "# 交接流程\n\nbody",
	skill_kind: "guidance" as const,
};

const memoryEdit = { action: "create", kind: "memory" as const, title: "m", content: "c" };

describe("splitSkillEdits", () => {
	it("separates skill edits from the rest of a proposal", () => {
		const { skillEdits, otherEdits } = splitSkillEdits(proposalWith([skillEdit, memoryEdit]));
		expect(skillEdits).toHaveLength(1);
		expect(skillEdits[0]?.kind).toBe("skill");
		expect(otherEdits).toHaveLength(1);
		expect(otherEdits[0]?.kind).toBe("memory");
	});

	it("handles proposals without skill edits", () => {
		const { skillEdits, otherEdits } = splitSkillEdits(proposalWith([memoryEdit]));
		expect(skillEdits).toHaveLength(0);
		expect(otherEdits).toHaveLength(1);
	});
});

describe("stripDedicatedMemoryEdits", () => {
	it("distinguishes memory-only plans from genuine no-consent plans", () => {
		expect(isDedicatedMemoryOnlyProposal(proposalWith([memoryEdit]))).toBe(true);
		expect(isDedicatedMemoryOnlyProposal(proposalWith([memoryEdit, skillEdit]))).toBe(false);
		expect(isDedicatedMemoryOnlyProposal(proposalWith([skillEdit]))).toBe(false);
		expect(isDedicatedMemoryOnlyProposal(proposalWith([]))).toBe(false);
	});

	it("leaves non-memory proposals unchanged", () => {
		const proposal = proposalWith([skillEdit]);
		expect(stripDedicatedMemoryEdits(proposal)).toBe(proposal);
	});

	it("removes memory edits already owned by the dedicated extractor", () => {
		const stripped = stripDedicatedMemoryEdits(proposalWith([memoryEdit, skillEdit]));
		expect(stripped.edits).toEqual([skillEdit]);
		expect(stripped.summary).toContain("dedicated extractor");
	});
});

function fakeCtx(answer: "固化" | "不固化" | "throw" | "missing"): {
	ctx: Context;
	askCount: () => number;
} {
	let calls = 0;
	const ctx = {
		userQuestions:
			answer === "missing"
				? undefined
				: {
						ask: async () => {
							calls += 1;
							if (answer === "throw") throw new Error("aborted");
							return { answers: [{ id: "evolve-skill-consult", selected: [answer] }] };
						},
					},
	} as unknown as Context;
	return { ctx, askCount: () => calls };
}

const fakeAgent = { id: "session-consult" } as never;

describe("consultSkillEdits", () => {
	it("returns true immediately when there are no skill edits", async () => {
		const { ctx } = fakeCtx("missing");
		expect(await consultSkillEdits(ctx, fakeAgent, [], fresh())).toBe(true);
	});

	it("consents when the user chooses 固化, without recording a rejection", async () => {
		const { ctx, askCount } = fakeCtx("固化");
		const gate = fresh();
		expect(await consultSkillEdits(ctx, fakeAgent, [skillEdit], gate)).toBe(true);
		expect(askCount()).toBe(1);
		expect(gate.skillRejects.size).toBe(0);
	});

	it("declines when the user chooses 不固化 and records the cooldown", async () => {
		const { ctx } = fakeCtx("不固化");
		const gate = fresh();
		expect(await consultSkillEdits(ctx, fakeAgent, [skillEdit], gate)).toBe(false);
		expect(gate.skillRejects.size).toBe(1);
	});

	it("does not re-ask a candidate rejected within the cooldown window", async () => {
		const { ctx, askCount } = fakeCtx("不固化");
		const gate = fresh();
		expect(await consultSkillEdits(ctx, fakeAgent, [skillEdit], gate)).toBe(false);
		expect(askCount()).toBe(1);
		// same candidate again, inside the cooldown: silent skip, no question
		gate.turns = SKILL_CONSULT_COOLDOWN_TURNS - 1;
		expect(await consultSkillEdits(ctx, fakeAgent, [skillEdit], gate)).toBe(false);
		expect(askCount()).toBe(1);
		// after the cooldown elapses the candidate is offered again
		gate.turns = SKILL_CONSULT_COOLDOWN_TURNS + 1;
		expect(await consultSkillEdits(ctx, fakeAgent, [skillEdit], gate)).toBe(false);
		expect(askCount()).toBe(2);
	});

	it("never writes a skill silently without the question service", async () => {
		const { ctx } = fakeCtx("missing");
		expect(await consultSkillEdits(ctx, fakeAgent, [skillEdit], fresh())).toBe(false);
	});

	it("is conservative when the question call fails", async () => {
		const { ctx } = fakeCtx("throw");
		expect(await consultSkillEdits(ctx, fakeAgent, [skillEdit], fresh())).toBe(false);
	});
});

describe("parseReviewModel", () => {
	it("returns undefined for empty overrides", () => {
		expect(parseReviewModel(undefined, "deepseek")).toBeUndefined();
		expect(parseReviewModel("", "deepseek")).toBeUndefined();
		expect(parseReviewModel("   ", "deepseek")).toBeUndefined();
	});

	it("splits an explicit provider/model route", () => {
		expect(parseReviewModel("openai/gpt-mini", "deepseek")).toEqual({ provider: "openai", model: "gpt-mini" });
	});

	it("falls back to the agent provider, then deepseek, for bare model names", () => {
		expect(parseReviewModel("glm-5", "zhipu")).toEqual({ provider: "zhipu", model: "glm-5" });
		expect(parseReviewModel("glm-5", undefined)).toEqual({ provider: "deepseek", model: "glm-5" });
	});
});

/** Wiring harness: captures listeners so tests can fire harness events. */
function wiringHarness(options: {
	goals?: { get(agent: unknown): unknown };
	agents?: Map<string, unknown>;
	llm?: Context["llm"];
	userQuestions?: { ask(request: { questions: { id: string; question: string }[] }): Promise<unknown> };
	sessionQuery?: { readSurface(sessionId: string): Promise<{ events: unknown[] }> };
	config?: Partial<AutoReviewConfig>;
} = {}): {
	dir: string;
	emit: (event: string, payload: unknown) => void;
	warnings: string[];
	infos: string[];
	reviewsLines: () => string[];
} {
	const dir = mkdtempSync(join(tmpdir(), "evolve-autowire-"));
	const engine = createEvolutionEngine(dir);
	const listeners = new Map<string, Array<(payload: unknown) => void>>();
	const warnings: string[] = [];
	const infos: string[] = [];
	const ctx = {
		on: (event: string, fn: (payload: unknown) => void) => {
			const list = listeners.get(event) ?? [];
			list.push(fn);
			listeners.set(event, list);
		},
		logger: () => ({
			warn: (message: string) => warnings.push(message),
			info: (message: string) => infos.push(message),
		}),
		get: (name: string) => (name === "goals" ? options.goals : undefined),
		...(options.llm ? { llm: options.llm } : {}),
		...(options.userQuestions ? { userQuestions: options.userQuestions } : {}),
		...(options.sessionQuery ? { sessionQuery: options.sessionQuery } : {}),
		...(options.agents ? { agents: { get: (id: string) => options.agents?.get(id) } } : {}),
	} as unknown as Context;
	registerAutoReview(ctx, engine, baseConfig(options.config));
	return {
		dir,
		emit: (event, ...payloads) => {
			for (const fn of listeners.get(event) ?? []) fn(...payloads);
		},
		warnings,
		infos,
		reviewsLines: () =>
			existsSync(join(dir, "evolve", "reviews.jsonl"))
				? readFileSync(join(dir, "evolve", "reviews.jsonl"), "utf8").trimEnd().split("\n").filter((l) => l.length > 0)
				: [],
	};
}

const wireAgent = { id: "session-wire" };

describe("registerAutoReview wiring", () => {
	it("writes the armed marker with the configured interval on registration", () => {
		const h = wiringHarness();
		try {
			const lines = h.reviewsLines();
			expect(lines).toHaveLength(1);
			const record = JSON.parse(lines[0] ?? "{}") as { outcome?: string; rationale?: string };
			expect(record.outcome).toBe("armed");
				expect(record.rationale).toContain("per-success-turn snapshots");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("keeps the listener dormant by default and enables it through runtime.json", async () => {
		const events = [{ type: "user/message", seq: 1, data: { content: [{ type: "text", text: "请记住这个约定" }], source: { kind: "user" } } }];
		const h = wiringHarness({ config: { enabledByDefault: false }, sessionQuery: { readSurface: async () => ({ events }) } });
		try {
			h.emit("agent/turn-stopping", { agent: wireAgent, turn: 1 });
			h.emit("agent/status", { agent: wireAgent, status: "idle" });
			await vi.waitFor(() => expect(h.reviewsLines()).toHaveLength(1));

			const { saveGateRuntime } = await import("../src/runtime.js");
			saveGateRuntime(h.dir, false, true);
			h.emit("agent/turn-stopping", { agent: wireAgent, turn: 2 });
			h.emit("agent/status", { agent: wireAgent, status: "idle" });
			await vi.waitFor(() => expect(h.reviewsLines().length).toBe(2));
			expect(JSON.parse(h.reviewsLines()[1] ?? "{}")).toMatchObject({ reason: "turn_snapshot" });
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});
	it("runs only the dedicated memory phase in memory-only mode", async () => {
		let calls = 0;
		const llm = {
			stream: async function* () {
				calls += 1;
				if (calls > 1) throw new Error("generic review/planner must not run in memory-only mode");
				const text = JSON.stringify({ summary: "no memory", rationale: "nothing durable", expectedOutcome: "none", edits: [] });
				const chunks: StreamChunk[] = [
					{ type: "block-start", index: 0, blockType: "text" },
					{ type: "text-delta", index: 0, text },
					{ type: "block-end", index: 0, block: { type: "text", text } },
					{ type: "finish", reason: { kind: "stop" } },
				];
				for (const chunk of chunks) yield chunk;
			},
		} as unknown as Context["llm"];
		const events = [{ type: "user/message", seq: 1, data: { content: [{ type: "text", text: "请记住这个约定" }], source: { kind: "user" } } }];
		const agent = {
			id: "session-memory-only",
			options: { provider: "test-provider", model: "test-model" },
			session: { header: {}, events },
			followup: () => undefined,
		};
		const h = wiringHarness({ llm, sessionQuery: { readSurface: async () => ({ events }) }, config: { enabledByDefault: false, memoryOnly: true } });
		try {
			const { saveGateRuntime } = await import("../src/runtime.js");
			saveGateRuntime(h.dir, false, true);
			h.emit("agent/turn-stopping", { agent, turn: 1 });
			h.emit("agent/status", { agent, status: "idle" });
			await vi.waitFor(() => expect(calls).toBe(1));
			await vi.waitFor(() => expect(loadTokenUsage(h.dir).records).toHaveLength(1));
			expect(loadTokenUsage(h.dir).records[0]).toMatchObject({ phase: "memory" });
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("warns and skips the count when turn-stopping carries no agent", () => {
		const h = wiringHarness();
		try {
			h.emit("agent/turn-stopping", {});
			expect(h.warnings.some((w) => w.includes("missing agent"))).toBe(true);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("records a mechanical skip when a successful turn has no new surface rows", async () => {
		const h = wiringHarness();
		try {
			h.emit("agent/turn-stopping", { agent: wireAgent, turn: 1 });
			h.emit("agent/status", { agent: wireAgent, status: "idle" });
			await vi.waitFor(() => expect(h.reviewsLines().length).toBe(2));
			const record = JSON.parse(h.reviewsLines()[1] ?? "{}") as { outcome?: string; reason?: string; rationale?: string };
			expect(record.outcome).toBe("skipped");
			expect(record.reason).toBe("turn_snapshot");
			expect(record.rationale).toContain("no-new-events");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("contains snapshot acquisition failure and leaves the cursor retryable", async () => {
		const h = wiringHarness({ sessionQuery: { readSurface: async () => { throw new Error("surface unavailable"); } } });
		try {
			h.emit("agent/turn-stopping", { agent: wireAgent, turn: 1 });
			h.emit("agent/status", { agent: wireAgent, status: "idle" });
			await vi.waitFor(() => expect(h.reviewsLines().length).toBe(2));
			const record = JSON.parse(h.reviewsLines()[1] ?? "{}") as { outcome?: string; reason?: string; rationale?: string };
			expect(record.outcome).toBe("failed");
			expect(record.reason).toBe("turn_snapshot");
			expect(record.rationale).toContain("surface unavailable");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("records exact provider usage for memory, review, and planner calls", async () => {
		let call = 0;
		const llm = {
			stream: async function* () {
				call += 1;
				const text = call === 1
					? JSON.stringify({ summary: "no memory", rationale: "nothing durable", expectedOutcome: "none", edits: [] })
					: call === 2
						? JSON.stringify({ shouldRefine: true, rationale: "useful evidence", instructions: "plan nothing" })
						: JSON.stringify({ summary: "no edits", rationale: "already covered", expectedOutcome: "none", edits: [] });
				const chunks: StreamChunk[] = [
					{ type: "block-start", index: 0, blockType: "text" },
					{ type: "text-delta", index: 0, text },
					{ type: "block-end", index: 0, block: { type: "text", text } },
					{ type: "usage", usage: { inputTokens: call * 10, outputTokens: 2, totalTokens: call * 10 + 2 } },
					{ type: "finish", reason: { kind: "stop" } },
				];
				for (const chunk of chunks) yield chunk;
			},
		} as unknown as Context["llm"];
		const events = [{ type: "user/message", seq: 1, data: { content: [{ type: "text", text: "remember this durable fact" }], source: { kind: "user" } } }];
		const agent = {
			id: "session-token",
			options: { provider: "test-provider", model: "test-model" },
			session: { header: {}, events },
			followup: () => undefined,
		};
		const h = wiringHarness({ llm, sessionQuery: { readSurface: async () => ({ events }) } });
		try {
			for (let i = 0; i < 3; i += 1) h.emit("agent/turn-stopping", { agent, turn: i + 1 });
			h.emit("agent/status", { agent, status: "idle" });
			await vi.waitFor(() => expect(loadTokenUsage(h.dir).records).toHaveLength(3));
			expect(loadTokenUsage(h.dir).records).toEqual([
				expect.objectContaining({ phase: "memory", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }),
				expect.objectContaining({ phase: "review", usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 } }),
				expect.objectContaining({ phase: "planner", usage: { inputTokens: 30, outputTokens: 2, totalTokens: 32 } }),
			]);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("does not apply or auto-case a memory-only proposal returned by the general planner", async () => {
		let call = 0;
		const llm = {
			stream: async function* () {
				call += 1;
				const text = call === 1
					? JSON.stringify({ summary: "no memory", rationale: "dedicated phase found none", expectedOutcome: "none", edits: [] })
					: call === 2
						? JSON.stringify({ shouldRefine: true, rationale: "planner test", instructions: "only memory" })
						: JSON.stringify({
								summary: "memory-only general plan",
								rationale: "should already be covered",
								expectedOutcome: "none",
								edits: [{
									action: "create",
									kind: "memory",
									targetScope: "local",
									blastRadius: "session",
									title: "不应由通用 planner 写入",
									content: "这条 memory 归专用 extractor 所有。",
									metadata: { memoryType: "user" },
								}],
							});
				const chunks: StreamChunk[] = [
					{ type: "block-start", index: 0, blockType: "text" },
					{ type: "text-delta", index: 0, text },
					{ type: "block-end", index: 0, block: { type: "text", text } },
					{ type: "finish", reason: { kind: "stop" } },
				];
				for (const chunk of chunks) yield chunk;
			},
		} as unknown as Context["llm"];
		const events = [{ type: "user/message", seq: 1, data: { content: [{ type: "text", text: "触发通用 planner memory-only 输出" }], source: { kind: "user" } } }];
		const agent = {
			id: "session-memory-only-plan",
			options: { provider: "test-provider", model: "test-model" },
			session: { header: {}, events },
			followup: () => undefined,
		};
		const h = wiringHarness({ llm, sessionQuery: { readSurface: async () => ({ events }) }, config: { autoCase: true, prefixCacheMode: "off" } });
		try {
			h.emit("agent/turn-stopping", { agent, turn: 1 });
			h.emit("agent/status", { agent, status: "idle" });
			await vi.waitFor(() => expect(call).toBe(3));
			await vi.waitFor(() => expect(h.reviewsLines()).toHaveLength(3));
			// [armed, memory-noop, review-declined]: the dedicated phase
			// found nothing, then the review declined the stripped plan.
			expect(JSON.parse(h.reviewsLines()[1] ?? "{}")).toMatchObject({ outcome: "noop" });
			expect(JSON.parse(h.reviewsLines()[2] ?? "{}")).toMatchObject({ outcome: "declined" });
			const statePath = join(h.dir, "evolve", "local", agent.id, "harness_state.json");
			const stateText = existsSync(statePath) ? readFileSync(statePath, "utf8") : "";
			expect(stateText).not.toContain("不应由通用 planner 写入");
			expect(existsSync(join(h.dir, "evolve", "benchmarks", "auto_regression"))).toBe(false);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("keeps a failed memory extraction retryable and advances the shared cursor only after recovery", async () => {
		let call = 0;
		const requests: GenerateOptions[] = [];
		const llm = {
			stream: async function* (request: GenerateOptions) {
				requests.push(request);
				call += 1;
				if (call === 1) throw new Error("memory provider unavailable");
				const text = call % 2 === 0
					? JSON.stringify({ summary: "no memory", rationale: "nothing durable", expectedOutcome: "none", edits: [] })
					: JSON.stringify({ shouldRefine: false, rationale: "no general evolution either" });
				const chunks: StreamChunk[] = [
					{ type: "block-start", index: 0, blockType: "text" },
					{ type: "text-delta", index: 0, text },
					{ type: "block-end", index: 0, block: { type: "text", text } },
					{ type: "finish", reason: { kind: "stop" } },
				];
				for (const chunk of chunks) yield chunk;
			},
		} as unknown as Context["llm"];
		const events: unknown[] = [{
			type: "user/message",
			seq: 1,
			data: { content: [{ type: "text", text: "第一条需要重试的长期约定" }], source: { kind: "user" } },
		}];
		const agent = {
			id: "session-memory-retry",
			options: { provider: "test-provider", model: "test-model" },
			session: { header: {}, events },
			followup: () => undefined,
		};
		const h = wiringHarness({
			llm,
			sessionQuery: { readSurface: async () => ({ events }) },
			config: { prefixCacheMode: "off" },
		});
		try {
			h.emit("agent/turn-stopping", { agent, turn: 1 });
			h.emit("agent/status", { agent, status: "idle" });
			await vi.waitFor(() => expect(h.reviewsLines()).toHaveLength(2));
			expect(JSON.parse(h.reviewsLines()[1] ?? "{}")).toMatchObject({ outcome: "failed" });

			events.push({
				type: "user/message",
				seq: 2,
				data: { content: [{ type: "text", text: "第二条恢复后处理的约定" }], source: { kind: "user" } },
			});
			h.emit("agent/turn-stopping", { agent, turn: 2 });
			h.emit("agent/status", { agent, status: "idle" });
			await vi.waitFor(() => expect(call).toBe(3));
			expect(JSON.parse(h.reviewsLines()[2] ?? "{}")).toMatchObject({ outcome: "noop" });
			expect(JSON.parse(h.reviewsLines()[3] ?? "{}")).toMatchObject({ outcome: "declined" });

			events.push({
				type: "user/message",
				seq: 3,
				data: { content: [{ type: "text", text: "第三条只应出现在已推进游标之后" }], source: { kind: "user" } },
			});
			h.emit("agent/turn-stopping", { agent, turn: 3 });
			h.emit("agent/status", { agent, status: "idle" });
			await vi.waitFor(() => expect(call).toBe(5));

			const retriedMemoryInput = JSON.stringify(requests[1]?.messages);
			const incrementalMemoryInput = JSON.stringify(requests[3]?.messages);
			expect(retriedMemoryInput).toContain("第一条需要重试的长期约定");
			expect(retriedMemoryInput).toContain("第二条恢复后处理的约定");
			expect(incrementalMemoryInput).toContain("第三条只应出现在已推进游标之后");
			expect(incrementalMemoryInput).not.toContain("第一条需要重试的长期约定");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("keeps the memory checkpoint independent when a later review attempt fails", async () => {
		const requests: GenerateOptions[] = [];
		let call = 0;
		const llm = {
			stream: async function* (request: GenerateOptions) {
				requests.push(request);
				call += 1;
				if (call === 2) throw new Error("review provider unavailable");
				const text = call % 2 === 1
					? JSON.stringify({ summary: "no memory", rationale: "nothing new", expectedOutcome: "none", edits: [] })
					: JSON.stringify({ shouldRefine: false, rationale: "no general evolution" });
				const chunks: StreamChunk[] = [
					{ type: "block-start", index: 0, blockType: "text" },
					{ type: "text-delta", index: 0, text },
					{ type: "block-end", index: 0, block: { type: "text", text } },
					{ type: "finish", reason: { kind: "stop" } },
				];
				for (const chunk of chunks) yield chunk;
			},
		} as unknown as Context["llm"];
		const events: unknown[] = [{
			type: "user/message",
			data: { content: [{ type: "text", text: "A1 已由 memory 成功处理" }], source: { kind: "user" } },
		}];
		const agent = {
			id: "session-memory-checkpoint",
			options: { provider: "test-provider", model: "test-model" },
			session: { header: {}, events },
			followup: () => undefined,
		};
		const h = wiringHarness({ llm, sessionQuery: { readSurface: async () => ({ events }) }, config: { prefixCacheMode: "off" } });
		try {
			h.emit("agent/turn-stopping", { agent, turn: 1 });
			h.emit("agent/status", { agent, status: "idle" });
			await vi.waitFor(() => expect(call).toBe(2));
			expect(JSON.parse(h.reviewsLines()[1] ?? "{}")).toMatchObject({ outcome: "noop" });
			expect(JSON.parse(h.reviewsLines()[2] ?? "{}")).toMatchObject({ outcome: "failed" });

			events.push({
				type: "user/message",
				data: { content: [{ type: "text", text: "A2 是 review 失败后新增的证据" }], source: { kind: "user" } },
			});
			h.emit("agent/turn-stopping", { agent, turn: 2 });
			h.emit("agent/status", { agent, status: "idle" });
			await vi.waitFor(() => expect(call).toBe(4));

			const retriedMemoryInput = JSON.stringify(requests[2]?.messages);
			expect(retriedMemoryInput).toContain("A2 是 review 失败后新增的证据");
			expect(retriedMemoryInput).not.toContain("A1 已由 memory 成功处理");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("isolates memory checkpoints and shutdown across interleaved sessions", async () => {
		const memoryInputs: string[] = [];
		let aReviews = 0;
		let bReviews = 0;
		const llm = {
			stream: async function* (request: GenerateOptions) {
				const body = JSON.stringify(request.messages);
				const memory = request.system?.includes("dedicated background memory extraction agent") === true;
				let text: string;
				if (memory) {
					memoryInputs.push(body);
					text = JSON.stringify({ summary: "no memory", rationale: "nothing durable", expectedOutcome: "none", edits: [] });
				} else if (body.includes("A1") || body.includes("A2")) {
					aReviews += 1;
					if (aReviews === 1) throw new Error("A review failed");
					text = JSON.stringify({ shouldRefine: false, rationale: "A recovered" });
				} else {
					bReviews += 1;
					text = JSON.stringify({ shouldRefine: false, rationale: "B complete" });
				}
				const chunks: StreamChunk[] = [
					{ type: "block-start", index: 0, blockType: "text" },
					{ type: "text-delta", index: 0, text },
					{ type: "block-end", index: 0, block: { type: "text", text } },
					{ type: "finish", reason: { kind: "stop" } },
				];
				for (const chunk of chunks) yield chunk;
			},
		} as unknown as Context["llm"];
		const aEvents: unknown[] = [{
			type: "user/message",
			seq: 1,
			data: { content: [{ type: "text", text: "A1 第一会话证据" }], source: { kind: "user" } },
		}];
		const bEvents: unknown[] = [{
			type: "user/message",
			seq: 1,
			data: { content: [{ type: "text", text: "B1 第二会话证据" }], source: { kind: "user" } },
		}];
		const agentA = {
			id: "session-a",
			options: { provider: "test-provider", model: "test-model" },
			session: { header: {}, events: aEvents },
			followup: () => undefined,
		};
		const agentB = {
			id: "session-b",
			options: { provider: "test-provider", model: "test-model" },
			session: { header: {}, events: bEvents },
			followup: () => undefined,
		};
		const h = wiringHarness({
			llm,
			sessionQuery: { readSurface: async (sessionId) => ({ events: sessionId === agentA.id ? aEvents : bEvents }) },
			config: { prefixCacheMode: "off" },
		});
		try {
			h.emit("agent/turn-stopping", { agent: agentA, turn: 1 });
			h.emit("agent/turn-stopping", { agent: agentB, turn: 1 });
			h.emit("agent/status", { agent: agentA, status: "idle" });
			h.emit("agent/status", { agent: agentB, status: "idle" });
			await vi.waitFor(() => expect(aReviews).toBe(1));
			await vi.waitFor(() => expect(bReviews).toBe(1));

			aEvents.push({
				type: "user/message",
				seq: 2,
				data: { content: [{ type: "text", text: "A2 第一会话新增证据" }], source: { kind: "user" } },
			});
			h.emit("agent/turn-stopping", { agent: agentA, turn: 2 });
			h.emit("agent/status", { agent: agentA, status: "idle" });
			await vi.waitFor(() => expect(aReviews).toBe(2));
			const aRetry = memoryInputs.find((input) => input.includes("A2"));
			expect(aRetry).toContain("A2 第一会话新增证据");
			expect(aRetry).not.toContain("A1 第一会话证据");

			h.emit("agent/disposed", { agent: agentA });
			bEvents.push({
				type: "user/message",
				seq: 2,
				data: { content: [{ type: "text", text: "B2 第二会话在 A dispose 后继续" }], source: { kind: "user" } },
			});
			h.emit("agent/turn-stopping", { agent: agentB, turn: 2 });
			h.emit("agent/status", { agent: agentB, status: "idle" });
			await vi.waitFor(() => expect(bReviews).toBe(2));
			const bNext = memoryInputs.find((input) => input.includes("B2"));
			expect(bNext).toContain("B2 第二会话在 A dispose 后继续");
			expect(bNext).not.toContain("B1 第二会话证据");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("keeps malformed approval retryable and does not re-ask after an explicit decline", async () => {
		let call = 0;
		let asks = 0;
		const userQuestions = {
			ask: async () => {
				asks += 1;
				return asks === 1 ? {} : { answers: [{ id: "approve-global-evolve", selected: ["拒绝"] }] };
			},
		};
		const llm = {
			stream: async function* (request: GenerateOptions) {
				call += 1;
				const isMemory = request.system?.includes("dedicated background memory extraction agent") === true;
				const text = isMemory
					? JSON.stringify({ summary: "尝试全局记忆", rationale: "用户确认了长期偏好", expectedOutcome: "跨会话召回", edits: [{
						action: "create",
						kind: "memory",
						targetScope: "global",
						blastRadius: "general",
						title: "长期偏好",
						content: "用户明确要求所有项目都使用 pnpm。",
						metadata: { memoryType: "user" },
					}] })
					: JSON.stringify({ shouldRefine: false, rationale: "no general evolution" });
				const chunks: StreamChunk[] = [
					{ type: "block-start", index: 0, blockType: "text" },
					{ type: "text-delta", index: 0, text },
					{ type: "block-end", index: 0, block: { type: "text", text } },
					{ type: "finish", reason: { kind: "stop" } },
				];
				for (const chunk of chunks) yield chunk;
			},
		} as unknown as Context["llm"];
		const events: unknown[] = [{
			type: "user/message",
			seq: 1,
			data: { content: [{ type: "text", text: "请记住这个长期偏好" }], source: { kind: "user" } },
		}];
		const agent = { id: "session-approval-cursor", options: { provider: "test-provider", model: "test-model" }, session: { header: {} } };
		const h = wiringHarness({ llm, userQuestions, sessionQuery: { readSurface: async () => ({ events }) } });
		try {
			h.emit("agent/turn-stopping", { agent, turn: 1 });
			h.emit("agent/status", { agent, status: "idle" });
			await vi.waitFor(() => expect(asks).toBe(1));
			await vi.waitFor(() => expect(h.reviewsLines()).toHaveLength(2));
			expect(JSON.parse(h.reviewsLines()[1] ?? "{}")).toMatchObject({ outcome: "failed" });

			events.push({
				type: "user/message",
				seq: 2,
				data: { content: [{ type: "text", text: "补充一次但不改变偏好" }], source: { kind: "user" } },
			});
			h.emit("agent/turn-stopping", { agent, turn: 2 });
			h.emit("agent/status", { agent, status: "idle" });
			await vi.waitFor(() => expect(asks).toBe(2));
			await vi.waitFor(() => expect(h.reviewsLines()).toHaveLength(4));
			expect(JSON.parse(h.reviewsLines()[2] ?? "{}")).toMatchObject({ outcome: "declined", rationale: expect.stringContaining("memory scopes declined") });
			expect(JSON.parse(h.reviewsLines()[3] ?? "{}")).toMatchObject({ outcome: "declined" });
			expect(asks).toBe(2);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("reuses a project decline when a later global approval failed on the same boundary", async () => {
		let call = 0;
		let projectAsks = 0;
		let globalAsks = 0;
		const userQuestions = {
			ask: async (request: { questions: { question: string }[] }) => {
				const question = request.questions[0]?.question ?? "";
				if (question.includes("本项目")) {
					projectAsks += 1;
					return { answers: [{ id: "approve-global-evolve", selected: ["拒绝"] }] };
				}
				globalAsks += 1;
				return globalAsks === 1 ? {} : { answers: [{ id: "approve-global-evolve", selected: ["拒绝"] }] };
			},
		};
		const llm = {
			stream: async function* (request: GenerateOptions) {
				call += 1;
				const isMemory = request.system?.includes("dedicated background memory extraction agent") === true;
				const text = isMemory
					? JSON.stringify({
							summary: "跨 scope 提案",
							rationale: "需要两个作用域审批",
							expectedOutcome: "完整落地",
							edits: [
								{
									action: "create",
									kind: "memory",
									targetScope: "project",
									blastRadius: "project",
									title: "项目事实",
									content: "Why: 项目有特殊约束。 How to apply: 发布前执行项目门禁。",
									metadata: { memoryType: "project" },
								},
								{
									action: "create",
									kind: "memory",
									targetScope: "global",
									blastRadius: "general",
									title: "全局事实",
									content: "用户确认了跨项目长期偏好。",
									metadata: { memoryType: "user" },
								},
							],
						})
					: JSON.stringify({ shouldRefine: false, rationale: "no general evolution" });
				const chunks: StreamChunk[] = [
					{ type: "block-start", index: 0, blockType: "text" },
					{ type: "text-delta", index: 0, text },
					{ type: "block-end", index: 0, block: { type: "text", text } },
					{ type: "finish", reason: { kind: "stop" } },
				];
				for (const chunk of chunks) yield chunk;
			},
		} as unknown as Context["llm"];
		const events: unknown[] = [{
			type: "user/message",
			seq: 1,
			data: { content: [{ type: "text", text: "请记住项目和全局两个事实" }], source: { kind: "user" } },
		}];
		const agent = { id: "session-multi-approval", options: { provider: "test-provider", model: "test-model" }, session: { header: { cwd: "/workspace/memory-project" } } };
		const h = wiringHarness({ llm, userQuestions, agents: new Map([[agent.id, agent]]), sessionQuery: { readSurface: async () => ({ events }) } });
		try {
			h.emit("agent/turn-stopping", { agent, turn: 1 });
			h.emit("agent/status", { agent, status: "idle" });
			await vi.waitFor(() => expect(globalAsks).toBe(1));
			await vi.waitFor(() => expect(h.reviewsLines()).toHaveLength(2));
			expect(JSON.parse(h.reviewsLines()[1] ?? "{}")).toMatchObject({ outcome: "failed" });

			h.emit("session/event", { id: agent.id }, { type: "compaction/start" });
			await vi.waitFor(() => expect(globalAsks).toBe(2));
			await vi.waitFor(() => expect(h.reviewsLines()).toHaveLength(4));
			expect(JSON.parse(h.reviewsLines()[2] ?? "{}")).toMatchObject({ outcome: "declined", rationale: expect.stringContaining("memory scopes declined") });
			expect(JSON.parse(h.reviewsLines()[3] ?? "{}")).toMatchObject({ outcome: "declined" });
			expect(projectAsks).toBe(1);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("aborts an in-flight memory session on dispose without stopping another session", async () => {
		let aStarted = 0;
		let aAborted = 0;
		let bReviews = 0;
		const llm = {
			stream: async function* (request: GenerateOptions) {
				const body = JSON.stringify(request.messages);
				const isMemory = request.system?.includes("dedicated background memory extraction agent") === true;
				if (isMemory && body.includes("A 的挂起记忆任务")) {
					aStarted += 1;
					await new Promise<void>((resolve) => {
						if (request.signal?.aborted) {
							aAborted += 1;
							resolve();
							return;
						}
						request.signal?.addEventListener("abort", () => {
							aAborted += 1;
							resolve();
						}, { once: true });
					});
					yield { type: "finish", reason: { kind: "aborted", failure: { message: "disposed", code: "aborted" } } } as StreamChunk;
					return;
				}
				const text = isMemory
					? JSON.stringify({ summary: "no memory", rationale: "nothing durable", expectedOutcome: "none", edits: [] })
					: (bReviews += 1, JSON.stringify({ shouldRefine: false, rationale: "B complete" }));
				yield { type: "block-start", index: 0, blockType: "text" } as StreamChunk;
				yield { type: "text-delta", index: 0, text } as StreamChunk;
				yield { type: "block-end", index: 0, block: { type: "text", text } } as StreamChunk;
				yield { type: "finish", reason: { kind: "stop" } } as StreamChunk;
			},
		} as unknown as Context["llm"];
		const aEvents = [{ type: "user/message", data: { content: [{ type: "text", text: "A 的挂起记忆任务" }], source: { kind: "user" } } }];
		const bEvents = [{ type: "user/message", data: { content: [{ type: "text", text: "B 的独立记忆任务" }], source: { kind: "user" } } }];
		const agentA = { id: "session-a-abort", options: { provider: "test-provider", model: "test-model" }, session: { header: {} } };
		const agentB = { id: "session-b-abort", options: { provider: "test-provider", model: "test-model" }, session: { header: {} } };
		const h = wiringHarness({
			llm,
			sessionQuery: { readSurface: async (sessionId) => ({ events: sessionId === agentA.id ? aEvents : bEvents }) },
			// Bounded drain, fast: the hanging run must abort after ~50ms,
			// not after the 15s production default.
			config: { prefixCacheMode: "off", sessionCloseDrainMs: 50 },
		});
		try {
			h.emit("agent/turn-stopping", { agent: agentA, turn: 1 });
			h.emit("agent/status", { agent: agentA, status: "idle" });
			await vi.waitFor(() => expect(aStarted).toBe(1));
			h.emit("agent/disposed", { agent: agentA });
			await vi.waitFor(() => expect(aAborted).toBe(1));
			await vi.waitFor(() => expect(h.reviewsLines().some((line) => JSON.parse(line).sessionId === agentA.id && JSON.parse(line).outcome === "failed")).toBe(true));

			h.emit("agent/turn-stopping", { agent: agentB, turn: 1 });
			h.emit("agent/status", { agent: agentB, status: "idle" });
			await vi.waitFor(() => expect(bReviews).toBe(1));
			expect(h.reviewsLines().some((line) => JSON.parse(line).sessionId === agentB.id && JSON.parse(line).outcome === "declined")).toBe(true);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("runs a successful turn snapshot even when the session goal is active", async () => {
		const h = wiringHarness({ goals: { get: () => ({ phase: "active" }) } });
		try {
			h.emit("agent/turn-stopping", { agent: wireAgent, turn: 1 });
			h.emit("agent/status", { agent: wireAgent, status: "idle" });
			await vi.waitFor(() => expect(h.reviewsLines().length).toBe(2));
			const record = JSON.parse(h.reviewsLines()[1] ?? "{}") as { outcome?: string; reason?: string };
			expect(record.outcome).toBe("skipped");
			expect(record.reason).toBe("turn_snapshot");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("compaction triggers the gate unconditionally; cold sessions are ignored", async () => {
		const agents = new Map<string, unknown>([["session-wire", wireAgent]]);
		const h = wiringHarness({ agents });
		try {
			h.emit("session/event", { id: "session-wire" }, { type: "compaction/start" });
			await vi.waitFor(() => expect(h.reviewsLines().length).toBe(2));
			const record = JSON.parse(h.reviewsLines()[1] ?? "{}") as { reason?: string };
			expect(record.reason).toBe("compact");

			h.emit("session/event", { id: "session-cold" }, { type: "compaction/start" });
			await vi.waitFor(() => expect(true).toBe(true));
			expect(h.reviewsLines()).toHaveLength(2);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("does not add a compaction trigger in memory-only mode", async () => {
		const agents = new Map<string, unknown>([["session-wire", wireAgent]]);
		const h = wiringHarness({ agents, config: { memoryOnly: true } });
		try {
			h.emit("session/event", { id: "session-wire" }, { type: "compaction/start" });
			await vi.waitFor(() => expect(h.reviewsLines()).toHaveLength(1));
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("a paused gate stays dormant on the turn-interval path (no LLM, no record)", async () => {
		const h = wiringHarness();
		try {
			const { saveGateRuntime } = await import("../src/runtime.js");
			saveGateRuntime(h.dir, true);
			h.emit("agent/turn-stopping", { agent: wireAgent, turn: 1 });
			h.emit("agent/turn-stopping", { agent: wireAgent, turn: 2 });
			h.emit("agent/turn-stopping", { agent: wireAgent, turn: 3 });
			h.emit("agent/status", { agent: wireAgent, status: "idle" });
			await vi.waitFor(() => expect(true).toBe(true)); // flush microtasks
			expect(h.reviewsLines()).toHaveLength(1); // armed marker only
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("a paused gate skips even the unconditional compaction run", async () => {
		const agents = new Map<string, unknown>([["session-wire", wireAgent]]);
		const h = wiringHarness({ agents });
		try {
			const { saveGateRuntime } = await import("../src/runtime.js");
			saveGateRuntime(h.dir, true);
			h.emit("session/event", { id: "session-wire" }, { type: "compaction/start" });
			await vi.waitFor(() => expect(true).toBe(true));
			expect(h.reviewsLines()).toHaveLength(1); // armed marker only
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});
});

describe("runGoalBlockedFate (D3)", () => {
	function blockedCtx(): { ctx: Context; infos: string[] } {
		const infos: string[] = [];
		const ctx = {
			logger: () => ({
				warn: () => undefined,
				info: (message: string) => infos.push(message),
			}),
			get: (name: string) => (name === "goals" ? { get: () => ({ phase: "blocked" }) } : undefined),
		} as unknown as Context;
		return { ctx, infos };
	}

	function collector(): (entry: Record<string, unknown>) => void {
		return () => undefined;
	}

	it("returns immediately when the trigger is disabled", async () => {
		const { ctx } = blockedCtx();
		const state = fresh();
		const engine = createEvolutionEngine(mkdtempSync(join(tmpdir(), "evolve-d3-off-")));
		try {
			await runGoalBlockedFate(ctx, engine, wireAgent as never, baseConfig({ goalBlockedWrapupTurns: 0 }), state, "turn_interval", collector());
			expect(state.goalBlockStreak).toBe(0);
			expect(state.turns).toBe(0);
		} finally {
			rmSync(engine.baseDir, { recursive: true, force: true });
		}
	});

	it("a non-blocked goal resets the streak without running fate", async () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-d3-reset-"));
		const engine = createEvolutionEngine(dir);
		const ctx = {
			logger: () => ({ warn: () => undefined, info: () => undefined }),
			get: (name: string) => (name === "goals" ? { get: () => ({ phase: "active" }) } : undefined),
		} as unknown as Context;
		const state = fresh();
		state.goalBlockStreak = 2;
		try {
			await runGoalBlockedFate(ctx, engine, wireAgent as never, baseConfig({ goalBlockedWrapupTurns: 3 }), state, "turn_interval", collector());
			expect(state.goalBlockStreak).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("triggers one fate assessment at the streak threshold and resets", async () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-d3-fire-"));
		const engine = createEvolutionEngine(dir);
		const { ctx, infos } = blockedCtx();
		const config = baseConfig({ goalBlockedWrapupTurns: 3, localFate: true });
		const state = fresh();
		try {
			await runGoalBlockedFate(ctx, engine, wireAgent as never, config, state, "turn_interval", collector());
			await runGoalBlockedFate(ctx, engine, wireAgent as never, config, state, "turn_interval", collector());
			expect(state.goalBlockStreak).toBe(2);
			expect(infos.some((m) => m.includes("goal-blocked trigger"))).toBe(false);

			await runGoalBlockedFate(ctx, engine, wireAgent as never, config, state, "turn_interval", collector());
			expect(state.goalBlockStreak).toBe(0);
			expect(infos.some((m) => m.includes("goal-blocked trigger"))).toBe(true);

			// a fresh streak must build up again — no immediate re-trigger
			await runGoalBlockedFate(ctx, engine, wireAgent as never, config, state, "turn_interval", collector());
			expect(state.goalBlockStreak).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveSessionCloseDrainMs", () => {
	it("defaults, keeps explicit values, and fails back on invalid input", () => {
		expect(resolveSessionCloseDrainMs(undefined)).toBe(SESSION_CLOSE_DRAIN_MS_DEFAULT);
		expect(resolveSessionCloseDrainMs(0)).toBe(0);
		expect(resolveSessionCloseDrainMs(2500)).toBe(2500);
		expect(resolveSessionCloseDrainMs(2500.7)).toBe(2500);
		expect(resolveSessionCloseDrainMs(-5)).toBe(SESSION_CLOSE_DRAIN_MS_DEFAULT);
		expect(resolveSessionCloseDrainMs(Number.NaN)).toBe(SESSION_CLOSE_DRAIN_MS_DEFAULT);
	});
});

describe("drainSchedulerOnDispose", () => {
	it("drains settled work then aborts", async () => {
		const shutdown = vi.fn();
		await drainSchedulerOnDispose({ drain: async () => {}, shutdown }, 1000);
		expect(shutdown).toHaveBeenCalledTimes(1);
	});

	it("aborts immediately when the budget is zero", async () => {
		const drain = vi.fn(async () => {});
		const shutdown = vi.fn();
		await drainSchedulerOnDispose({ drain, shutdown }, 0);
		expect(drain).not.toHaveBeenCalled();
		expect(shutdown).toHaveBeenCalledTimes(1);
	});

	it("times out a stuck drain and still aborts", async () => {
		const shutdown = vi.fn();
		const hanging = new Promise<void>(() => {});
		await drainSchedulerOnDispose({ drain: () => hanging, shutdown }, 20);
		expect(shutdown).toHaveBeenCalledTimes(1);
	});

	it("aborts even when the drain rejects", async () => {
		const shutdown = vi.fn();
		await drainSchedulerOnDispose({ drain: async () => { throw new Error("boom"); }, shutdown }, 1000);
		expect(shutdown).toHaveBeenCalledTimes(1);
	});
});

describe("runMemoryExtractionPhase receipts", () => {
	function phaseHarness() {
		const dir = mkdtempSync(join(tmpdir(), "evolve-memphase-"));
		const engine = createEvolutionEngine(dir);
		const infos: string[] = [];
		const ctx = { logger: () => ({ info: (m: string) => infos.push(m), warn: () => {} }) } as unknown as Context;
		const rows: { outcome?: string; rationale?: string; durationMs?: number; appliedEdits?: number; memoryTurns?: number }[] = [];
		return { dir, engine, ctx, infos, rows, record: (entry: { outcome?: string }) => rows.push(entry) };
	}

	function gateState(): GateState {
		return {
			turns: 4, completedTurn: 4, lastSnapshotTurn: 4, memoryDecisions: {}, lastReviewAt: 0,
			running: false, skillRejects: new Map(), lastFateAt: 0, fateRejects: new Map(), goalBlockStreak: 0,
		} as GateState;
	}

	function snapshot() {
		return {
			sessionId: "session-mem", turn: 4, reason: "turn_snapshot", cursor: "seq:5", events: [],
			trajectory: "", userText: "", sourceSeqs: [], maxChars: 100, minUserWords: 3, eligible: false,
		} as never;
	}

	it("records a noop audit row when the checkpoint slice is ineligible", async () => {
		const h = phaseHarness();
		try {
			const agent = { id: "session-mem", options: {} } as never;
			await runMemoryExtractionPhase(h.ctx, h.engine, agent, baseConfig(), gateState(), snapshot(), h.record as never);
			expect(h.rows.length).toBe(1);
			expect(h.rows[0]?.outcome).toBe("noop");
			expect(h.rows[0]?.appliedEdits).toBe(0);
			expect(typeof h.rows[0]?.durationMs).toBe("number");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("warns instead of crashing when the audit ledger cannot be written", async () => {
		const blocker = join(tmpdir(), `evolve-blocker-${Date.now()}`);
		writeFileSync(blocker, "x");
		try {
			const engine = createEvolutionEngine(blocker);
			const warnings: string[] = [];
			const listeners = new Map<string, Array<(payload: unknown) => void>>();
			const ctx = {
				on: (event: string, fn: (payload: unknown) => void) => {
					listeners.set(event, [...(listeners.get(event) ?? []), fn]);
				},
				logger: () => ({ info: () => {}, warn: (m: string) => warnings.push(m), error: () => {} }),
				sessionQuery: { readSurface: async () => ({ events: [] }) },
			} as unknown as Context;
			registerAutoReview(ctx, engine, baseConfig());
			const agent = { id: "session-mem" } as never;
			for (const fn of listeners.get("agent/turn-stopping") ?? []) fn({ agent, turn: 1 });
			for (const fn of listeners.get("agent/status") ?? []) fn({ agent, status: "idle" });
			// The empty surface records a mechanical skip; the ledger write
			// fails and is contained as a warning with nothing on disk.
			await vi.waitFor(() => expect(warnings.some((w) => w.includes("failed to record auto-review"))).toBe(true));
			expect(existsSync(join(blocker, "evolve", "reviews.jsonl"))).toBe(false);
		} finally {
			rmSync(blocker, { force: true });
		}
	});
});

describe("auto-review failure containment", () => {
	it("aborts quietly when the scheduler shutdown throws (immediate mode)", async () => {
		const shutdown = () => { throw new Error("already torn down"); };
		await expect(drainSchedulerOnDispose({ drain: async () => {}, shutdown }, 0)).resolves.toBeUndefined();
	});

	it("aborts quietly when the scheduler shutdown throws (drain mode)", async () => {
		const shutdown = vi.fn(() => { throw new Error("already torn down"); });
		await drainSchedulerOnDispose({ drain: async () => {}, shutdown }, 1000);
		expect(shutdown).toHaveBeenCalledTimes(1);
	});

	it("warns instead of crashing when the armed marker cannot be written", () => {
		const blocker = join(tmpdir(), `evolve-blocker-${Date.now()}`);
		writeFileSync(blocker, "x");
		try {
			const engine = createEvolutionEngine(blocker);
			const warnings: string[] = [];
			const ctx = {
				on: () => {},
				logger: () => ({ info: () => {}, warn: (m: string) => warnings.push(m), error: () => {} }),
			} as unknown as Context;
			registerAutoReview(ctx, engine, baseConfig());
			expect(warnings.some((w) => w.includes("failed to write armed marker"))).toBe(true);
		} finally {
			rmSync(blocker, { force: true });
		}
	});
});

describe("full-gate review/planner application", () => {
	const gateEvents = [{ type: "user/message", seq: 1, data: { content: [{ type: "text", text: "每周都要做会话交接" }], source: { kind: "user" } } }];

	/** Audit rows only: reviews.jsonl also carries evolve_complete events. */
	function auditRows(h: { reviewsLines: () => string[] }): { outcome?: string }[] {
		return h.reviewsLines().map((line) => JSON.parse(line) as { outcome?: string }).filter((row) => row.outcome !== undefined);
	}

	function gateAgent(id: string, followup: (msg: unknown) => void = () => undefined) {
		return { id, options: { provider: "test-provider", model: "test-model" }, session: { header: {}, events: gateEvents }, followup } as never;
	}

	function scriptedLlm(replies: string[]): { llm: Context["llm"]; calls: () => number } {
		let calls = 0;
		const llm = {
			stream: async function* () {
				const text = replies[Math.min(calls, replies.length - 1)] ?? "";
				calls += 1;
				const chunks: StreamChunk[] = [
					{ type: "block-start", index: 0, blockType: "text" },
					{ type: "text-delta", index: 0, text },
					{ type: "block-end", index: 0, block: { type: "text", text } },
					{ type: "finish", reason: { kind: "stop" } },
				];
				for (const chunk of chunks) yield chunk;
			},
		} as unknown as Context["llm"];
		return { llm, calls: () => calls };
	}

	const SKILL_PLAN = JSON.stringify({
		summary: "session handoff workflow",
		rationale: "the trajectory repeats the handoff routine",
		expectedOutcome: "guidance skill for handoffs",
		edits: [{
			action: "create",
			kind: "skill",
			title: "Session handoff process",
			content: "Run the handoff checklist at session end.",
			skill_kind: "executable",
			reference: { type: "python", import: "handoff", callable: "run" },
			arguments: { scope: { type: "string", required: true, description: "handoff scope" } },
			blastRadius: "session",
			reason: "repeated multi-step workflow with a real trigger",
		}],
	});

	it("withholds skill edits without the question service and captures an auto-case", async () => {
		const { llm } = scriptedLlm([
			JSON.stringify({ summary: "no memory", rationale: "nothing durable", expectedOutcome: "none", edits: [] }),
			JSON.stringify({ shouldRefine: true, rationale: "repeated handoff workflow", instructions: "propose the handoff skill" }),
			SKILL_PLAN,
		]);
		const agent = gateAgent("session-gate-skill");
		const h = wiringHarness({
			llm,
			sessionQuery: { readSurface: async () => ({ events: gateEvents }) },
			config: { autoCase: true, prefixCacheMode: "off" },
		});
		try {
			h.emit("agent/turn-stopping", { agent, turn: 1 });
			h.emit("agent/status", { agent, status: "idle" });
			await vi.waitFor(() => expect(h.reviewsLines()).toHaveLength(3));
			const review = JSON.parse(h.reviewsLines()[2] ?? "{}") as { outcome?: string; rationale?: string };
			expect(review.outcome).toBe("declined");
			expect(review.rationale).toContain("withheld");
			const engine = createEvolutionEngine(h.dir);
			expect(Object.keys(engine.load("local", "session-gate-skill").entries.skill)).toHaveLength(0);
			expect(existsSync(join(h.dir, "evolve", "benchmarks", "auto_regression"))).toBe(true);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("contains an auto-case capture failure instead of breaking the gate", async () => {
		const { llm } = scriptedLlm([
			JSON.stringify({ summary: "no memory", rationale: "nothing durable", expectedOutcome: "none", edits: [] }),
			JSON.stringify({ shouldRefine: true, rationale: "repeated handoff workflow", instructions: "propose the handoff skill" }),
			SKILL_PLAN,
		]);
		const agent = gateAgent("session-gate-autocase");
		const h = wiringHarness({
			llm,
			sessionQuery: { readSurface: async () => ({ events: gateEvents }) },
			config: { autoCase: true, prefixCacheMode: "off" },
		});
		try {
			const { mkdirSync } = await import("node:fs");
			mkdirSync(join(h.dir, "evolve"), { recursive: true });
			writeFileSync(join(h.dir, "evolve", "benchmarks"), "blocker");
			h.emit("agent/turn-stopping", { agent, turn: 1 });
			h.emit("agent/status", { agent, status: "idle" });
			await vi.waitFor(() => expect(auditRows(h)).toHaveLength(3));
			expect(auditRows(h)[2]?.outcome).toBe("declined");
			expect(h.warnings.some((w) => w.includes("auto-case capture failed"))).toBe(true);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("applies consented skill edits locally and notifies the session", async () => {		const { llm } = scriptedLlm([
			JSON.stringify({ summary: "no memory", rationale: "nothing durable", expectedOutcome: "none", edits: [] }),
			JSON.stringify({ shouldRefine: true, rationale: "repeated handoff workflow", instructions: "propose the handoff skill" }),
			SKILL_PLAN,
		]);
		const followedUp: unknown[] = [];
		const agent = gateAgent("session-gate-apply", (msg) => followedUp.push(msg));
		const h = wiringHarness({
			llm,
			sessionQuery: { readSurface: async () => ({ events: gateEvents }) },
			userQuestions: { ask: async () => ({ answers: [{ id: "evolve-skill-consult", selected: ["固化"] }] }) },
			config: { notifyOnAutoReview: true, prefixCacheMode: "off" },
		});
		try {
			h.emit("agent/turn-stopping", { agent, turn: 1 });
			h.emit("agent/status", { agent, status: "idle" });
			await vi.waitFor(() => expect(auditRows(h)).toHaveLength(3));
			const review = auditRows(h)[2] as { outcome?: string };
			expect(review.outcome).toBe("approved");
			const engine = createEvolutionEngine(h.dir);
			expect(Object.keys(engine.load("local", "session-gate-apply").entries.skill)).toHaveLength(1);
			expect(followedUp).toHaveLength(1);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("lands local memory edits from the dedicated phase and notifies on applied", async () => {
		const { llm } = scriptedLlm([
			JSON.stringify({
				summary: "one durable preference",
				rationale: "user repeats the same build command",
				expectedOutcome: "memory saved",
				edits: [{
					action: "create",
					kind: "memory",
					targetScope: "local",
					blastRadius: "session",
					title: "Build command",
					content: "Build with pnpm build. Why: repeated. How to apply: run it.",
					metadata: { memoryType: "project" },
				}],
			}),
			JSON.stringify({ shouldRefine: false, rationale: "memory phase owns this evidence" }),
		]);
		const followedUp: unknown[] = [];
		const agent = gateAgent("session-gate-memory", (msg) => followedUp.push(msg));
		const h = wiringHarness({
			llm,
			sessionQuery: { readSurface: async () => ({ events: gateEvents }) },
			config: { notifyOnAutoReview: true, prefixCacheMode: "off", requireGlobalApproval: false },
		});
		try {
			h.emit("agent/turn-stopping", { agent, turn: 1 });
			h.emit("agent/status", { agent, status: "idle" });
			await vi.waitFor(() => expect(auditRows(h)).toHaveLength(3));
			const rows = auditRows(h);
			expect(rows[1]?.outcome).toBe("applied");
			expect(rows[2]?.outcome).toBe("declined");
			const engine = createEvolutionEngine(h.dir);
			const memories = engine.load("local", "session-gate-memory").entries.memory;
			expect(Object.values(memories).some((entry) => entry.title === "Build command")).toBe(true);
			expect(followedUp).toHaveLength(1);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});
});
