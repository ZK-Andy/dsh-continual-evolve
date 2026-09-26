/**
 * Pins the record-language fix at the prompt boundary: every record-authoring
 * LLM call carries the language instruction in its system prompt, resolved
 * per call (explicit override, else durable client preference, else
 * trajectory detection, else `en`).
 */
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { reviewAutoRefine } from "../src/review.js";
import { planWithLlm } from "../src/planner.js";
import { runMemoryAgent } from "../src/memory-agent.js";
import { assessLocalEntries } from "../src/wrapup.js";
import { emptyHarnessState } from "../src/types.js";

vi.mock("../src/llm-text.js", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../src/llm-text.js")>();
	return { ...mod, streamText: vi.fn(), streamModelTurn: vi.fn() };
});

import { streamModelTurn, streamText } from "../src/llm-text.js";
const streamTextMock = vi.mocked(streamText);
const streamModelTurnMock = vi.mocked(streamModelTurn);

const agent = { id: "session-lang", options: { provider: "p", model: "m" } } as unknown as Agent;

function bareCtx(): Context {
	return { logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }) } as unknown as Context;
}

function zhCtx(): Context {
	return {
		logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
		settings: { describe: () => [{ ns: "locale", value: { preference: "zh" } }] },
	} as unknown as Context;
}

function wrapupCandidate(): Parameters<typeof assessLocalEntries>[2][number] {
	return {
		kind: "memory",
		id: "m1",
		title: "m1",
		content: "c",
		path: "general",
		version: 1,
		metadata: {},
		coveredGlobally: false,
		globalHints: [],
	};
}

describe("record language at the prompt boundary", () => {
	it("review detects zh from the trajectory", async () => {
		streamTextMock.mockResolvedValueOnce('{"shouldRefine": false, "rationale": "一次交互"}');
		await reviewAutoRefine(bareCtx(), {
			agent,
			state: emptyHarnessState(),
			history: [],
			context: { reason: "turn_interval", turnsSinceLastReview: 6 },
			trajectory: "用户说确认弹窗有点丑陋，要改样式",
		});
		const system = String((streamTextMock.mock.calls.at(-1)?.[1] as { system?: unknown } | undefined)?.system ?? "");
		expect(system).toContain("记录语言");
	});

	it("review honors the explicit override", async () => {
		streamTextMock.mockResolvedValueOnce('{"shouldRefine": false, "rationale": "once"}');
		await reviewAutoRefine(zhCtx(), {
			agent,
			state: emptyHarnessState(),
			history: [],
			context: { reason: "turn_interval", turnsSinceLastReview: 6 },
			trajectory: "用户说确认弹窗有点丑陋",
			language: "en",
		});
		const system = String((streamTextMock.mock.calls.at(-1)?.[1] as { system?: unknown } | undefined)?.system ?? "");
		expect(system).toContain("Record language");
	});

	it("planner detects zh from the trajectory", async () => {
		streamTextMock.mockResolvedValueOnce('{"summary": "s", "rationale": "r", "expectedOutcome": "o", "edits": []}');
		await planWithLlm(bareCtx(), {
			agent,
			state: emptyHarnessState(),
			history: [],
			trajectory: "用户反复在会话开始时要求读交接文档",
		});
		const system = String((streamTextMock.mock.calls.at(-1)?.[1] as { system?: unknown } | undefined)?.system ?? "");
		expect(system).toContain("记录语言");
	});

	it("memory agent detects zh from the checkpoint", async () => {
		streamModelTurnMock.mockResolvedValueOnce([
			{ type: "text", text: '{"summary": "s", "rationale": "r", "expectedOutcome": "o", "edits": []}' },
		]);
		await runMemoryAgent(bareCtx(), {
			provider: "p",
			model: "m",
			manifest: [],
			trajectory: "用户用中文沟通，要求先看预览再动手",
		});
		const system = String((streamModelTurnMock.mock.calls.at(-1)?.[1] as { system?: unknown } | undefined)?.system ?? "");
		expect(system).toContain("记录语言");
	});

	it("wrap-up assessor follows the durable preference without user text", async () => {
		streamTextMock.mockResolvedValueOnce('{"rationale": "r", "items": []}');
		await assessLocalEntries(zhCtx(), agent, [wrapupCandidate()], {});
		const system = String((streamTextMock.mock.calls.at(-1)?.[1] as { system?: unknown } | undefined)?.system ?? "");
		expect(system).toContain("记录语言");
	});

	it("wrap-up assessor falls back to en with no signal", async () => {
		streamTextMock.mockResolvedValueOnce('{"rationale": "r", "items": []}');
		await assessLocalEntries(bareCtx(), agent, [wrapupCandidate()], {});
		const system = String((streamTextMock.mock.calls.at(-1)?.[1] as { system?: unknown } | undefined)?.system ?? "");
		expect(system).toContain("Record language");
	});
});
