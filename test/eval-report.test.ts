import { describe, expect, it } from "vitest";
import { renderCompare, totalArm, type CompareReport } from "../src/services/eval-report.js";
import { EVAL_ARMS } from "../src/data/records.js";

function reportWith(acc: number, flaky: string[] = [], budget = "实测 100 tokens"): CompareReport {
	const arms = {} as CompareReport["arms"];
	for (const arm of EVAL_ARMS) {
		arms[arm] = totalArm(arm, [
			{ id: "t1", pass: acc >= 0.5, flaky: false, rounds: 1, toolCalls: 0, cost: 25, recallHit: true, note: "" },
			{ id: "t2", pass: false, flaky: false, rounds: 1, toolCalls: 0, cost: 25, recallHit: false, note: "no assertion matched" },
			{ id: "t3", pass: true, flaky: false, rounds: 1, toolCalls: 0, cost: 50, recallHit: null, note: "" },
		]);
	}
	return { runId: "eval-2026-10-19", date: "2026-10-19", commit: "", taskCount: 3, arms, flakyIds: flaky, budgetNote: budget };
}

describe("totalArm", () => {
	it("averages metrics and counts recall hits", () => {
		const arm = totalArm("current", [
			{ id: "t1", pass: true, flaky: false, rounds: 1, toolCalls: 0, cost: 10, recallHit: true, note: "" },
			{ id: "t2", pass: false, flaky: true, rounds: 3, toolCalls: 2, cost: 30, recallHit: null, note: "" },
		]);
		expect(arm.totals.acc).toBe(0.5);
		expect(arm.totals.rounds).toBe(2);
		expect(arm.totals.toolCalls).toBe(1);
		expect(arm.totals.cost).toBe(40);
		expect(arm.totals.recallHits).toBe(1);
		expect(arm.totals.recallTotal).toBe(1);
	});
	it("is zero-safe on empty arms", () => {
		expect(totalArm("base", []).totals.acc).toBe(0);
	});
});

describe("renderCompare", () => {
	it("renders header, lift table, flaky list, and budget", () => {
		const markdown = renderCompare(reportWith(0.5, ["current/t2"], "budget_exceeded: 200 > 100"));
		expect(markdown).toMatch(/# 四臂对照 eval-2026-10-19/);
		expect(markdown).toMatch(/- date: 2026-10-19/);
		expect(markdown).toMatch(/- arms: base\/current\/candidate\/reflect/);
		for (const arm of EVAL_ARMS) {
			expect(markdown).toContain(`| ${arm} |`);
		}
		expect(markdown).toContain("flaky: current/t2");
		expect(markdown).toContain("budget_exceeded");
	});
	it("reports no flaky items explicitly", () => {
		expect(renderCompare(reportWith(1))).toContain("flaky: 无");
	});
});
