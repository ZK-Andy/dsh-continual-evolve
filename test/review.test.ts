/**
 * Tests for the review gate: JSON parsing, trajectory serialization, and the
 * global-coverage rule in the gate's system prompt.
 */
import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { ReasoningEffortId, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { emptyHarnessState } from "../src/types.js";
import { AUTO_REVIEW_SYSTEM_PROMPT, parseAutoRefineReview, reviewAutoRefine, serializeSurface } from "../src/review.js";

describe("AUTO_REVIEW_SYSTEM_PROMPT", () => {
	it("tells the gate to decline local duplicates of globally covered topics", () => {
		expect(AUTO_REVIEW_SYSTEM_PROMPT).toContain("scope=global");
		expect(AUTO_REVIEW_SYSTEM_PROMPT).toMatch(/already covered\s+by a global entry/i);
		expect(AUTO_REVIEW_SYSTEM_PROMPT).toMatch(/decline/i);
	});

	it("assigns memory-only evidence to the dedicated extractor", () => {
		expect(AUTO_REVIEW_SYSTEM_PROMPT).toMatch(/dedicated memory extraction agent/i);
		expect(AUTO_REVIEW_SYSTEM_PROMPT).toMatch(/do NOT approve solely.*memory/is);
	});

	it("tells the gate stale entries are a valid refine target (archive, not delete)", () => {
		expect(AUTO_REVIEW_SYSTEM_PROMPT).toMatch(/stale/i);
		expect(AUTO_REVIEW_SYSTEM_PROMPT).toMatch(/archive/i);
		expect(AUTO_REVIEW_SYSTEM_PROMPT).toMatch(/rather than delete/i);
	});

	it("judges skill-related trajectories against the skill-audit quality dimensions", () => {
		expect(AUTO_REVIEW_SYSTEM_PROMPT).toMatch(/skill-audit/i);
		expect(AUTO_REVIEW_SYSTEM_PROMPT).toMatch(/structural features/i);
		expect(AUTO_REVIEW_SYSTEM_PROMPT).toMatch(/REAL trigger scenario/i);
		expect(AUTO_REVIEW_SYSTEM_PROMPT).toMatch(/skill-creator/i);
	});

	it("treats repeated multi-step workflows as a refine target (guidance skill)", () => {
		expect(AUTO_REVIEW_SYSTEM_PROMPT).toMatch(/repeated multi-step workflows/i);
		expect(AUTO_REVIEW_SYSTEM_PROMPT).toMatch(/guidance skill/i);
		expect(AUTO_REVIEW_SYSTEM_PROMPT).toMatch(/skill_kind=guidance/i);
		expect(AUTO_REVIEW_SYSTEM_PROMPT).toMatch(/never\s+for\s+one-off flows/i);
		expect(AUTO_REVIEW_SYSTEM_PROMPT).toMatch(/offered to the user/i);
	});
});

describe("parseAutoRefineReview", () => {
	it("parses an approval with instructions", () => {
		const review = parseAutoRefineReview(
			JSON.stringify({
				shouldRefine: true,
				rationale: "repeated failure pattern",
				instructions: "record the git-submodule gotcha",
			}),
		);
		expect(review.shouldRefine).toBe(true);
		expect(review.rationale).toBe("repeated failure pattern");
		expect(review.instructions).toBe("record the git-submodule gotcha");
	});

	it("parses a rejection", () => {
		const review = parseAutoRefineReview(JSON.stringify({ shouldRefine: false, rationale: "one-off noise" }));
		expect(review.shouldRefine).toBe(false);
		expect(review.instructions).toBeUndefined();
	});

	it("rejects non-boolean shouldRefine as false", () => {
		const review = parseAutoRefineReview(JSON.stringify({ shouldRefine: "yes", rationale: "r" }));
		expect(review.shouldRefine).toBe(false);
	});

	it("recovers JSON wrapped in prose", () => {
		const review = parseAutoRefineReview(
			'Here is my decision:\n```json\n{"shouldRefine": true, "rationale": "ok"}\n```',
		);
		expect(review.shouldRefine).toBe(true);
	});

	it("throws on non-object replies", () => {
		expect(() => parseAutoRefineReview("not json at all")).toThrow();
	});
});

describe("reviewAutoRefine model routing", () => {
	it("resolves reasoning effort from the reviewModel override, not the agent route", async () => {
		let resolvedRoute: { provider: string; model: string } | undefined;
		let request: GenerateOptions | undefined;
		const response = JSON.stringify({ shouldRefine: false, rationale: "one-off" });
		const ctx = {
			llm: {
				resolveModelInfo: async (provider: string, model: string) => {
					resolvedRoute = { provider, model };
					return {
						provider,
						id: model,
						name: model,
						reasoning: { efforts: [{ id: ReasoningEffortId("low"), name: "low" }] },
					};
				},
				stream: async function* (options: GenerateOptions) {
					request = options;
					const chunks: StreamChunk[] = [
						{ type: "block-start", index: 0, blockType: "text" },
						{ type: "text-delta", index: 0, text: response },
						{ type: "block-end", index: 0, block: { type: "text", text: response } },
						{ type: "finish", reason: { kind: "stop" } },
					];
					for (const chunk of chunks) yield chunk;
				},
			},
		} as unknown as Context;
		const agent = { id: "session-review", options: { provider: "main-provider", model: "main-model" } } as never;

		await reviewAutoRefine(ctx, {
			agent,
			state: emptyHarnessState(),
			history: [],
			context: { reason: "turn_snapshot", turnsSinceLastReview: 1 },
			trajectory: "user: one-off request",
			trajectoryEvents: [],
			overrideProvider: "review-provider",
			overrideModel: "review-model",
		});

		expect(resolvedRoute).toEqual({ provider: "review-provider", model: "review-model" });
		expect(request?.reasoningEffort).toBe(ReasoningEffortId("low"));
	});
});

describe("serializeSurface", () => {
	const surface = [
		{ type: "turn/start", data: {} },
		{ type: "user/message", data: { content: [{ type: "text", text: "记住：测试用 vitest" }] } },
		{ type: "assistant/message", data: { content: [{ type: "text", text: "好的，已记录。" }] } },
		{ type: "tool/result", data: { content: [{ type: "tool-result", content: [{ type: "text", text: "ignored" }] }] } },
	];

	it("keeps user and assistant text with role prefixes, skips others", () => {
		const out = serializeSurface(surface, 1000);
		expect(out).toContain("user: 记住：测试用 vitest");
		expect(out).toContain("assistant: 好的，已记录。");
		expect(out).not.toContain("tool-result");
	});

	it("truncates from the tail to the max char budget", () => {
		const out = serializeSurface(surface, 20);
		expect(out.length).toBeLessThanOrEqual(20);
		expect(out).toContain("assistant");
	});
});
