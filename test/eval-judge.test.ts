import { describe, expect, it } from "vitest";
import { evalJudgeDefinition, judgeTwice, parseJudgeAnswer, qaRecallVerdict } from "../src/services/eval-judge.js";
import type { SubagentLoader } from "../src/services/subagent.js";

function scriptedLoader(texts: string[]): SubagentLoader & { calls: number } {
	let calls = 0;
	const loader = {
		calls: 0,
		run: async (definition: { parse: (text: string) => unknown }, _prompt: string) => {
			const text = texts[Math.min(calls, texts.length - 1)] ?? "";
			calls += 1;
			loader.calls = calls;
			return { answer: definition.parse(text), text, usage: undefined, finish: "stop" };
		},
	};
	return loader as unknown as SubagentLoader & { calls: number };
}

describe("parseJudgeAnswer", () => {
	it("reads the first non-empty line only", () => {
		expect(parseJudgeAnswer("PASS\n理由充分")).toEqual({ pass: true });
		expect(parseJudgeAnswer("\n  fail\n差一个断言")).toEqual({ pass: false });
		expect(parseJudgeAnswer("大概还行")).toEqual({ pass: null });
		expect(parseJudgeAnswer("")).toEqual({ pass: null });
	});
	it("the judge definition carries a stable id", () => {
		expect(evalJudgeDefinition.id).toBe("eval-judge-qa");
	});
});

describe("judgeTwice", () => {
	it("agrees when the model agrees with itself", async () => {
		const pair = await judgeTwice(scriptedLoader(["PASS\n好", "PASS\n确实好"]), "prompt");
		expect(pair).toEqual({ first: true, second: true, consistent: true });
	});
	it("flags disagreement and no-verdicts", async () => {
		expect((await judgeTwice(scriptedLoader(["PASS", "FAIL"]), "p")).consistent).toBe(false);
		const pair = await judgeTwice(scriptedLoader(["嗯", "嗯"]), "p");
		expect(pair).toEqual({ first: null, second: null, consistent: true });
	});
});

describe("qaRecallVerdict", () => {
	it("requires every expected id, or silence for negatives", () => {
		expect(qaRecallVerdict(["a", "b"], ["a"], false)).toBe(true);
		expect(qaRecallVerdict(["b"], ["a"], false)).toBe(false);
		expect(qaRecallVerdict([], [], false)).toBe(false);
		expect(qaRecallVerdict(["b"], ["a"], true)).toBe(true);
		expect(qaRecallVerdict(["a"], ["a"], true)).toBe(false);
	});
});
