/**
 * The judge protocol (P5b, D10): task arm and judge run the user's real
 * model; a judge-type QA item counts only when the same model, judging
 * twice independently, agrees with itself. Deterministic tasks never touch
 * the judge — their QA face is the recall-hit check below, reported apart
 * from `acc` and outside the flaky decision.
 */
import type { SubagentDefinition, SubagentLoader } from "./subagent.js";

/** The judge's answer: a binary verdict parsed from free text. */
export interface JudgeVerdict {
	readonly pass: boolean | null;
}

/** Parse a PASS/FAIL verdict line; anything else is "no verdict", not a throw. */
export function parseJudgeAnswer(text: string): JudgeVerdict {
	const line = text.split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? "";
	if (/^pass\b/i.test(line)) {
		return { pass: true };
	}
	if (/^fail\b/i.test(line)) {
		return { pass: false };
	}
	return { pass: null };
}

/** The QA judge: same-model double run, first line carries the verdict. */
export const evalJudgeDefinition: SubagentDefinition<JudgeVerdict> = {
	id: "eval-judge-qa",
	system:
		"你是评测判官。只看回复是否满足任务要求，第一行只写 PASS 或 FAIL，第二行起写一句话理由。拿不准就写 FAIL。",
	maxTokens: 512,
	parse: parseJudgeAnswer,
};

/** Two independent judge runs over one reply. */
export interface JudgePair {
	readonly first: boolean | null;
	readonly second: boolean | null;
	readonly consistent: boolean;
}

/**
 * Judge one reply twice with the same loader (same model, two calls).
 * @param loader - The bound judge runner.
 * @param prompt - The task prompt plus the reply under judgement.
 * @returns Both verdicts and whether they agreed.
 */
export async function judgeTwice(loader: SubagentLoader, prompt: string): Promise<JudgePair> {
	const first = await loader.run(evalJudgeDefinition, prompt);
	const second = await loader.run(evalJudgeDefinition, prompt);
	return { first: first.answer.pass, second: second.answer.pass, consistent: first.answer.pass === second.answer.pass };
}

/**
 * The deterministic QA verdict for recall-type items: every expected id
 * surfaced (negatives: none surfaced).
 * @param topIds - The ranked ids the search returned.
 * @param expectIds - The evidence ids the fixture names.
 * @param negative - True when the fixture asserts zero hits.
 * @returns Whether the QA item holds.
 */
export function qaRecallVerdict(topIds: readonly string[], expectIds: readonly string[], negative: boolean): boolean {
	if (negative) {
		return !topIds.some((id) => expectIds.includes(id));
	}
	return expectIds.length > 0 && expectIds.every((id) => topIds.includes(id));
}
