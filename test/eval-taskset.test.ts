import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	EVAL_TASKS_MAX_DEFAULT,
	loadTaskset,
	taskDirOfSelf,
	validateEvalTask,
} from "../src/services/eval-taskset.js";

function taskJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		id: "task-x",
		from: "session-test#seq-1",
		prompt: "什么时候可以 publish？",
		expect: [{ kind: "output-contains", any: ["CI 全绿"] }],
		tags: ["memory"],
		...overrides,
	});
}

describe("validateEvalTask", () => {
	it("accepts a well-formed task", () => {
		const { task, error } = validateEvalTask("task-x.json", JSON.parse(taskJson()));
		expect(error).toBeUndefined();
		expect(task?.id).toBe("task-x");
		expect(task?.expect).toHaveLength(1);
	});
	it("rejects non-objects, missing prompts, and判据-less tasks", () => {
		expect(validateEvalTask("a.json", null).error).toMatch(/not an object/);
		expect(validateEvalTask("a.json", JSON.parse(taskJson({ prompt: 42 }))).error).toMatch(/no prompt/);
		expect(validateEvalTask("a.json", JSON.parse(taskJson({ expect: [] }))).error).toMatch(/no executable/);
	});
	it("rejects unknown判据 kinds", () => {
		const { error } = validateEvalTask("a.json", JSON.parse(taskJson({ expect: [{ kind: "llm-vibes" }] })));
		expect(error).toMatch(/unknown判据/);
	});
	it("parses the recall segment when present", () => {
		const { task } = validateEvalTask(
			"a.json",
			JSON.parse(taskJson({ recall: { query: "能发版吗", expect_ids: ["release-gate-ci-green"] } })),
		);
		expect(task?.recall?.expectIds).toEqual(["release-gate-ci-green"]);
	});
});

describe("loadTaskset", () => {
	it("loads the shipped 22-task set without rejections", () => {
		const loaded = loadTaskset(taskDirOfSelf());
		expect(loaded.errors).toEqual([]);
		expect(loaded.tasks.length).toBeGreaterThanOrEqual(20);
		expect(loaded.tasks.length).toBeLessThanOrEqual(EVAL_TASKS_MAX_DEFAULT);
	});
	it("reports bad JSON, rejects, duplicates, and over-cap dirs", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-taskset-"));
		writeFileSync(join(dir, "bad.json"), "{not json");
		writeFileSync(join(dir, "empty.json"), taskJson({ id: "dup", expect: [] }));
		writeFileSync(join(dir, "one.json"), taskJson({ id: "dup" }));
		writeFileSync(join(dir, "two.json"), taskJson({ id: "dup" }));
		const loaded = loadTaskset(dir);
		expect(loaded.tasks).toHaveLength(1);
		expect(loaded.errors.join("\n")).toMatch(/not valid JSON/);
		expect(loaded.errors.join("\n")).toMatch(/no executable/);
		expect(loaded.errors.join("\n")).toMatch(/duplicate task id/);
		expect(loadTaskset(dir, 1).errors.join("\n")).toMatch(/exceed.*cap/);
	});
	it("fails loud on an unreadable dir", () => {
		expect(loadTaskset(join(tmpdir(), "no-such-dir-eval-taskset")).errors).toHaveLength(1);
	});
});
