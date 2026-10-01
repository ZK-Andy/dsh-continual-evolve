/**
 * Regression tests for the approval dialog fixes of 2026-10-01:
 *
 * 1. a typed ("Other") answer that exactly matches a dialog label counts as a
 *    decision — before this, typing in the input box produced `selected: []`
 *    and the write failed as "invalid decision: []";
 * 2. the dialog language runs the full record-language chain (config →
 *    durable client preference → the session's own recent user text → en),
 *    instead of stopping at the durable tier and falling back to English for
 *    a Chinese-speaking user whose stored preference was never set.
 */
import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { APPROVE_LABELS, DECLINE_LABELS, requestScopeApproval } from "../src/approval.js";

interface CapturedQuestion {
	id: string;
	question: string;
	options?: { label: string; description?: string }[];
}

type AnswerItem = { id: string; selected: string[]; custom?: string };

function ctxWith(
	answers: AnswerItem[],
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
				return { answers };
			},
		},
	} as unknown as Context;
	return { ctx, captured };
}

const ZH_SETTINGS = [{ ns: "locale", value: { preference: "zh" } }];

/** An agent whose session carries one direct Chinese user message. */
function zhAgent(): Agent {
	return {
		id: "session-zh",
		session: {
			events: [
				{
					type: "user/message",
					data: { content: [{ type: "text", text: "把这条偏好存下来，以后都用中文回复我。" }], source: { kind: "user" } },
				},
			],
		},
	} as unknown as Agent;
}

/** An agent whose session carries one direct English user message. */
function enAgent(): Agent {
	return {
		id: "session-en",
		session: {
			events: [
				{
					type: "user/message",
					data: { content: [{ type: "text", text: "Please remember this durable preference for later sessions." }], source: { kind: "user" } },
				},
			],
		},
	} as unknown as Agent;
}

const agentless: Agent = { id: "session-plain" } as unknown as Agent;

async function decide(
	ctx: Context,
	agent: Agent | undefined,
	configured?: "auto" | "zh" | "en",
): Promise<string> {
	return requestScopeApproval(ctx, agent, undefined, "global", "create memory:x", configured);
}

describe("approval — typed answers", () => {
	it("accepts a typed 批准 as approval", async () => {
		const { ctx } = ctxWith([{ id: "approve-global-evolve", selected: [], custom: "批准" }]);
		await expect(decide(ctx, agentless)).resolves.toBe("approved");
	});

	it("accepts typed labels across case, padding, and trailing particles", async () => {
		for (const [custom, expected] of [
			["Approve", "approved"],
			["approve", "approved"],
			["  批准  ", "approved"],
			["批准吧", "approved"],
			["批准。", "approved"],
			["Decline", "declined"],
			["拒绝！", "declined"],
			["拒绝", "declined"],
		] as const) {
			const { ctx } = ctxWith([{ id: "approve-global-evolve", selected: [], custom }]);
			await expect(decide(ctx, agentless), custom).resolves.toBe(expected);
		}
	});

	it("refuses a negated typed answer instead of reading it as approval", async () => {
		const { ctx } = ctxWith([{ id: "approve-global-evolve", selected: [], custom: "不批准" }]);
		await expect(decide(ctx, agentless)).rejects.toThrow(/clicked option/);
	});

	it("refuses an ambiguous typed answer with an actionable message", async () => {
		const { ctx } = ctxWith([{ id: "approve-global-evolve", selected: [], custom: "随便吧" }]);
		await expect(decide(ctx, agentless)).rejects.toThrow(/clicked option/);
	});

	it("refuses an empty answer and names the buttons to click", async () => {
		const { ctx } = ctxWith([{ id: "approve-global-evolve", selected: [] }]);
		await expect(decide(ctx, agentless)).rejects.toThrow(
			new RegExp(`${APPROVE_LABELS[0]}/${APPROVE_LABELS[1]}`),
		);
	});

	it("keeps accepting a clicked label", async () => {
		for (const [label, expected] of [
			[APPROVE_LABELS[0], "approved"],
			[APPROVE_LABELS[1], "approved"],
			[DECLINE_LABELS[0], "declined"],
			[DECLINE_LABELS[1], "declined"],
		] as const) {
			const { ctx } = ctxWith([{ id: "approve-global-evolve", selected: [label] }]);
			await expect(decide(ctx, agentless), label).resolves.toBe(expected);
		}
	});

	it("still fails loud on an unknown label", async () => {
		const { ctx } = ctxWith([{ id: "approve-global-evolve", selected: ["maybe"] }]);
		await expect(decide(ctx, agentless)).rejects.toThrow(/unknown decision label/);
	});
});

describe("approval — dialog language chain", () => {
	it("follows the session's own Chinese text when nothing else is configured", async () => {
		const { ctx, captured } = ctxWith([{ id: "approve-global-evolve", selected: ["批准"] }]);
		await decide(ctx, zhAgent());
		expect(captured[0]!.question.startsWith("写入跨会话全局 store？")).toBe(true);
	});

	it("treats an explicit `auto` as deferral, not as a language", async () => {
		const { ctx, captured } = ctxWith([{ id: "approve-global-evolve", selected: ["批准"] }]);
		await decide(ctx, zhAgent(), "auto");
		expect(captured[0]!.question.startsWith("写入")).toBe(true);
	});

	it("honours an explicit config over the session text", async () => {
		const { ctx, captured } = ctxWith([{ id: "approve-global-evolve", selected: ["Approve"] }]);
		await decide(ctx, zhAgent(), "en");
		expect(captured[0]!.question.startsWith("Write to the global cross-session store?")).toBe(true);
	});

	it("prefers the durable client preference over the session text", async () => {
		const { ctx, captured } = ctxWith([{ id: "approve-global-evolve", selected: ["批准"] }], ZH_SETTINGS);
		await decide(ctx, enAgent());
		expect(captured[0]!.question.startsWith("写入")).toBe(true);
	});

	it("falls back to English with no config, no preference, and no signal", async () => {
		const { ctx, captured } = ctxWith([{ id: "approve-global-evolve", selected: ["Approve"] }]);
		await decide(ctx, agentless);
		expect(captured[0]!.question.startsWith("Write to the global cross-session store?")).toBe(true);
	});

	it("renders project-scope copy in the resolved language", async () => {
		const { ctx, captured } = ctxWith([{ id: "approve-global-evolve", selected: ["批准"] }]);
		await requestScopeApproval(ctx, zhAgent(), undefined, "project", "create memory:y");
		expect(captured[0]!.question.startsWith("写入本项目跨会话 store？")).toBe(true);
	});
});
