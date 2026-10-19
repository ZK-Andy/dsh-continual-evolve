import { describe, expect, it } from "vitest";
import { validateTasks } from "../scripts/eval-tasks.js";

/** Offline task validation (P5a): schema + recall refs, zero model calls. */
function file(name: string, task: unknown): { name: string; text: string } {
	return { name, text: JSON.stringify(task) };
}

function good(id = "task-001"): Record<string, unknown> {
	return {
		id,
		prompt: "什么时候可以 publish？",
		expect: [{ kind: "output-contains", any: ["CI 全绿"] }],
		tags: ["memory"],
		recall: { query: "CI 没绿能发版吗", expect_ids: ["release-gate-ci-green"] },
	};
}

describe("validateTasks", () => {
	it("accepts a well-formed task and summarizes it", () => {
		const result = validateTasks([file("task-001.json", good())]);
		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.summaries).toEqual([
			{ id: "task-001", tags: ["memory"], expectKinds: ["output-contains"], hasRecall: true, negative: false },
		]);
	});

	it("accepts a negative task with empty expect_ids", () => {
		const task = good();
		task.recall = { query: "今天天气", expect_ids: [], negative: true };
		const result = validateTasks([file("task-004.json", task)]);
		expect(result.ok).toBe(true);
		expect(result.summaries[0]).toMatchObject({ negative: true });
	});

	it("rejects bad JSON, missing ids, and duplicate ids", () => {
		const result = validateTasks([
			{ name: "broken.json", text: "{not json" },
			file("noid.json", { prompt: "x", expect: [{ kind: "output-contains" }] }),
			file("a.json", good("dup")),
			file("b.json", good("dup")),
		]);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => e.includes("not valid JSON"))).toBe(true);
		expect(result.errors.some((e) => e.includes("missing id"))).toBe(true);
		expect(result.errors.some((e) => e.includes('duplicate task id "dup"'))).toBe(true);
	});

	it("rejects empty expects, unknown kinds, and recall contradictions", () => {
		const noExpect = good("e1");
		noExpect.expect = [];
		const badKind = good("e2");
		badKind.expect = [{ kind: "vibes" }];
		const negWithIds = good("e3");
		negWithIds.recall = { expect_ids: ["x"], negative: true };
		const posWithoutIds = good("e4");
		posWithoutIds.recall = { expect_ids: [] };
		const result = validateTasks([
			file("e1.json", noExpect),
			file("e2.json", badKind),
			file("e3.json", negWithIds),
			file("e4.json", posWithoutIds),
		]);
		expect(result.ok).toBe(false);
		expect(result.errors).toHaveLength(4);
	});
});
