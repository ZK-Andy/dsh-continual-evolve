import { describe, expect, it } from "vitest";
import { evolvePrompt, gatePrompt, parseEvolveAnswer, parseGateAnswer } from "../src/review-prompt.js";

describe("parseGateAnswer", () => {
	it("parses bare and fenced verdict JSON, rejects noise", () => {
		expect(parseGateAnswer(`{"worthReview": true, "reason": "有事实"}`)).toMatchObject({ worthReview: true });
		expect(parseGateAnswer("```json\n{\"worthReview\": false, \"reason\": \"空话\"}\n```")).toMatchObject({ worthReview: false });
		expect(parseGateAnswer("not json at all")).toBeNull();
		expect(parseGateAnswer(`{"reason": "缺字段"}`)).toBeNull();
	});
});

describe("parseEvolveAnswer", () => {
	it("parses keep/rewrite/quarantine and truncates long fields", () => {
		expect(parseEvolveAnswer(`{"verdict": "keep", "reason": "好"}`)).toMatchObject({ verdict: "keep" });
		const rewrite = parseEvolveAnswer(
			`{"verdict": "rewrite", "reason": "补", "title": "t", "description": "d", "body": "b", "corrects": "old-id"}`,
		);
		expect(rewrite).toMatchObject({ verdict: "rewrite", title: "t", body: "b", corrects: "old-id" });
		expect(parseEvolveAnswer(`{"verdict": "delete", "reason": "删"}`)).toBeNull();
		expect(parseEvolveAnswer("空")).toBeNull();
	});

	it("builds prompts carrying id, hook, body, and neighbors", () => {
		expect(gatePrompt({ kind: "memory", id: "a", title: "t", description: "h", body: "b" })).toContain("id=a");
		const prompt = evolvePrompt(
			{ id: "a", title: "t", description: "h", body: "b" },
			[{ id: "dup", title: "t2", description: "h2" }],
		);
		expect(prompt).toContain("id=dup");
		expect(evolvePrompt({ id: "a", title: "t", description: "h", body: "b" }, [])).not.toContain("同类候选");
		expect(evolvePrompt({ id: "a", title: "t", description: "h", body: "b", extra: "" }, [])).not.toContain("同类候选");
		expect(
			evolvePrompt({ id: "a", title: "t", description: "h", body: "b", extra: "判时注意时效" }, []),
		).toContain("时效");
	});

	it("rejects scalar and broken JSON instead of throwing", () => {
		expect(parseGateAnswer("123")).toBeNull();
		expect(parseGateAnswer("```json\n{broken\n```")).toBeNull();
		expect(parseEvolveAnswer("[1,2]")).toBeNull();
	});
});
