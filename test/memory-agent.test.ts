import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { GenerateOptions, StreamChunk, ToolCallId } from "@deepseek-ai/dsh-llm";
import {
	applyMemoryExtractionProposal,
	buildMemoryManifest,
	formatMemoryManifest,
	MEMORY_AGENT_TOOL_NAMES,
	MEMORY_AGENT_TOOL_SCHEMAS,
	parseMemoryExtractionProposal,
	renderMemoryApprovalDetails,
	runMemoryAgent,
	searchMemoryManifest,
	type MemoryExtractionProposal,
} from "../src/memory-agent.js";
import { createEvolutionEngine } from "../src/service.js";
import { loadTokenUsage } from "../src/token-usage.js";
import { saveHarnessState } from "../src/state.js";
import { storePaths } from "../src/store.js";
import { emptyHarnessState, type HarnessEntry } from "../src/types.js";

function entry(
	id: string,
	scope: HarnessEntry["scope"],
	title: string,
	content: string,
	memoryType: "user" | "feedback" | "project" | "reference" = "user",
): HarnessEntry {
	return {
		id,
		kind: "memory",
		title,
		content,
		path: "general",
		scope,
		reference: {},
		arguments: {},
		metadata: { memoryType },
		source: "evolve",
		created_at: "2026-09-24T00:00:00.000Z",
		updated_at: "2026-09-24T00:00:00.000Z",
		version: 1,
	};
}

function toolCallChunks(
	id: string,
	name: string,
	args: unknown,
	usage?: { inputTokens: number; outputTokens: number },
): StreamChunk[] {
	const toolId = id as ToolCallId;
	const text = JSON.stringify(args);
	return [
		{ type: "block-start", index: 0, blockType: "tool-call" },
		{ type: "tool-call-delta", index: 0, id: toolId, name, argumentsDelta: text },
		{ type: "block-end", index: 0, block: { type: "tool-call", id: toolId, name, arguments: text } },
		...(usage ? [{ type: "usage" as const, usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens } }] : []),
		{ type: "finish", reason: { kind: "tool-calls" } },
	];
}

function multiToolCallChunks(calls: ReadonlyArray<{ id: string; name: string; args: unknown }>): StreamChunk[] {
	const chunks: StreamChunk[] = [];
	calls.forEach((call, index) => {
		const id = call.id as ToolCallId;
		const args = JSON.stringify(call.args);
		chunks.push(
			{ type: "block-start", index, blockType: "tool-call" },
			{ type: "tool-call-delta", index, id, name: call.name, argumentsDelta: args },
			{ type: "block-end", index, block: { type: "tool-call", id, name: call.name, arguments: args } },
		);
	});
	chunks.push({ type: "finish", reason: { kind: "tool-calls" } });
	return chunks;
}

function textChunks(text: string, usage?: { inputTokens: number; outputTokens: number }): StreamChunk[] {
	return [
		{ type: "block-start", index: 0, blockType: "text" },
		{ type: "text-delta", index: 0, text },
		{ type: "block-end", index: 0, block: { type: "text", text } },
		...(usage ? [{ type: "usage" as const, usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens } }] : []),
		{ type: "finish", reason: { kind: "stop" } },
	];
}

function proposal(edits: MemoryExtractionProposal["edits"] = []): MemoryExtractionProposal {
	return { summary: "Memory checkpoint", rationale: "durable evidence", expectedOutcome: "better recall", edits };
}

describe("memory manifest", () => {
	it("indexes and retrieves CJK memory content with stable scope ids", () => {
		const state = emptyHarnessState();
		state.entries.memory["preference"] = entry("preference", "global", "用户偏好 pnpm", "用户明确要求统一使用 pnpm，而不是 npm。", "user");
		state.entries.memory["lesson"] = entry("lesson", "project", "发布前运行类型检查", "Why: 宿主 API 会漂移。 How to apply: 发布前运行 tsc。", "feedback");
		const manifest = buildMemoryManifest(state);

		expect(manifest.map((item) => `${item.scope}:${item.id}`)).toEqual([
			"global:preference",
			"project:lesson",
		]);
		expect(searchMemoryManifest(manifest, "pnpm")[0]?.id).toBe("preference");
		expect(searchMemoryManifest(manifest, "发布 类型检查")[0]?.id).toBe("lesson");
	});
});

describe("parseMemoryExtractionProposal", () => {
	const existing = entry("preference", "global", "用户偏好 pnpm", "用户只使用 pnpm。", "user");

	it("enforces memory-only edits, explicit scope, update-first, and blast radius", () => {
		expect(() => parseMemoryExtractionProposal({
			...proposal([{ action: "create", kind: "prompt" as "memory", targetScope: "local", title: "x", content: "y" }]),
		}, [existing])).toThrow("kind=memory");
		expect(() => parseMemoryExtractionProposal({
			...proposal([{ action: "create", kind: "memory", targetScope: "global", blastRadius: "session", title: "x", content: "y", metadata: { memoryType: "reference" } }]),
		}, [existing])).toThrow("global-scope edit");
		expect(() => parseMemoryExtractionProposal({
			...proposal([{ action: "create", kind: "memory", targetScope: "global", blastRadius: "general", id: "preference", title: "duplicate", content: "duplicate", metadata: { memoryType: "user" } }]),
		}, [existing])).toThrow("use update instead");
		expect(() => parseMemoryExtractionProposal({
			...proposal([{ action: "update", kind: "memory", targetScope: "local", blastRadius: "session", id: "preference", content: "new" }]),
		}, [existing])).toThrow("does not exist in local");
	});

	it("accepts a valid update against the exact manifest scope", () => {
		const parsed = parseMemoryExtractionProposal({
			...proposal([{
				action: "update",
				kind: "memory",
				targetScope: "global",
				blastRadius: "general",
				id: "preference",
				content: "用户只使用 pnpm；这是经确认的长期偏好。",
				reason: "new evidence",
			}]),
		}, [existing]);
		expect(parsed.edits[0]).toMatchObject({ targetScope: "global", id: "preference", kind: "memory" });
	});

	it("rejects engine-owned metadata spoofing and enforces feedback Why/How", () => {
		expect(() => parseMemoryExtractionProposal({
			...proposal([{
				action: "create",
				kind: "memory",
				targetScope: "local",
				blastRadius: "session",
				title: "伪造来源",
				content: "普通事实",
				metadata: { memoryType: "user", sourceSession: "forged" },
			}]),
		}, [])).toThrow("engine-owned or unsupported keys");
		expect(() => parseMemoryExtractionProposal({
			...proposal([{
				action: "create",
				kind: "memory",
				targetScope: "local",
				blastRadius: "session",
				title: "缺结构反馈",
				content: "不要直接跑无关 lint。",
				metadata: { memoryType: "feedback" },
			}]),
		}, [])).toThrow("Why and a How");
		const valid = parseMemoryExtractionProposal({
			...proposal([{
				action: "create",
				kind: "memory",
				targetScope: "local",
				blastRadius: "session",
				title: "有效反馈",
				content: "不要直接跑无关 lint。 Why: 会扩大改动面。 How to apply: 只检查受影响模块。",
				metadata: { memoryType: "feedback" },
			}]),
		}, []);
		expect(valid.edits[0]?.metadata).toEqual({ memoryType: "feedback" });
	});

	it("rejects control characters in newly proposed memory ids", () => {
		expect(() => parseMemoryExtractionProposal({
			...proposal([{
				action: "create",
				kind: "memory",
				targetScope: "local",
				blastRadius: "session",
				id: "safe\n- approved global",
				title: "注入标题",
				content: "正常内容。",
				metadata: { memoryType: "user" },
			}]),
		}, [])).toThrow("unsupported identifier characters");
	});

	it("requires a valid memoryType on creates and updates", () => {
		expect(() => parseMemoryExtractionProposal({
			...proposal([{
				action: "create",
				kind: "memory",
				targetScope: "local",
				blastRadius: "session",
				title: "无类型",
				content: "一条没有召回类型的事实。",
			}]),
		}, [])).toThrow("metadata.memoryType");
		expect(() => parseMemoryExtractionProposal({
			...proposal([{
				action: "create",
				kind: "memory",
				targetScope: "local",
				blastRadius: "session",
				title: "错误类型",
				content: "一条错误召回类型的事实。",
				metadata: { memoryType: "other" },
			}]),
		}, [])).toThrow("metadata.memoryType");
	});
});

describe("runMemoryAgent", () => {
	it("uses only memory_search and memory_propose, carries the tool result, and records both turns", async () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-memory-usage-"));
		try {
			const manifest = [entry("preference", "global", "用户偏好 pnpm", "用户只使用 pnpm。", "user")];
			const requests: GenerateOptions[] = [];
			let call = 0;
			const llm = {
				resolveModelInfo: vi.fn(async () => ({ reasoning: { efforts: [{ id: "off" }, { id: "low" }] } })),
				stream: async function* (request: GenerateOptions) {
					requests.push(request);
					call += 1;
					yield* call === 1
						? toolCallChunks("search-1", "memory_search", { query: "pnpm" }, { inputTokens: 10, outputTokens: 1 })
						: toolCallChunks("propose-1", "memory_propose", proposal([{
								action: "update",
								kind: "memory",
								targetScope: "global",
								blastRadius: "general",
								id: "preference",
								content: "用户只使用 pnpm，这是已确认偏好。",
							}]), { inputTokens: 20, outputTokens: 2 });
				},
			} as unknown as Context["llm"];

			const run = await runMemoryAgent({ llm } as unknown as Context, {
				provider: "test",
				model: "memory-model",
				manifest,
				trajectory: "user: 以后都用 pnpm\nassistant: 已记录",
				tokenUsage: { baseDir: dir, sessionId: "session-memory-usage", retain: 10 },
			});

			expect(run).toMatchObject({ turns: 2, searches: 1 });
			expect(run.proposal.edits[0]).toMatchObject({ kind: "memory", targetScope: "global", id: "preference" });
			expect(requests).toHaveLength(2);
			expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual([...MEMORY_AGENT_TOOL_NAMES]);
			expect(requests[0]?.reasoningEffort).toBe("low");
			expect(requests[1]?.messages.some((message) => message.role === "tool")).toBe(true);
			expect(loadTokenUsage(dir).records).toEqual([
				expect.objectContaining({ phase: "memory", sessionId: "session-memory-usage", provider: "test", model: "memory-model", usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } }),
				expect.objectContaining({ phase: "memory", sessionId: "session-memory-usage", provider: "test", model: "memory-model", usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 } }),
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("denies hallucinated tools without exposing an execution path", async () => {
		let call = 0;
		const llm = {
			stream: async function* () {
				call += 1;
				yield* call === 1
					? toolCallChunks("bad-1", "mcp__network", { url: "https://example.com" })
					: toolCallChunks("propose-1", "memory_propose", proposal());
			},
		} as unknown as Context["llm"];

		const run = await runMemoryAgent({ llm } as unknown as Context, {
			provider: "test",
			model: "memory-model",
			manifest: [],
			trajectory: "user: 一条没有持久价值的消息",
		});
		expect(run.proposal.edits).toEqual([]);
		expect(MEMORY_AGENT_TOOL_SCHEMAS.map((tool) => tool.name)).toEqual(["memory_search", "memory_propose"]);
	});

	it("accepts strict JSON text as a provider fallback and records a missing usage sample", async () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-memory-fallback-"));
		try {
			const llm = {
				stream: async function* () {
					yield* textChunks(JSON.stringify(proposal()));
				},
			} as unknown as Context["llm"];
			const run = await runMemoryAgent({ llm } as unknown as Context, {
				provider: "fallback-provider",
				model: "fallback-model",
				manifest: [],
				trajectory: "user: 没有持久事实",
				tokenUsage: { baseDir: dir, sessionId: "session-fallback", retain: 5 },
			});
			expect(run.proposal.edits).toEqual([]);
			expect(loadTokenUsage(dir).records[0]).toMatchObject({ phase: "memory", usageStatus: "missing", outcome: "success" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns malformed tool arguments to the model and recovers on the next turn", async () => {
		const requests: GenerateOptions[] = [];
		let call = 0;
		const llm = {
			stream: async function* (request: GenerateOptions) {
				requests.push(request);
				call += 1;
				yield* call === 1
					? toolCallChunks("bad-search", "memory_search", { query: "" })
					: toolCallChunks("propose", "memory_propose", proposal());
			},
		} as unknown as Context["llm"];
		const run = await runMemoryAgent({ llm } as unknown as Context, {
			provider: "test",
			model: "memory-model",
			manifest: [],
			trajectory: "user: 尝试一次无效检索",
		});
		expect(run.turns).toBe(2);
		expect(JSON.stringify(requests[1]?.messages)).toContain("tool error: query must be a non-empty string");
	});

	it("accepts multiple memory tool calls from one provider turn", async () => {
		const llm = {
			stream: async function* () {
				yield* multiToolCallChunks([
					{ id: "search", name: "memory_search", args: { query: "pnpm" } },
					{ id: "propose", name: "memory_propose", args: proposal() },
				]);
			},
		} as unknown as Context["llm"];
		const run = await runMemoryAgent({ llm } as unknown as Context, {
			provider: "test",
			model: "memory-model",
			manifest: [],
			trajectory: "user: 同一轮先检索再结束",
		});
		expect(run).toMatchObject({ turns: 1, searches: 1 });
		expect(run.proposal.edits).toEqual([]);
	});

	it("fails after five internal turns when the model never proposes", async () => {
		let calls = 0;
		const llm = {
			stream: async function* () {
				calls += 1;
				yield* toolCallChunks(`search-${calls}`, "memory_search", { query: "still searching" });
			},
		} as unknown as Context["llm"];
		await expect(runMemoryAgent({ llm } as unknown as Context, {
			provider: "test",
			model: "memory-model",
			manifest: [],
			trajectory: "user: 反复检索但不结束",
		})).rejects.toThrow("exhausted 5 internal turns");
		expect(calls).toBe(5);
	});

	it("does not call the provider when the scheduler signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		const llm = {
			stream: async function* () {
				calls += 1;
				yield* textChunks("unreachable");
			},
		} as unknown as Context["llm"];
		await expect(runMemoryAgent({ llm } as unknown as Context, {
			provider: "test",
			model: "memory-model",
			manifest: [],
			trajectory: "user: 已取消",
			signal: controller.signal,
		})).rejects.toThrow();
		expect(calls).toBe(0);
	});

	it("classifies a reasoning-only turn as empty instead of a successful proposal", async () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-memory-reasoning-"));
		try {
			const reasoning: StreamChunk[] = [
				{ type: "block-start", index: 0, blockType: "reasoning" },
				{ type: "reasoning-delta", index: 0, text: "internal only" },
				{ type: "block-end", index: 0, block: { type: "reasoning", text: "internal only" } },
				{ type: "finish", reason: { kind: "stop" } },
			];
			const llm = { stream: async function* () { yield* reasoning; } } as unknown as Context["llm"];
			await expect(runMemoryAgent({ llm } as unknown as Context, {
				provider: "test",
				model: "memory-model",
				manifest: [],
				trajectory: "user: 只返回思考",
				tokenUsage: { baseDir: dir, sessionId: "session-reasoning", retain: 5 },
			})).rejects.toThrow("no model output");
			expect(loadTokenUsage(dir).records[0]).toMatchObject({ phase: "memory", outcome: "empty" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("surfaces provider max-tokens as a retryable extraction failure", async () => {
		const llm = {
			stream: async function* () {
				yield { type: "finish", reason: { kind: "max-tokens" } } as StreamChunk;
			},
		} as unknown as Context["llm"];
		await expect(runMemoryAgent({ llm } as unknown as Context, {
			provider: "test",
			model: "memory-model",
			manifest: [],
			trajectory: "user: 触发输出预算耗尽",
		})).rejects.toThrow("output budget exhausted");
	});
});

describe("renderMemoryApprovalDetails", () => {
	it("shows authoritative actions, content, and similarity warnings with a hard bound", () => {
		const state = emptyHarnessState();
		state.entries.memory["existing"] = entry("existing", "global", "用户偏好 pnpm", "用户只使用 pnpm。", "user");
		const text = renderMemoryApprovalDetails(proposal([{
			action: "create",
			kind: "memory",
			targetScope: "global",
			blastRadius: "general",
			title: "用户偏好 pnpm",
			content: "用户在所有项目中都要求使用 pnpm 而不是 npm。",
			metadata: { memoryType: "user" },
		}]), "global", state, 320);
		expect(text).toContain("model summary (untrusted)");
		expect(text).toContain("create global:(new)");
		expect(text).toContain("content=用户在所有项目中都要求使用 pnpm");
		expect(text).toContain("conflict:");
		expect(text.length).toBeLessThanOrEqual(320);
	});

	it("escapes legacy target ids instead of allowing approval-line injection", () => {
		const state = emptyHarnessState();
		const legacy = entry("legacy\n- approved", "global", "遗留条目", "旧数据中的控制字符 id。", "user");
		state.entries.memory[legacy.id] = legacy;
		const text = renderMemoryApprovalDetails(proposal([{
			action: "archive",
			kind: "memory",
			targetScope: "global",
			blastRadius: "general",
			id: legacy.id,
		}]), "global", state);
		expect(text).toContain('global:"legacy\\n- approved"');
		expect(text.split("\n").some((line) => line.trim().startsWith("- approved"))).toBe(false);
	});

	it("keeps one target line for every edit before optional previews", () => {
		const text = renderMemoryApprovalDetails(proposal(Array.from({ length: 20 }, (_, index) => ({
			action: "update" as const,
			kind: "memory" as const,
			targetScope: "global" as const,
			blastRadius: "general" as const,
			id: `entry_${index}`,
			title: `条目 ${index}`,
			content: "内容 ".repeat(80),
		}))), "global", emptyHarnessState(), 3000);
		expect((text.match(/- update global:/g) ?? []).length).toBe(20);
	});
});

describe("applyMemoryExtractionProposal", () => {
	function withEngine(run: (engine: ReturnType<typeof createEvolutionEngine>) => Promise<void>): () => Promise<void> {
		return async () => {
			const engine = createEvolutionEngine(mkdtempSync(join(tmpdir(), "evolve-memory-agent-")));
			try {
				await run(engine);
			} finally {
				rmSync(engine.baseDir, { recursive: true, force: true });
			}
		};
	}

	it("applies local memory through the governed engine and stamps trajectory provenance", withEngine(async (engine) => {
		const agent = { id: "session-memory" } as Agent;
		const applied = await applyMemoryExtractionProposal({} as Context, engine, proposal([{
			action: "create",
			kind: "memory",
			targetScope: "local",
			blastRadius: "session",
			title: "本次会话偏好",
			content: "用户在本次任务中要求先验证再发布。",
			metadata: { memoryType: "user" },
		}]), {
			agent,
			baselines: { local: engine.load("local", agent.id), global: engine.load("global", undefined) },
			requireApproval: true,
			source: { sessionId: agent.id, seqs: [7] },
		});
		expect(applied.results[0]?.scope).toBe("local");
		const stored = Object.values(engine.load("local", agent.id).entries.memory)[0];
		expect(stored?.metadata["sourceSession"]).toBe("session-memory");
		expect(stored?.metadata["sourceSeqs"]).toEqual([7]);
	}));

	it("preserves provenance and lifecycle metadata when memoryType changes", withEngine(async (engine) => {
		const agent = { id: "session-metadata" } as Agent;
		engine.apply("local", agent.id, proposal([{
			action: "create",
			kind: "memory",
			targetScope: "local",
			blastRadius: "session",
			id: "preserve_metadata",
			title: "需要保留元数据",
			content: "初始事实。",
			metadata: { memoryType: "user" },
		}]), { scope: "local", source: { sessionId: "source-session", seqs: [4, 5] } });
		const state = engine.load("local", agent.id);
		const stored = state.entries.memory["preserve_metadata"];
		if (!stored) throw new Error("fixture missing");
		stored.metadata["archivedAt"] = "2026-09-24T00:00:00.000Z";
		stored.metadata["conflictHint"] = "memory:other:0.42";
		saveHarnessState(storePaths(engine.baseDir, "local", agent.id).stateDir, state);

		await applyMemoryExtractionProposal({} as Context, engine, proposal([{
			action: "update",
			kind: "memory",
			targetScope: "local",
			blastRadius: "session",
			id: "preserve_metadata",
			content: "更新后的事实。",
			metadata: { memoryType: "reference" },
		}]), {
			agent,
			baselines: { local: engine.load("local", agent.id), global: engine.load("global", undefined) },
			requireApproval: true,
		});
		const updated = engine.load("local", agent.id).entries.memory["preserve_metadata"];
		expect(updated?.metadata).toMatchObject({
			memoryType: "reference",
			sourceSession: "source-session",
			sourceSeqs: [4, 5],
			archivedAt: "2026-09-24T00:00:00.000Z",
			conflictHint: "memory:other:0.42",
		});
	}));

	it("applies approved project/global batches through their scoped engine stores", withEngine(async (engine) => {
		const agent = { id: "session-approved" } as Agent;
		let approvals = 0;
		const ctx = {
			userQuestions: {
				ask: async () => {
					approvals += 1;
					return { answers: [{ id: "approve-global-evolve", selected: ["批准"] }] };
				},
			},
		} as unknown as Context;
		const applied = await applyMemoryExtractionProposal(ctx, engine, proposal([
			{
				action: "create",
				kind: "memory",
				targetScope: "project",
				blastRadius: "project",
				title: "项目发布约束",
				content: "Why: 宿主 API 有代际漂移。 How to apply: 发布前先跑 tsc。",
				metadata: { memoryType: "project" },
			},
			{
				action: "create",
				kind: "memory",
				targetScope: "global",
				blastRadius: "general",
				title: "长期偏好",
				content: "用户在所有项目中都偏好先验证再发布。",
				metadata: { memoryType: "user" },
			},
		]), {
			agent,
			projectKey: "project-key",
			baselines: {
				local: engine.load("local", agent.id),
				project: engine.load("project", "project-key"),
				global: engine.load("global", undefined),
			},
			requireApproval: true,
		});
		expect(approvals).toBe(2);
		expect(applied.declinedScopes).toEqual([]);
		expect(Object.keys(engine.load("project", "project-key").entries.memory)).toHaveLength(1);
		expect(Object.keys(engine.load("global", undefined).entries.memory)).toHaveLength(1);
	}));

	it("requires approval for project/global and treats explicit rejection as a no-op", withEngine(async (engine) => {
		const agent = { id: "session-approval" } as Agent;
		const asked: string[] = [];
		const ctx = {
			userQuestions: {
				ask: async (request: { questions: { question: string }[] }) => {
					asked.push(request.questions[0]?.question ?? "");
					return { answers: [{ id: "approve-global-evolve", selected: ["拒绝"] }] };
				},
			},
		} as unknown as Context;
		const applied = await applyMemoryExtractionProposal(ctx, engine, proposal([
			{
				action: "create",
				kind: "memory",
				targetScope: "project",
				blastRadius: "project",
				title: "项目发布约束",
				content: "Why: 宿主 API 有代际漂移。 How to apply: 发布前先跑 tsc。",
				metadata: { memoryType: "project" },
			},
			{
				action: "create",
				kind: "memory",
				targetScope: "global",
				blastRadius: "general",
				title: "长期偏好",
				content: "用户在所有项目中都偏好先验证再发布。",
				metadata: { memoryType: "user" },
			},
		]), {
			agent,
			projectKey: "project-key",
			baselines: {
				local: engine.load("local", agent.id),
				project: engine.load("project", "project-key"),
				global: engine.load("global", undefined),
			},
			requireApproval: true,
		});
		expect(applied.results).toEqual([]);
		expect(applied.declinedScopes).toEqual(["project", "global"]);
		expect(asked).toHaveLength(2);
		expect(asked[0]).toContain("create project:(new) — 项目发布约束");
		expect(asked[0]).toContain("content=Why: 宿主 API 有代际漂移。 How to apply: 发布前先跑 tsc。");
		expect(asked[1]).toContain("create global:(new) — 长期偏好");
		expect(asked[1]).toContain("memoryType=user");
		expect(engine.load("project", "project-key").entries.memory).toEqual({});
		expect(engine.load("global", undefined).entries.memory).toEqual({});
	}));

	it.each([
		["missing answer", { answers: [] }],
		["missing selection", { answers: [{ id: "approve-global-evolve" }] }],
		["unknown selection", { answers: [{ id: "approve-global-evolve", selected: ["稍后再说"] }] }],
		["ambiguous selection", { answers: [{ id: "approve-global-evolve", selected: ["批准", "拒绝"] }] }],
	])("treats %s as a retryable approval error", async (_label, response) => {
		await withEngine(async (engine) => {
			const ctx = { userQuestions: { ask: async () => response } } as unknown as Context;
			await expect(applyMemoryExtractionProposal(ctx, engine, proposal([{
				action: "create",
				kind: "memory",
				targetScope: "global",
				blastRadius: "general",
				title: "不能静默跳过",
				content: "用户明确要求批准弹窗丢失时必须重试。",
				metadata: { memoryType: "user" },
			}]), {
				agent: { id: "session-malformed" } as Agent,
				baselines: { local: engine.load("local", "session-malformed"), global: engine.load("global", undefined) },
				requireApproval: true,
			})).rejects.toThrow(/approval returned/);
			expect(engine.load("global", undefined).entries.memory).toEqual({});
		})();
	});

	it("rechecks abort before the first engine write", withEngine(async (engine) => {
		const controller = new AbortController();
		controller.abort();
		await expect(applyMemoryExtractionProposal({} as Context, engine, proposal([{
			action: "create",
			kind: "memory",
			targetScope: "local",
			blastRadius: "session",
			title: "不应写入",
			content: "取消信号后不得产生持久化编辑。",
			metadata: { memoryType: "user" },
		}]), {
			agent: { id: "session-aborted" } as Agent,
			baselines: { local: engine.load("local", "session-aborted"), global: engine.load("global", undefined) },
			requireApproval: true,
			signal: controller.signal,
		})).rejects.toThrow();
		expect(engine.load("local", "session-aborted").entries.memory).toEqual({});
	}));

	it("fails closed when the approval service is missing", withEngine(async (engine) => {
		await expect(applyMemoryExtractionProposal({} as Context, engine, proposal([{
			action: "create",
			kind: "memory",
			targetScope: "global",
			blastRadius: "general",
			title: "需要审批",
			content: "这是跨会话长期事实。",
			metadata: { memoryType: "user" },
		}]), {
			agent: { id: "session-no-questions" } as Agent,
			baselines: { local: engine.load("local", "session-no-questions"), global: engine.load("global", undefined) },
			requireApproval: true,
		})).rejects.toThrow("userQuestions service");
	}));

	it("refuses project scope without a project key before asking or writing", withEngine(async (engine) => {
		await expect(applyMemoryExtractionProposal({} as Context, engine, proposal([{
			action: "create",
			kind: "memory",
			targetScope: "project",
			blastRadius: "project",
			title: "项目事实",
			content: "Why: 项目有特殊发布约束。 How to apply: 发布前执行项目门禁。",
			metadata: { memoryType: "project" },
		}]), {
			agent: { id: "session-no-project" } as Agent,
			baselines: { local: engine.load("local", "session-no-project"), global: engine.load("global", undefined) },
			requireApproval: true,
		})).rejects.toThrow("without a resolved project key");
	}));

	it("can deliberately disable persistent-scope approval through existing configuration", withEngine(async (engine) => {
		const applied = await applyMemoryExtractionProposal({} as Context, engine, proposal([{
			action: "create",
			kind: "memory",
			targetScope: "project",
			blastRadius: "project",
			title: "已配置跳过审批",
			content: "Why: 安装者显式关闭审批。 How to apply: 仅在受信任环境使用。",
			metadata: { memoryType: "project" },
		}]), {
			agent: { id: "session-no-approval" } as Agent,
			projectKey: "project-key",
			baselines: {
				local: engine.load("local", "session-no-approval"),
				project: engine.load("project", "project-key"),
				global: engine.load("global", undefined),
			},
			requireApproval: false,
		});
		expect(applied.results[0]?.scope).toBe("project");
	}));

	it("rolls back an earlier local scope when a later persistent apply throws", withEngine(async (engine) => {
		engine.apply("global", undefined, proposal([{
			action: "create",
			kind: "memory",
			targetScope: "global",
			blastRadius: "general",
			title: "已经存在的全局事实",
			content: "用户已经在所有项目中确认这条长期偏好。",
			metadata: { memoryType: "user" },
		}]), { scope: "global" });
		const ctx = {
			userQuestions: { ask: async () => ({ answers: [{ id: "approve-global-evolve", selected: ["批准"] }] }) },
		} as unknown as Context;
		await expect(applyMemoryExtractionProposal(ctx, engine, proposal([
			{
				action: "create",
				kind: "memory",
				targetScope: "local",
				blastRadius: "session",
				title: "先写入的本地事实",
				content: "用户在当前任务中要求先做局部验证。",
				metadata: { memoryType: "user" },
			},
			{
				action: "create",
				kind: "memory",
				targetScope: "global",
				blastRadius: "general",
				title: "已经存在的全局事实",
				content: "用户已经在所有项目中确认这条长期偏好。",
				metadata: { memoryType: "user" },
			},
		]), {
			agent: { id: "session-compensation" } as Agent,
			baselines: { local: engine.load("local", "session-compensation"), global: engine.load("global", undefined) },
			requireApproval: true,
		})).rejects.toThrow("create blocked");
		expect(engine.load("local", "session-compensation").entries.memory).toEqual({});
	}));

	it("rolls back a successful project batch when a later global apply throws", withEngine(async (engine) => {
		engine.apply("global", undefined, proposal([{
			action: "create",
			kind: "memory",
			targetScope: "global",
			blastRadius: "general",
			title: "全局重复项",
			content: "用户已经确认的全局长期事实。",
			metadata: { memoryType: "user" },
		}]), { scope: "global" });
		const ctx = {
			userQuestions: { ask: async () => ({ answers: [{ id: "approve-global-evolve", selected: ["批准"] }] }) },
		} as unknown as Context;
		await expect(applyMemoryExtractionProposal(ctx, engine, proposal([
			{
				action: "create",
				kind: "memory",
				targetScope: "project",
				blastRadius: "project",
				title: "先应用的项目事实",
				content: "Why: 项目需要特殊门禁。 How to apply: 发布前执行项目测试。",
				metadata: { memoryType: "project" },
			},
			{
				action: "create",
				kind: "memory",
				targetScope: "global",
				blastRadius: "general",
				title: "全局重复项",
				content: "用户已经确认的全局长期事实。",
				metadata: { memoryType: "user" },
			},
		]), {
			agent: { id: "session-project-rollback" } as Agent,
			projectKey: "project-key",
			baselines: {
				local: engine.load("local", "session-project-rollback"),
				project: engine.load("project", "project-key"),
				global: engine.load("global", undefined),
			},
			requireApproval: true,
		})).rejects.toThrow("create blocked");
		expect(engine.load("project", "project-key").entries.memory).toEqual({});
	}));

	it("compensates when the engine reports a post-commit hook failure", async () => {
		const engine = createEvolutionEngine(mkdtempSync(join(tmpdir(), "evolve-memory-postcommit-")), {
			onApplied: (result) => {
				if (!result.rollbackOf) {
					rmSync(storePaths(engine.baseDir, "local", "session-postcommit").resultsPath, { force: true });
					throw new Error("post-commit hook failed");
				}
			},
		});
		try {
			await expect(applyMemoryExtractionProposal({} as Context, engine, proposal([{
				action: "create",
				kind: "memory",
				targetScope: "local",
				blastRadius: "session",
				title: "提交后失败",
				content: "状态已落盘但 hook 失败，必须补偿。",
				metadata: { memoryType: "user" },
			}]), {
				agent: { id: "session-postcommit" } as Agent,
				baselines: { local: engine.load("local", "session-postcommit"), global: engine.load("global", undefined) },
				requireApproval: true,
			})).rejects.toThrow("prior memory writes were rolled back");
			expect(engine.load("local", "session-postcommit").entries.memory).toEqual({});
		} finally {
			rmSync(engine.baseDir, { recursive: true, force: true });
		}
	});

	it("compensates a mixed applied/failed engine batch", withEngine(async (engine) => {
		await expect(applyMemoryExtractionProposal({} as Context, engine, proposal([
			{
				action: "create",
				kind: "memory",
				targetScope: "local",
				blastRadius: "session",
				title: "会被补偿的有效条目",
				content: "这条创建会先成功，但同一 batch 的下一条会失败。",
				metadata: { memoryType: "user" },
			},
			{
				action: "update",
				kind: "memory",
				targetScope: "local",
				blastRadius: "session",
				id: "does-not-exist",
				content: "这条更新应当失败。",
			},
		]), {
			agent: { id: "session-mixed-result" } as Agent,
			baselines: { local: engine.load("local", "session-mixed-result"), global: engine.load("global", undefined) },
			requireApproval: true,
		})).rejects.toThrow("left 1 edit(s) unapplied");
		expect(engine.load("local", "session-mixed-result").entries.memory).toEqual({});
	}));

	it("treats a stale-baseline per-edit failure as retryable and preserves the concurrent value", withEngine(async (engine) => {
		const agent = { id: "session-stale" } as Agent;
		engine.apply("local", agent.id, proposal([{
			action: "create",
			kind: "memory",
			targetScope: "local",
			blastRadius: "session",
			id: "concurrency",
			title: "并发条目",
			content: "初始内容。",
			metadata: { memoryType: "user" },
		}]), { scope: "local" });
		const baseline = engine.load("local", agent.id);
		engine.apply("local", agent.id, proposal([{
			action: "update",
			kind: "memory",
			targetScope: "local",
			blastRadius: "session",
			id: "concurrency",
			content: "另一个会话已经写入的新内容。",
		}]), { scope: "local" });
		await expect(applyMemoryExtractionProposal({} as Context, engine, proposal([{
			action: "update",
			kind: "memory",
			targetScope: "local",
			blastRadius: "session",
			id: "concurrency",
			content: "基于旧基线的过期写入。",
		}]), {
			agent,
			baselines: { local: baseline, global: engine.load("global", undefined) },
			requireApproval: true,
		})).rejects.toThrow("left 1 edit(s) unapplied");
		expect(engine.load("local", agent.id).entries.memory["concurrency"]?.content).toBe("另一个会话已经写入的新内容。");
	}));

	it("screens credentials from project memory before any persistent write", withEngine(async (engine) => {
		const secret = `ghp_${"A".repeat(24)}`;
		const ctx = {
			userQuestions: { ask: async () => ({ answers: [{ id: "approve-global-evolve", selected: ["批准"] }] }) },
		} as unknown as Context;
		await expect(applyMemoryExtractionProposal(ctx, engine, proposal([{
			action: "create",
			kind: "memory",
			targetScope: "project",
			blastRadius: "project",
			title: "项目凭据",
			content: "部署配置记录。",
			path: `credentials/${secret}`,
			metadata: { memoryType: "reference" },
		}]), {
			agent: { id: "session-secret" } as Agent,
			projectKey: "project-key",
			baselines: {
				local: engine.load("local", "session-secret"),
				project: engine.load("project", "project-key"),
				global: engine.load("global", undefined),
			},
			requireApproval: true,
		})).rejects.toThrow("possible GitHub token");
		await expect(applyMemoryExtractionProposal(ctx, engine, proposal([{
			action: "create",
			kind: "memory",
			targetScope: "project",
			blastRadius: "project",
			id: secret,
			title: "项目凭据 ID",
			content: "凭据出现在标识符中。",
			path: "safe/path",
			metadata: { memoryType: "reference" },
		}]), {
			agent: { id: "session-secret" } as Agent,
			projectKey: "project-key",
			baselines: {
				local: engine.load("local", "session-secret"),
				project: engine.load("project", "project-key"),
				global: engine.load("global", undefined),
			},
			requireApproval: true,
		})).rejects.toThrow("possible GitHub token");
		expect(engine.load("project", "project-key").entries.memory).toEqual({});
	}));
});

describe("MEMORY_AGENT_SYSTEM_PROMPT quality contract", () => {
	it("stays within the size budget: every line is recurring per-turn spend", async () => {
		const mod = await import("../src/memory-agent.js");
		expect(mod.MEMORY_AGENT_SYSTEM_PROMPT.length).toBeLessThanOrEqual(mod.MEMORY_AGENT_SYSTEM_PROMPT_BUDGET_CHARS);
	});

	it("carries the do-not-remember exclusion list", async () => {
		const mod = await import("../src/memory-agent.js");
		expect(mod.MEMORY_AGENT_SYSTEM_PROMPT).toContain("Do not remember");
		expect(mod.MEMORY_AGENT_SYSTEM_PROMPT).toContain("one-off debugging trails");
	});

	it("demands actionable specificity with vague-vs-sharp examples", async () => {
		const mod = await import("../src/memory-agent.js");
		const prompt = mod.MEMORY_AGENT_SYSTEM_PROMPT;
		// The surprising-or-non-obvious filter: obvious restatements stay no-ops.
		expect(prompt).toContain("surprising or non-obvious");
		// Few-shot granularity anchors (ZCode parity): the model imitates
		// the examples' specificity, not just the abstract rules.
		expect(prompt).toContain("Granularity examples (vague → reject; sharp → save)");
		expect(prompt).toContain("user communicates in Chinese");
		expect(prompt).toContain("write memory and handoff content in Chinese prose");
	});
});

describe("proposal envelope and edit-field validation (branch-85 round)", () => {
	const envelope = (edits: unknown) => ({ summary: "s", rationale: "r", expectedOutcome: "o", edits });

	it("rejects non-object proposals, non-array edits, and oversized batches", () => {
		expect(() => parseMemoryExtractionProposal(null, [])).toThrow("must be an object");
		expect(() => parseMemoryExtractionProposal(envelope({}), [])).toThrow("must be an array");
		expect(() => parseMemoryExtractionProposal(envelope(Array.from({ length: 21 }, () => ({}))), [])).toThrow("exceeds 20 edits");
	});

	it("rejects unsupported actions, scopes, blast radii, and skill-only fields", () => {
		const base = { kind: "memory", targetScope: "local", blastRadius: "session", title: "x", content: "y", metadata: { memoryType: "user" } };
		expect(() => parseMemoryExtractionProposal(envelope([{ ...base, action: "explode" }]), [])).toThrow("unsupported action");
		expect(() => parseMemoryExtractionProposal(envelope([{ ...base, action: "create", targetScope: "everywhere" }]), [])).toThrow("unsupported targetScope");
		expect(() => parseMemoryExtractionProposal(envelope([{ ...base, action: "create", blastRadius: "planet" }]), [])).toThrow("unsupported blastRadius");
		expect(() => parseMemoryExtractionProposal(envelope([{ ...base, action: "create", reference: {} }]), [])).toThrow("skill-only fields");
	});
});

describe("manifest rendering and search edges (branch-85 round)", () => {
	function mixedManifest() {
		const state = emptyHarnessState();
		state.entries.memory["typed"] = entry("typed", "global", "类型化条目", "类型化内容", "user");
		state.entries.memory["untyped"] = { ...entry("untyped", "global", "无类型条目", "无类型内容", "user"), metadata: {} };
		state.entries.memory["old"] = {
			...entry("old", "global", "归档条目", "归档内容", "user"),
			metadata: { memoryType: "reference", archivedAt: "2026-01-01T00:00:00.000Z" },
		};
		return buildMemoryManifest(state);
	}

	it("marks untyped and archived entries in the manifest", () => {
		const text = formatMemoryManifest(mixedManifest());
		expect(text).toContain("untyped");
		expect(text).toContain(", archived");
	});

	it("truncates over-budget manifests with an omitted-entries line", () => {
		const text = formatMemoryManifest(mixedManifest(), 20);
		expect(text).toContain("+3 more entries");
	});

	it("returns nothing on blank queries and boosts exact scope:id hits", () => {
		const manifest = mixedManifest();
		expect(searchMemoryManifest(manifest, "   ")).toEqual([]);
		expect(searchMemoryManifest(manifest, "global:typed")[0]?.id).toBe("typed");
		expect(searchMemoryManifest(manifest, "无类型").map((hit) => hit.id)).toContain("untyped");
	});
});

describe("approval render fallbacks (branch-85 round)", () => {
	it("labels unchanged titles and contents on sparse updates", () => {
		const sparse = proposal([{
			action: "update",
			kind: "memory",
			targetScope: "global",
			blastRadius: "general",
			id: "ghost",
			reason: "new evidence",
		}]);
		const text = renderMemoryApprovalDetails(sparse, "global", emptyHarnessState());
		expect(text).toContain("(existing title unchanged)");
		expect(text).toContain("(content unchanged)");
	});
});

describe("runMemoryAgent route A (branch-85 round)", () => {
	it("builds a session prefix instead of the trajectory fallback", async () => {
		const requests: GenerateOptions[] = [];
		const llm = {
			stream: async function* (request: GenerateOptions) {
				requests.push(request);
				yield* toolCallChunks("propose-a", "memory_propose", proposal());
			},
		} as unknown as Context["llm"];
		const events = [{ type: "user/message", data: { content: [{ type: "text", text: "请记住这个约定" }], source: { kind: "user" } } }];
		const run = await runMemoryAgent({ llm } as unknown as Context, {
			provider: "test",
			model: "memory-model",
			manifest: [],
			trajectory: "user: 请记住这个约定",
			trajectoryEvents: events,
			prefixCache: { mode: "session" },
		});
		expect(run.proposal.edits).toEqual([]);
		expect(JSON.stringify(requests[0]?.messages)).not.toContain("<conversation>");
	});
});
