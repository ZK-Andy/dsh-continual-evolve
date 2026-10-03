/**
 * Regression tests for confirmation dialogs: the headline → details →
 * impact copy in both shipped languages, literal labels per language, and
 * bilingual parser acceptance. Dialogs without an explicit language resolve
 * per call (durable client preference, else `en`).
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { requestScopeApproval } from "../src/approval.js";
import { createEvolutionEngine } from "../src/service.js";
import { executeWrapupCommand } from "../src/wrapup-command.js";

vi.mock("../src/wrapup.js", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../src/wrapup.js")>();
	return { ...mod, assessLocalEntries: vi.fn() };
});

import { assessLocalEntries } from "../src/wrapup.js";
const assessMock = vi.mocked(assessLocalEntries);

interface CapturedQuestion {
	id: string;
	question: string;
	options?: { label: string; description?: string }[];
}

function baseCtx(
	ask: (request: { questions: CapturedQuestion[] }) => Promise<{ answers: { id: string; selected: string[] }[] }>,
	settingsRows?: unknown,
): { ctx: Context; captured: CapturedQuestion[] } {
	const captured: CapturedQuestion[] = [];
	const ctx = {
		logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
		get: () => undefined,
		...(settingsRows !== undefined ? { settings: { describe: () => settingsRows } } : {}),
		userQuestions: {
			ask: async (request: { questions: CapturedQuestion[] }) => {
				captured.push(...request.questions);
				return ask(request);
			},
		},
	} as unknown as Context;
	return { ctx, captured };
}

const ZH_SETTINGS = [{ ns: "locale", value: { preference: "zh" } }];

function capturingCtx(answer: { id: string; selected: string[] }): { ctx: Context; captured: CapturedQuestion[] } {
	return baseCtx(async () => ({ answers: [answer] }), ZH_SETTINGS);
}

function tmpBase(): string {
	const base = join(process.cwd(), "test/.tmp");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "/"));
}

describe("confirmation copy refresh (zh via durable preference)", () => {
	it("approval global: headline + impact + descriptions, labels unchanged", async () => {
		const { ctx, captured } = capturingCtx({ id: "approve-global-evolve", selected: ["批准"] });
		const decision = await requestScopeApproval(ctx, undefined, undefined, "global", "evolve_add memory \"x\" → global store");
		expect(decision).toBe("approved");
		expect(captured).toHaveLength(1);
		const q = captured[0]!;
		expect(q.id).toBe("approve-global-evolve");
		expect(q.question.split("\n")[0]).toBe("写入跨会话全局 store？");
		expect(q.question).toContain("影响：所有会话可见，可回滚。");
		expect(q.options?.map((o) => o.label)).toEqual(["批准", "拒绝"]);
		expect(q.options?.[0]?.description).toBe("写入，所有会话可见");
		expect(q.options?.[1]?.description).toBe("不写入，本次跳过");
	});

	it("approval project: project wording + truncates long summaries", async () => {
		const { ctx, captured } = capturingCtx({ id: "approve-global-evolve", selected: ["拒绝"] });
		const long = `x`.repeat(400);
		const decision = await requestScopeApproval(ctx, undefined, undefined, "project", long);
		expect(decision).toBe("declined");
		const q = captured[0]!;
		expect(q.question.split("\n")[0]).toBe("写入本项目跨会话 store？");
		expect(q.question).toContain("影响：仅本项目会话可见，可回滚。");
		expect(q.question).toContain("…");
		expect(q.question.length).toBeLessThan(long.length);
		expect(q.options?.[0]?.description).toBe("写入，仅本项目会话可见");
	});

	it("wrapup archive: two-line headline + descriptions", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			engine.apply("local", "session-x", {
				summary: "create sourced_1",
				rationale: "test",
				expectedOutcome: "entry exists",
				edits: [
					{
						action: "create",
						kind: "memory",
						id: "sourced_1",
						title: "Entry sourced_1",
						content: "Durable cross-session lesson distilled from this session; portable phrasing with no project-scoped paths or session identifiers inside.",
						metadata: { memoryType: "reference", sourceSeqs: [5], sourceSession: "session-x" },
					},
				],
			});
			assessMock.mockResolvedValue({
				rationale: "session-specific",
				items: [{ key: "memory:sourced_1", verdict: "archive", reason: "one-off" }],
			});
			const { ctx, captured } = capturingCtx({ id: "evolve-wrapup-archive-review", selected: ["保留"] });
			const agentX = { id: "session-x" } as unknown as Agent;
			const result = await executeWrapupCommand(ctx, engine, { agent: agentX, signal: undefined } as never);
			expect(result.kind).toBe("success");
			const q = captured.find((entry) => entry.id === "evolve-wrapup-archive-review");
			expect(q).toBeDefined();
			expect(q!.question.split("\n")[0]).toBe("wrapup 确认归档：条目「Entry sourced_1」");
			expect(q!.question).toContain("数据保留、可恢复。");
			expect(q!.options?.map((o) => o.label)).toEqual(["归档", "保留"]);
			expect(q!.options?.[0]?.description).toBe("隐藏但可恢复");
			expect(q!.options?.[1]?.description).toBe("继续注入");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("confirmation copy follows the resolved language", () => {
	it("approval en: headline + labels, parser accepts Approve/Decline", async () => {
		const { ctx, captured } = baseCtx(
			async () => ({ answers: [{ id: "approve-global-evolve", selected: ["Approve"] }] }),
		);
		const decision = await requestScopeApproval(ctx, undefined, undefined, "global", "evolve_add memory \"x\" → global store", "en");
		expect(decision).toBe("approved");
		expect(captured).toHaveLength(1);
		expect(captured[0]!.question.split("\n")[0]).toBe("Write to the global cross-session store?");
		expect(captured[0]!.options?.map((o) => o.label)).toEqual(["Approve", "Decline"]);
	});

	it("approval parser accepts both zh and en labels", async () => {
		const { ctx: zhCtx } = baseCtx(async () => ({ answers: [{ id: "approve-global-evolve", selected: ["批准"] }] }), ZH_SETTINGS);
		expect(await requestScopeApproval(zhCtx, undefined, undefined, "global", "w", "zh")).toBe("approved");
		const { ctx: enCtx } = baseCtx(async () => ({ answers: [{ id: "approve-global-evolve", selected: ["Decline"] }] }));
		expect(await requestScopeApproval(enCtx, undefined, undefined, "global", "w", "en")).toBe("declined");
	});

	it("dialogs fall back to en without a durable preference (DSH fallback)", async () => {
		const { ctx, captured } = baseCtx(async () => ({ answers: [{ id: "approve-global-evolve", selected: ["Approve"] }] }));
		expect(await requestScopeApproval(ctx, undefined, undefined, "global", "w")).toBe("approved");
		expect(captured[0]!.options?.map((o) => o.label)).toEqual(["Approve", "Decline"]);
	});
});
