import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { observedUsageOf, SubagentCallError, type LlmRuntime } from "../src/llm-call.js";
import { cutFailureOf, subagentLoaderFor, type SubagentDefinition } from "../src/subagent.js";
import {
	EXTRACTION_MAX_TOKENS,
	extractionGate,
	extractionMain,
	REVIEW_EVOLVE_BY_KIND,
	REVIEW_GATE_BY_KIND,
	SUBAGENT_DEFINITIONS,
} from "../src/subagent-defs.js";

const ROUTE = { provider: "deepseek", model: "deepseek-chat" };
const TODAY = "2026-10-14";

/** The instruction one definition sends, resolved with a fixed clock. */
function instructionOf(definition: SubagentDefinition<unknown>): string {
	return typeof definition.system === "function" ? definition.system({ today: TODAY }) : definition.system;
}

/** A scripted runtime that records every options object it is called with. */
function scriptedLlm(chunks: readonly unknown[], modelInfo?: { defaultMaxTokens?: unknown }): LlmRuntime & { seen: Record<string, unknown>[] } {
	const seen: Record<string, unknown>[] = [];
	const llm: LlmRuntime & { seen: Record<string, unknown>[] } = {
		seen,
		async *stream(options: Record<string, unknown>): AsyncIterable<unknown> {
			seen.push(options);
			for (const chunk of chunks) {
				yield chunk;
			}
		},
	};
	if (modelInfo !== undefined) {
		llm.resolveModelInfo = async () => modelInfo;
	}
	return llm;
}

/** A definition whose parser marks the text, so the skeleton's parse step is visible. */
const DEFINITION: SubagentDefinition<string> = {
	id: "test-job",
	system: "SYS",
	maxTokens: 777,
	parse: (text) => `parsed:${text}`,
};

describe("subagentLoaderFor", () => {
	it("runs one definition through the fixed skeleton", async () => {
		const llm = scriptedLlm([
			{ type: "text-delta", text: "ok" },
			{ type: "usage", usage: { totalTokens: 5 } },
			{ type: "finish", reason: { kind: "stop" } },
		]);
		const loader = subagentLoaderFor({ llm, route: ROUTE, sessionId: "sess-1", today: TODAY });
		const answer = await loader.run(DEFINITION, "PROMPT");
		expect(answer.answer).toBe("parsed:ok");
		expect(answer.text).toBe("ok");
		expect(answer.usage).toEqual({ totalTokens: 5 });
		expect(answer.finish).toBe("stop");
		const call = llm.seen[0] ?? {};
		expect(call.system).toBe("SYS");
		expect(call.sessionId).toBe("sess-1");
		expect(call.model).toBe(ROUTE.model);
		expect(call.maxTokens).toBe(777);
		expect((call.messages as { content: { text: string }[] }[])[0]?.content[0]?.text).toBe("PROMPT");
	});

	it("lets the model's advertised output cap override the definition's fallback", async () => {
		const llm = scriptedLlm(
			[{ type: "text-delta", text: "ok" }, { type: "finish", reason: { kind: "stop" } }],
			{ defaultMaxTokens: 8192 },
		);
		const loader = subagentLoaderFor({ llm, route: ROUTE, sessionId: undefined, today: TODAY });
		await loader.run(DEFINITION, "PROMPT");
		expect(llm.seen[0]?.maxTokens).toBe(8192);
	});

	it("resolves a builder instruction against the call's day", async () => {
		const llm = scriptedLlm([{ type: "text-delta", text: "ok" }, { type: "finish", reason: { kind: "stop" } }]);
		const dated: SubagentDefinition<string> = {
			id: "dated-job",
			system: ({ today }) => `SYS today=${today}`,
			maxTokens: 100,
			parse: (text) => text,
		};
		const loader = subagentLoaderFor({ llm, route: ROUTE, sessionId: undefined, today: TODAY });
		await loader.run(dated, "PROMPT");
		expect(llm.seen[0]?.system).toBe("SYS today=2026-10-14");
	});

	it("surfaces a failed call with the usage and route the stream already reported", async () => {
		const llm = scriptedLlm([
			{ type: "usage", usage: { inputTokens: 4, outputTokens: 6 } },
			{ type: "finish", reason: { kind: "error", failure: { code: "PROVIDER_DOWN", message: "provider down" } } },
		]);
		const loader = subagentLoaderFor({ llm, route: ROUTE, sessionId: "sess-1", today: TODAY });
		const error = await loader.run(DEFINITION, "PROMPT").catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(SubagentCallError);
		expect((error as SubagentCallError).message).toContain("PROVIDER_DOWN: provider down");
		expect((error as SubagentCallError).finish).toBe("error");
		expect((error as SubagentCallError).route).toEqual(ROUTE);
		expect(observedUsageOf(error)).toEqual({ inputTokens: 4, outputTokens: 6 });
		expect(observedUsageOf(new Error("plain"))).toBeUndefined();
	});
});

describe("cutFailureOf", () => {
	it("rejects a cut answer while keeping what it reported", () => {
		const error = cutFailureOf({ answer: null, text: "half", usage: { totalTokens: 9 }, finish: "max-tokens" }, ROUTE);
		expect(error.message).toBe("stream finished with max-tokens");
		expect(error.finish).toBe("max-tokens");
		expect(error.usage).toEqual({ totalTokens: 9 });
		expect(error.route).toEqual(ROUTE);
	});

	it("names a cut with no reported finish instead of writing 'undefined'", () => {
		const error = cutFailureOf({ answer: null, text: "", usage: undefined, finish: undefined }, ROUTE);
		expect(error.message).toBe("stream finished with unknown");
		expect(error.finish).toBeUndefined();
	});
});

describe("subagent definitions", () => {
	it("keeps the transport behind the loader: only the loader may import streamOnce", () => {
		const src = new URL("../src/", import.meta.url);
		const callers = readdirSync(src)
			.filter((name) => name.endsWith(".ts"))
			.filter((name) => readFileSync(new URL(name, src), "utf8").includes("streamOnce"))
			.sort();
		// llm-call.ts defines it; subagent.ts is the single loader. A feature
		// module appearing here means a call site bypassed the loader.
		expect(callers).toEqual(["llm-call.ts", "subagent.ts"]);
	});

	it("declares every job once, with a unique id and a complete definition", () => {
		const ids = SUBAGENT_DEFINITIONS.map((definition) => definition.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toEqual([
			"review-gate-memory",
			"review-gate-skill",
			"review-evolve-memory",
			"review-evolve-skill",
			"extraction-gate",
			"extraction-main",
		]);
		for (const definition of SUBAGENT_DEFINITIONS) {
			// Every job reads item text that can name dates, so every job is told
			// what "today" is — one missing instruction is one job judging dates
			// from its own prior.
			expect(instructionOf(definition)).toContain(`今天是 ${TODAY}`);
			expect(instructionOf(definition)).toContain("只有晚于今天的日期");
			expect(definition.maxTokens).toBeGreaterThan(0);
			expect(typeof definition.parse).toBe("function");
		}
	});

	it("gives the memory and skill gates their own rubrics", () => {
		const memory = instructionOf(REVIEW_GATE_BY_KIND.memory);
		const skill = instructionOf(REVIEW_GATE_BY_KIND.skill);
		// The memory gate is the memory home test; the skill gate inverts the
		// reuse clause for project-scope rows. One prompt cannot say both.
		expect(memory).toContain("记忆库");
		expect(memory).not.toContain("scope=project");
		expect(skill).toContain("技能库");
		expect(skill).toContain("scope=project");
		expect(skill).toContain("放错家");
		expect(instructionOf(REVIEW_EVOLVE_BY_KIND.memory)).not.toBe(instructionOf(REVIEW_EVOLVE_BY_KIND.skill));
	});

	it("wires each definition's parser to its own answer shape", () => {
		expect(REVIEW_GATE_BY_KIND.skill.parse(`{"worthReview": true, "reason": "r"}`)).toEqual({ worthReview: true, reason: "r" });
		expect(REVIEW_GATE_BY_KIND.memory.parse("noise")).toBeNull();
		expect(extractionGate.parse("noise")).toBeNull();
		expect(extractionMain.parse(`{"decision": "skip", "reason": "nothing"}`)).toEqual({
			decision: "skip", reason: "nothing", proposals: [],
		});
		expect(extractionMain.maxTokens).toBe(EXTRACTION_MAX_TOKENS);
	});
});
