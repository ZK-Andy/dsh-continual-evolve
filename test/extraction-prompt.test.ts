import { describe, expect, it } from "vitest";
import {
	CHEAP_INCREMENT_MAX,
	cheapPrompt,
	EXTRACTION_CHEAP_SYSTEM_PROMPT,
	extractionPrompt,
	EXTRACTION_SYSTEM_PROMPT,
	manifestLineOf,
	MAX_PROPOSALS_PER_RUN,
	parseCheapAnswer,
	parseExtractionAnswer,
} from "../src/services/extraction-prompt.js";

describe("EXTRACTION_SYSTEM_PROMPT", () => {
	it("carries the taxonomy, the ADR boundary, and the closed output format", () => {
		expect(EXTRACTION_SYSTEM_PROMPT).toContain('type name="user"');
		expect(EXTRACTION_SYSTEM_PROMPT).toContain('type name="feedback"');
		expect(EXTRACTION_SYSTEM_PROMPT).toContain('type name="reference"');
		expect(EXTRACTION_SYSTEM_PROMPT).toContain("**Why:**");
		expect(EXTRACTION_SYSTEM_PROMPT).toContain("**How to apply:**");
		expect(EXTRACTION_SYSTEM_PROMPT).toContain("换一个仓库还有用的信息才进记忆");
		expect(EXTRACTION_SYSTEM_PROMPT).toContain("ADR");
		expect(EXTRACTION_SYSTEM_PROMPT).toContain("2026-10-08");
		// project is retired from the taxonomy.
		expect(EXTRACTION_SYSTEM_PROMPT).not.toContain('type name="project"');
		// The answer contract is a JSON object, nothing else.
		expect(EXTRACTION_SYSTEM_PROMPT).toContain('"decision"');
		expect(EXTRACTION_SYSTEM_PROMPT).toContain('"proposals"');
		// P1: bodies carry reusable facts, never the current session's narrative.
		expect(EXTRACTION_SYSTEM_PROMPT).toContain("正文去会话细节");
	});

	it("carries the project-agnostic ownership triple-test", () => {
		expect(EXTRACTION_SYSTEM_PROMPT).toContain("归属三测");
		expect(EXTRACTION_SYSTEM_PROMPT).toContain("主语测试");
		expect(EXTRACTION_SYSTEM_PROMPT).toContain("去名测试");
	});

	it("routes a fact with a repo-file landing point away from memory, whatever the file is called", () => {
		expect(EXTRACTION_SYSTEM_PROMPT).toContain("落点测试");
		expect(EXTRACTION_SYSTEM_PROMPT).toContain("tools-this-turn");
		expect(EXTRACTION_CHEAP_SYSTEM_PROMPT).toContain("落点测试");
		// The rule keys on the landing act, never on a file name: naming any
		// concrete workspace file here would make every new file a release.
		expect(EXTRACTION_SYSTEM_PROMPT).not.toMatch(/AGENTS\.md|CLAUDE\.md|README|\.agents\/notes/);
		expect(EXTRACTION_CHEAP_SYSTEM_PROMPT).not.toMatch(/AGENTS\.md|CLAUDE\.md|README|\.agents\/notes/);
	});
});

describe("extractionPrompt", () => {
	it("assembles manifest, candidates, and the increment with user seqs", () => {
		const prompt = extractionPrompt({
			increment: "user: 请记住我的编辑器是 Zed",
			manifest: [manifestLineOf({ id: "a", type: "user", title: "A", description: "钩子" })],
			candidates: ["# 候选 id=a（type=user）\n全文：正文"],
			userSeqs: [12, 15],
		});
		expect(prompt).toContain("<manifest>");
		expect(prompt).toContain("id=a｜type=user");
		expect(prompt).toContain("<candidates>");
		expect(prompt).toContain("全文：正文");
		expect(prompt).toContain("12,15");
		expect(prompt).toContain("user: 请记住我的编辑器是 Zed");
	});

	it("states the empty manifest and omits empty candidates", () => {
		const prompt = extractionPrompt({ increment: "x", manifest: [], candidates: [], userSeqs: [] });
		expect(prompt).toContain("本工作区还没有记忆");
		expect(prompt).not.toContain("<candidates>");
	});
});

describe("parseExtractionAnswer", () => {
	it("keeps the person scope marker and drops an invented one", () => {
		const answer = parseExtractionAnswer(JSON.stringify({
			decision: "apply",
			reason: "ok",
			proposals: [
				{ action: "create", id: "a", type: "user", title: "t", description: "d", body: "b", scope: "person" },
				{ action: "create", id: "b", type: "user", title: "t", description: "d", body: "b", scope: "global" },
			],
		}));
		expect(answer.proposals[0]?.scope).toBe("person");
		expect(answer.proposals[1]?.scope).toBeUndefined();
	});

	it("parses a plain and a fenced apply answer", () => {
		const answer = {
			decision: "apply",
			reason: "用户环境事实",
			proposals: [{ action: "create", type: "user", title: "编辑器", description: "钩子", body: "Zed", sourceSeqs: "820-831" }],
		};
		const json = JSON.stringify(answer);
		for (const text of [json, `\`\`\`json\n${json}\n\`\`\``, `前置说明\n${json}`]) {
			const parsed = parseExtractionAnswer(text);
			expect(parsed.decision).toBe("apply");
			expect(parsed.proposals).toHaveLength(1);
			expect(parsed.proposals[0]?.sourceSeqs).toBe("820-831");
		}
	});

	it("parses skip answers and normalizes missing reasons", () => {
		expect(parseExtractionAnswer('{"decision":"skip","reason":"没有新事实"}')).toEqual({
			decision: "skip",
			reason: "没有新事实",
			proposals: [],
		});
		expect(parseExtractionAnswer('{"decision":"skip"}').reason).toContain("skip");
	});

	it("degrades every malformed answer to an error (never a silent success)", () => {
		for (const text of ["", "完全不是 JSON", '{"decision":', "[1,2,3]", '"just a string"', '{"decision":"maybe"}', '{"decision":"apply"}', '{"decision":"apply","proposals":"nope"}', '{"decision":"apply","proposals":[{"action":"upsert"}]}']) {
			expect(parseExtractionAnswer(text).decision).toBe("error");
		}
	});

	it("drops non-conforming proposals and caps the batch", () => {
		const proposals = Array.from({ length: MAX_PROPOSALS_PER_RUN + 3 }, (_, i) => ({
			action: "create",
			type: "user",
			title: `t${i}`,
			description: "d",
			body: "b",
		}));
		const parsed = parseExtractionAnswer(JSON.stringify({ decision: "apply", proposals }));
		expect(parsed.decision).toBe("apply");
		expect(parsed.proposals).toHaveLength(MAX_PROPOSALS_PER_RUN);
	});

	it("ignores junk entries inside the proposals array", () => {
		const parsed = parseExtractionAnswer(
			JSON.stringify({ decision: "apply", proposals: [null, "junk", { action: "create", type: "user", title: "t", description: "d", body: "b" }] }),
		);
		expect(parsed.decision).toBe("apply");
		expect(parsed.proposals).toHaveLength(1);
	});

	it("recovers an answer with a bare control character instead of dropping the batch (P1)", () => {
		const json = JSON.stringify({
			decision: "apply",
			reason: "ok",
			proposals: [{ action: "create", type: "user", title: "t", description: "d", body: "正文" }],
		});
		// A raw NUL leaked into a string value: strict JSON.parse fails.
		const poisoned = json.replace("正文", "正文\u0000");
		expect(() => JSON.parse(poisoned)).toThrow();
		const parsed = parseExtractionAnswer(poisoned);
		expect(parsed.decision).toBe("apply");
		expect(parsed.proposals).toHaveLength(1);
		expect(parsed.proposals[0]?.body).toBe("正文");
	});

	it("still fails when the answer is unparseable after sanitizing (P1)", () => {
		const parsed = parseExtractionAnswer('{"decision":\u0000');
		expect(parsed.decision).toBe("error");
		expect(parsed.reason).toContain("unparseable output");
	});
});

describe("cheap pre-gate", () => {
	it("asks for a verdict over the increment head only", () => {
		expect(EXTRACTION_CHEAP_SYSTEM_PROMPT).toContain("预检门");
		expect(EXTRACTION_CHEAP_SYSTEM_PROMPT).toContain("归属三测");
		expect(EXTRACTION_CHEAP_SYSTEM_PROMPT).toContain('"worthExtracting"');
		expect(CHEAP_INCREMENT_MAX).toBe(4000);
		const prompt = cheapPrompt({ incrementHead: "user: 在 Fedora 上工作", userSeqs: [10] });
		expect(prompt).toContain("Fedora");
		expect(prompt).toContain("10");
		expect(prompt).not.toContain("manifest");
	});

	it("parses verdicts and fails open on anything else", () => {
		expect(parseCheapAnswer(`{"worthExtracting": true, "reason": "环境事实"}`)).toEqual({ worth: true, reason: "环境事实" });
		expect(parseCheapAnswer("```json\n{\"worthExtracting\": false, \"reason\": \"闲聊\"}\n```")).toEqual({ worth: false, reason: "闲聊" });
		expect(parseCheapAnswer("胡言乱语")).toBeNull();
		expect(parseCheapAnswer(JSON.stringify({ decision: "apply", proposals: [] }))).toBeNull();
		expect(parseCheapAnswer(JSON.stringify({ worthExtracting: "yes", reason: "x" }))).toBeNull();
	});
});
