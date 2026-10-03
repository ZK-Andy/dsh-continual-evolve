/**
 * Tests for the moment-driven memory extraction listener: the armed marker,
 * the review-model override parser, the event wiring of registerAutoReview
 * (compaction moment, goal-blocked streak, runtime switch, failure
 * containment), and the extraction phase receipts.
 *
 * Per-turn extraction and the general review/planner/fate phases were
 * removed with the 2026-10-03 B verdict; their tests went with them.
 */
import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
	drainSchedulerOnDispose,
	registerAutoReview,
	resolveSessionCloseDrainMs,
	SESSION_CLOSE_DRAIN_MS_DEFAULT,
} from "../src/listener.js";
import {
	loadGateHarnessView,
	parseReviewModel,
	runMemoryExtractionPhase,
	type AutoReviewConfig,
	type GateState,
} from "../src/extraction-phase.js";
import { createEvolutionEngine } from "../src/service.js";
import { recordDeclinedMemory } from "../src/declines.js";
import { saveHarnessState } from "../src/state.js";
import { storePaths } from "../src/store.js";
import { emptyHarnessState, type HarnessEntry } from "../src/types.js";
import type { Context } from "@deepseek-ai/cordis";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { loadTokenUsage } from "../src/token-usage.js";

function baseConfig(overrides: Partial<AutoReviewConfig> = {}): AutoReviewConfig {
	return {
		maxInputChars: 2000,
		budgetTokens: 512,
		notifyOnAutoReview: false,
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

/** A scripted noop extraction reply. */
const MEMORY_NOOP = JSON.stringify({ summary: "no memory", rationale: "nothing durable", expectedOutcome: "none", edits: [] });

function noopMemoryChunk(text: string): StreamChunk[] {
	return [
		{ type: "block-start", index: 0, blockType: "text" },
		{ type: "text-delta", index: 0, text },
		{ type: "block-end", index: 0, block: { type: "text", text } },
		{ type: "finish", reason: { kind: "stop" } },
	];
}

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
	emit: (event: string, ...payload: unknown[]) => void;
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

/** Fire the compaction moment for one agent. */
function compact(h: ReturnType<typeof wiringHarness>, agent: { id: string }): void {
	h.emit("session/event", { id: agent.id }, { type: "compaction/start" });
}

describe("registerAutoReview wiring", () => {
	it("writes the moment-driven armed marker on registration", () => {
		const h = wiringHarness();
		try {
			const lines = h.reviewsLines();
			expect(lines).toHaveLength(1);
			const record = JSON.parse(lines[0] ?? "{}") as { outcome?: string; rationale?: string };
			expect(record.outcome).toBe("armed");
			expect(record.rationale).toContain("moments=compaction/goal-blocked/session-close-drain/manual-wrapup");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("keeps the listener dormant by default and enables it through runtime.json", async () => {
		const agents = new Map<string, unknown>([[wireAgent.id, wireAgent]]);
		const h = wiringHarness({ config: { enabledByDefault: false }, agents });
		try {
			compact(h, wireAgent);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(h.reviewsLines()).toHaveLength(1);

			const { saveGateRuntime } = await import("../src/runtime.js");
			saveGateRuntime(h.dir, false, true);
			compact(h, wireAgent);
			await vi.waitFor(() => expect(h.reviewsLines()).toHaveLength(2));
			const record = JSON.parse(h.reviewsLines()[1] ?? "{}") as { outcome?: string; reason?: string };
			expect(record.reason).toBe("compact");
			expect(record.outcome).toBe("skipped");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("runs the dedicated memory extraction phase on the compaction moment", async () => {
		let calls = 0;
		const llm = {
			stream: async function* () {
				calls += 1;
				if (calls > 1) throw new Error("no second LLM call is expected on one moment");
				for (const chunk of noopMemoryChunk(MEMORY_NOOP)) yield chunk;
			},
		} as unknown as Context["llm"];
		const events = [{ type: "user/message", seq: 1, data: { content: [{ type: "text", text: "请记住这个约定" }], source: { kind: "user" } } }];
		const agent = {
			id: "session-moment",
			options: { provider: "test-provider", model: "test-model" },
			session: { header: {}, events },
			followup: () => undefined,
		};
		const h = wiringHarness({
			llm,
			agents: new Map<string, unknown>([[agent.id, agent]]),
			sessionQuery: { readSurface: async () => ({ events }) },
			config: { enabledByDefault: false, prefixCacheMode: "off" },
		});
		try {
			const { saveGateRuntime } = await import("../src/runtime.js");
			saveGateRuntime(h.dir, false, true);
			compact(h, agent);
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

	it("records a mechanical skip when the compacted session has no new surface rows", async () => {
		const agents = new Map<string, unknown>([[wireAgent.id, wireAgent]]);
		const h = wiringHarness({ agents });
		try {
			compact(h, wireAgent);
			await vi.waitFor(() => expect(h.reviewsLines().length).toBe(2));
			const record = JSON.parse(h.reviewsLines()[1] ?? "{}") as { outcome?: string; reason?: string; rationale?: string };
			expect(record.outcome).toBe("skipped");
			expect(record.reason).toBe("compact");
			expect(record.rationale).toContain("no-new-events");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("contains snapshot acquisition failure and leaves the cursor retryable", async () => {
		const agents = new Map<string, unknown>([[wireAgent.id, wireAgent]]);
		const h = wiringHarness({ agents, sessionQuery: { readSurface: async () => { throw new Error("surface unavailable"); } } });
		try {
			compact(h, wireAgent);
			await vi.waitFor(() => expect(h.reviewsLines().length).toBe(2));
			const record = JSON.parse(h.reviewsLines()[1] ?? "{}") as { outcome?: string; reason?: string; rationale?: string };
			expect(record.outcome).toBe("failed");
			expect(record.reason).toBe("compact");
			expect(record.rationale).toContain("surface unavailable");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("records exact provider usage for the extraction call", async () => {
		const llm = {
			stream: async function* () {
				const chunks: StreamChunk[] = [
					...noopMemoryChunk(MEMORY_NOOP).slice(0, 3),
					{ type: "usage", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
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
		const h = wiringHarness({
			llm,
			agents: new Map<string, unknown>([[agent.id, agent]]),
			sessionQuery: { readSurface: async () => ({ events }) },
			config: { prefixCacheMode: "off" },
		});
		try {
			compact(h, agent);
			await vi.waitFor(() => expect(loadTokenUsage(h.dir).records).toHaveLength(1));
			expect(loadTokenUsage(h.dir).records).toEqual([
				expect.objectContaining({ phase: "memory", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }),
			]);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("keeps a failed extraction retryable and advances the shared cursor only after recovery", async () => {
		let call = 0;
		const requests: GenerateOptions[] = [];
		const llm = {
			stream: async function* (request: GenerateOptions) {
				requests.push(request);
				call += 1;
				if (call === 1) throw new Error("memory provider unavailable");
				for (const chunk of noopMemoryChunk(MEMORY_NOOP)) yield chunk;
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
			agents: new Map<string, unknown>([[agent.id, agent]]),
			sessionQuery: { readSurface: async () => ({ events }) },
			config: { prefixCacheMode: "off" },
		});
		try {
			compact(h, agent);
			await vi.waitFor(() => expect(h.reviewsLines()).toHaveLength(2));
			expect(JSON.parse(h.reviewsLines()[1] ?? "{}")).toMatchObject({ outcome: "failed" });

			events.push({
				type: "user/message",
				seq: 2,
				data: { content: [{ type: "text", text: "第二条恢复后处理的约定" }], source: { kind: "user" } },
			});
			compact(h, agent);
			await vi.waitFor(() => expect(call).toBe(2));
			expect(JSON.parse(h.reviewsLines()[2] ?? "{}")).toMatchObject({ outcome: "noop" });

			events.push({
				type: "user/message",
				seq: 3,
				data: { content: [{ type: "text", text: "第三条只应出现在已推进游标之后" }], source: { kind: "user" } },
			});
			compact(h, agent);
			await vi.waitFor(() => expect(call).toBe(3));

			const retriedMemoryInput = JSON.stringify(requests[1]?.messages);
			const incrementalMemoryInput = JSON.stringify(requests[2]?.messages);
			expect(retriedMemoryInput).toContain("第一条需要重试的长期约定");
			expect(retriedMemoryInput).toContain("第二条恢复后处理的约定");
			expect(incrementalMemoryInput).toContain("第三条只应出现在已推进游标之后");
			expect(incrementalMemoryInput).not.toContain("第一条需要重试的长期约定");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("isolates memory checkpoints and shutdown across interleaved sessions", async () => {
		const memoryInputs: string[] = [];
		const llm = {
			stream: async function* (request: GenerateOptions) {
				const memory = request.system?.includes("dedicated background memory extraction agent") === true;
				if (memory) {
					memoryInputs.push(JSON.stringify(request.messages));
					for (const chunk of noopMemoryChunk(MEMORY_NOOP)) yield chunk;
					return;
				}
				throw new Error("only the dedicated memory phase may call the model");
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
			agents: new Map<string, unknown>([[agentA.id, agentA], [agentB.id, agentB]]),
			sessionQuery: { readSurface: async (sessionId) => ({ events: sessionId === agentA.id ? aEvents : bEvents }) },
			config: { prefixCacheMode: "off" },
		});
		try {
			compact(h, agentA);
			compact(h, agentB);
			await vi.waitFor(() => expect(memoryInputs).toHaveLength(2));

			aEvents.push({
				type: "user/message",
				seq: 2,
				data: { content: [{ type: "text", text: "A2 第一会话新增证据" }], source: { kind: "user" } },
			});
			compact(h, agentA);
			await vi.waitFor(() => expect(memoryInputs).toHaveLength(3));
			const aRetry = memoryInputs.find((input) => input.includes("A2"));
			expect(aRetry).toContain("A2 第一会话新增证据");
			expect(aRetry).not.toContain("A1 第一会话证据");

			h.emit("agent/disposed", { agent: agentA });
			bEvents.push({
				type: "user/message",
				seq: 2,
				data: { content: [{ type: "text", text: "B2 第二会话在 A dispose 后继续" }], source: { kind: "user" } },
			});
			compact(h, agentB);
			await vi.waitFor(() => expect(memoryInputs).toHaveLength(4));
			const bNext = memoryInputs.find((input) => input.includes("B2"));
			expect(bNext).toContain("B2 第二会话在 A dispose 后继续");
			expect(bNext).not.toContain("B1 第二会话证据");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("keeps malformed approval retryable and does not re-ask after an explicit decline", async () => {
		let asks = 0;
		const userQuestions = {
			ask: async () => {
				asks += 1;
				return asks === 1 ? {} : { answers: [{ id: "approve-global-evolve", selected: ["拒绝"] }] };
			},
		};
		const globalEditReply = JSON.stringify({
			summary: "尝试全局记忆",
			rationale: "用户确认了长期偏好",
			expectedOutcome: "跨会话召回",
			edits: [{
				action: "create",
				kind: "memory",
				targetScope: "global",
				blastRadius: "general",
				title: "长期偏好",
				content: "用户明确要求所有项目都使用 pnpm。",
				metadata: { memoryType: "user" },
			}],
		});
		const llm = {
			stream: async function* () {
				for (const chunk of noopMemoryChunk(globalEditReply)) yield chunk;
			},
		} as unknown as Context["llm"];
		const events: unknown[] = [{
			type: "user/message",
			seq: 1,
			data: { content: [{ type: "text", text: "请记住这个长期偏好" }], source: { kind: "user" } },
		}];
		const agent = { id: "session-approval-cursor", options: { provider: "test-provider", model: "test-model" }, session: { header: {} } };
		const h = wiringHarness({
			llm,
			userQuestions,
			agents: new Map<string, unknown>([[agent.id, agent]]),
			sessionQuery: { readSurface: async () => ({ events }) },
			config: { prefixCacheMode: "off" },
		});
		try {
			compact(h, agent);
			await vi.waitFor(() => expect(asks).toBe(1));
			await vi.waitFor(() => expect(h.reviewsLines()).toHaveLength(2));
			expect(JSON.parse(h.reviewsLines()[1] ?? "{}")).toMatchObject({ outcome: "failed" });

			events.push({
				type: "user/message",
				seq: 2,
				data: { content: [{ type: "text", text: "补充一次但不改变偏好" }], source: { kind: "user" } },
			});
			compact(h, agent);
			await vi.waitFor(() => expect(asks).toBe(2));
			await vi.waitFor(() => expect(h.reviewsLines()).toHaveLength(3));
			expect(JSON.parse(h.reviewsLines()[2] ?? "{}")).toMatchObject({ outcome: "declined", rationale: expect.stringContaining("memory scopes declined") });
			expect(asks).toBe(2);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("reuses a project decline when a later global approval failed on the same boundary", async () => {
		let asks = 0;
		let projectAsks = 0;
		let globalAsks = 0;
		const userQuestions = {
			ask: async (request: { questions: { question: string }[] }) => {
				const question = request.questions[0]?.question ?? "";
				if (question.includes("本项目") || question.includes("project cross-session store")) {
					projectAsks += 1;
					return { answers: [{ id: "approve-global-evolve", selected: ["拒绝"] }] };
				}
				globalAsks += 1;
				asks += 1;
				return asks === 1 ? {} : { answers: [{ id: "approve-global-evolve", selected: ["拒绝"] }] };
			},
		};
		const twoScopeReply = JSON.stringify({
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
		});
		const llm = {
			stream: async function* () {
				for (const chunk of noopMemoryChunk(twoScopeReply)) yield chunk;
			},
		} as unknown as Context["llm"];
		const events: unknown[] = [{
			type: "user/message",
			seq: 1,
			data: { content: [{ type: "text", text: "请记住项目和全局两个事实" }], source: { kind: "user" } },
		}];
		const agent = { id: "session-multi-approval", options: { provider: "test-provider", model: "test-model" }, session: { header: { cwd: "/workspace/memory-project" } } };
		const h = wiringHarness({
			llm,
			userQuestions,
			agents: new Map<string, unknown>([[agent.id, agent]]),
			sessionQuery: { readSurface: async () => ({ events }) },
			config: { prefixCacheMode: "off" },
		});
		try {
			compact(h, agent);
			await vi.waitFor(() => expect(globalAsks).toBe(1));
			await vi.waitFor(() => expect(h.reviewsLines()).toHaveLength(2));
			expect(JSON.parse(h.reviewsLines()[1] ?? "{}")).toMatchObject({ outcome: "failed" });

			compact(h, agent);
			await vi.waitFor(() => expect(globalAsks).toBe(2));
			await vi.waitFor(() => expect(h.reviewsLines()).toHaveLength(3));
			expect(JSON.parse(h.reviewsLines()[2] ?? "{}")).toMatchObject({ outcome: "declined", rationale: expect.stringContaining("memory scopes declined") });
			expect(projectAsks).toBe(1);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("aborts an in-flight memory session on dispose without stopping another session", async () => {
		let aStarted = 0;
		let aAborted = 0;
		let bCalls = 0;
		const llm = {
			stream: async function* (request: GenerateOptions) {
				const body = JSON.stringify(request.messages);
				if (body.includes("A 的挂起记忆任务")) {
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
				bCalls += 1;
				for (const chunk of noopMemoryChunk(MEMORY_NOOP)) yield chunk;
			},
		} as unknown as Context["llm"];
		const aEvents = [{ type: "user/message", data: { content: [{ type: "text", text: "A 的挂起记忆任务" }], source: { kind: "user" } } }];
		const bEvents = [{ type: "user/message", data: { content: [{ type: "text", text: "B 的独立记忆任务" }], source: { kind: "user" } } }];
		const agentA = { id: "session-a-abort", options: { provider: "test-provider", model: "test-model" }, session: { header: {} } };
		const agentB = { id: "session-b-abort", options: { provider: "test-provider", model: "test-model" }, session: { header: {} } };
		const h = wiringHarness({
			llm,
			agents: new Map<string, unknown>([[agentA.id, agentA], [agentB.id, agentB]]),
			sessionQuery: { readSurface: async (sessionId) => ({ events: sessionId === agentA.id ? aEvents : bEvents }) },
			// Bounded drain, fast: the hanging run must abort after ~50ms,
			// not after the 15s production default.
			config: { prefixCacheMode: "off", sessionCloseDrainMs: 50 },
		});
		try {
			compact(h, agentA);
			await vi.waitFor(() => expect(aStarted).toBe(1));
			h.emit("agent/disposed", { agent: agentA });
			await vi.waitFor(() => expect(aAborted).toBe(1));
			await vi.waitFor(() => expect(h.reviewsLines().some((line) => JSON.parse(line).sessionId === agentA.id && JSON.parse(line).outcome === "failed")).toBe(true));

			compact(h, agentB);
			await vi.waitFor(() => expect(bCalls).toBe(1));
			expect(h.reviewsLines().some((line) => JSON.parse(line).sessionId === agentB.id && JSON.parse(line).outcome === "noop")).toBe(true);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("a goal blocked for the configured streak fires one goal_blocked moment and resets", async () => {
		let calls = 0;
		const llm = {
			stream: async function* () {
				calls += 1;
				for (const chunk of noopMemoryChunk(MEMORY_NOOP)) yield chunk;
			},
		} as unknown as Context["llm"];
		const events = [{ type: "user/message", seq: 1, data: { content: [{ type: "text", text: "goal 被阻塞时的会话证据" }], source: { kind: "user" } } }];
		const agent = {
			id: "session-goal-blocked",
			options: { provider: "test-provider", model: "test-model" },
			session: { header: {}, events },
			followup: () => undefined,
		};
		const h = wiringHarness({
			llm,
			agents: new Map<string, unknown>([[agent.id, agent]]),
			sessionQuery: { readSurface: async () => ({ events }) },
			goals: { get: () => ({ phase: "blocked" }) },
			config: { goalBlockedWrapupTurns: 2, prefixCacheMode: "off" },
		});
		try {
			h.emit("agent/status", { agent, status: "idle" });
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(h.reviewsLines()).toHaveLength(1); // streak 1: no moment yet

			h.emit("agent/status", { agent, status: "idle" });
			await vi.waitFor(() => expect(calls).toBe(1));
			await vi.waitFor(() => expect(h.reviewsLines()).toHaveLength(2));
			expect(JSON.parse(h.reviewsLines()[1] ?? "{}")).toMatchObject({ reason: "goal_blocked", outcome: "noop" });

			// a fresh streak must build up again — no immediate re-trigger
			h.emit("agent/status", { agent, status: "idle" });
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(calls).toBe(1);
			expect(h.reviewsLines()).toHaveLength(2);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("a non-blocked goal resets the streak and never fires a moment", async () => {
		const h = wiringHarness({ goals: { get: () => ({ phase: "active" }) }, config: { goalBlockedWrapupTurns: 2 } });
		try {
			h.emit("agent/status", { agent: wireAgent, status: "idle" });
			h.emit("agent/status", { agent: wireAgent, status: "idle" });
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(h.reviewsLines()).toHaveLength(1);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("the goal-blocked moment is disabled at zero", async () => {
		const h = wiringHarness({ goals: { get: () => ({ phase: "blocked" }) }, config: { goalBlockedWrapupTurns: 0 } });
		try {
			for (let i = 0; i < 4; i += 1) h.emit("agent/status", { agent: wireAgent, status: "idle" });
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(h.reviewsLines()).toHaveLength(1);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("compaction triggers extraction unconditionally; cold sessions are ignored", async () => {
		const agents = new Map<string, unknown>([["session-wire", wireAgent]]);
		const h = wiringHarness({ agents });
		try {
			compact(h, wireAgent);
			await vi.waitFor(() => expect(h.reviewsLines().length).toBe(2));
			const record = JSON.parse(h.reviewsLines()[1] ?? "{}") as { reason?: string };
			expect(record.reason).toBe("compact");

			h.emit("session/event", { id: "session-cold" }, { type: "compaction/start" });
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(h.reviewsLines()).toHaveLength(2);
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
			compact(h, wireAgent);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(h.reviewsLines()).toHaveLength(1); // armed marker only
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
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
			turns: 4, completedTurn: 4, memoryDecisions: {}, lastReviewAt: 0, goalBlockStreak: 0,
		} as GateState;
	}

	function snapshot() {
		return {
			sessionId: "session-mem", turn: 4, reason: "compact", cursor: "seq:5", events: [],
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

	it("pre-suppresses checkpoints overlapping declined content without invoking the agent", async () => {
		const h = phaseHarness();
		try {
			recordDeclinedMemory(h.dir, "global", [{
				action: "create",
				title: "输入法环境",
				content: "fcitx5 需要设置 GTK_IM_MODULE 变量为 fcitx。",
			}], "输入法环境");
			const agent = { id: "session-mem", options: {} } as never;
			const eligible = {
				...snapshot(),
				eligible: true,
				trajectory: "今晚又在调输入法环境，fcitx5 需要设置 GTK_IM_MODULE 变量为 fcitx 才能连拼。",
			} as never;
			await runMemoryExtractionPhase(h.ctx, h.engine, agent, baseConfig(), gateState(), eligible, h.record as never);
			expect(h.rows.length).toBe(1);
			expect(h.rows[0]?.outcome).toBe("noop");
			expect(h.rows[0]?.rationale).toContain("pre-suppressed");
			expect(h.infos.some((line) => line.includes("pre-suppressed"))).toBe(true);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
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

describe("registerAutoReview guards", () => {
	it("ignores non-idle statuses and agentless payloads", () => {
		const h = wiringHarness();
		try {
			h.emit("agent/status", { agent: wireAgent, status: "busy" });
			h.emit("agent/status", {});
			h.emit("agent/disposed", {});
			expect(h.reviewsLines()).toHaveLength(1);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("ignores session events that are not compaction starts", () => {
		const h = wiringHarness();
		try {
			h.emit("session/event", { id: "session-wire" }, { type: "other" });
			expect(h.reviewsLines()).toHaveLength(1);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("passes an explicit minUserWords into snapshot capture", async () => {
		const events = [{ type: "user/message", seq: 1, data: { content: [{ type: "text", text: "请记住这个约定" }], source: { kind: "user" } } }];
		const agents = new Map<string, unknown>([[wireAgent.id, wireAgent]]);
		const h = wiringHarness({ agents, sessionQuery: { readSurface: async () => ({ events }) }, config: { memoryMinUserWords: 3 } });
		try {
			compact(h, wireAgent);
			await vi.waitFor(() => expect(h.reviewsLines().length).toBe(2));
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("warns instead of crashing when the audit trail is unwritable", async () => {
		const agents = new Map<string, unknown>([[wireAgent.id, wireAgent]]);
		const h = wiringHarness({ agents });
		try {
			const { chmodSync } = await import("node:fs");
			const reviews = join(h.dir, "evolve", "reviews.jsonl");
			chmodSync(reviews, 0o000);
			try {
				compact(h, wireAgent);
				await vi.waitFor(() => expect(h.warnings.some((w) => w.includes("failed to record"))).toBe(true));
			} finally {
				chmodSync(reviews, 0o644);
			}
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("aborts a scheduled extraction when the gate pauses mid-flight", async () => {
		const agents = new Map<string, unknown>([[wireAgent.id, wireAgent]]);
		const h = wiringHarness({ agents });
		try {
			const { saveGateRuntime } = await import("../src/runtime.js");
			compact(h, wireAgent);
			// Pause synchronously: the async capture/schedule/callback chain
			// observes the paused gate and aborts without recording.
			saveGateRuntime(h.dir, true);
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(h.reviewsLines()).toHaveLength(1);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});
});
