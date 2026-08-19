/**
 * Tests for the `/evolve goal` subcommand handler (goal-command.ts).
 * Covers the create/status/complete/block surface and the missing-service
 * error path — the goal service itself stays duck-typed.
 */
import { describe, expect, it } from "vitest";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { executeGoalCommand } from "../src/goal-command.js";
import type { GoalServiceLike, GoalViewLike } from "../src/goal.js";

function view(overrides: Partial<GoalViewLike> = {}): GoalViewLike {
	return {
		id: "goal-1",
		revision: 2,
		objective: "evolve",
		phase: "active",
		maxGoalRounds: 10,
		...overrides,
	};
}

function fakeCtx(goals: GoalServiceLike | undefined): { get(name: string): unknown } {
	return { get: (name) => (name === "goals" ? goals : undefined) };
}

const agent = { id: "session-x" } as unknown as Agent;
const invocation = { agent } as never;

describe("executeGoalCommand", () => {
	it("reports the feature unavailable without the goals service", () => {
		const result = executeGoalCommand(fakeCtx(undefined) as never, invocation, []);
		expect(result.kind).toBe("error");
		expect(result.text).toContain("requires the goals service");
	});

	it("shows the current goal with no subcommand", () => {
		const goals: GoalServiceLike = {
			get: () => view({ objective: "写一个更好的 prompt" }),
			create: () => {
				throw new Error("unused");
			},
			edit: () => {
				throw new Error("unused");
			},
			complete: () => {
				throw new Error("unused");
			},
		};
		const result = executeGoalCommand(fakeCtx(goals) as never, invocation, []);
		expect(result.kind).toBe("success");
		expect(result.text).toContain("[active]");
		expect(result.text).toContain("写一个更好的 prompt");
	});

	it("explains how to create a goal when none exists", () => {
		const goals: GoalServiceLike = {
			get: () => undefined,
			create: () => {
				throw new Error("unused");
			},
			edit: () => {
				throw new Error("unused");
			},
			complete: () => {
				throw new Error("unused");
			},
		};
		const result = executeGoalCommand(fakeCtx(goals) as never, invocation, []);
		expect(result.kind).toBe("success");
		expect(result.text).toContain("no evolution goal");
	});

	it("creates a goal with an explicit objective", () => {
		let created: GoalViewLike | undefined;
		const goals: GoalServiceLike = {
			get: () => undefined,
			create: (_a, request) => {
				created = view({ objective: request.objective });
				return created;
			},
			edit: () => {
				throw new Error("unused");
			},
			complete: () => {
				throw new Error("unused");
			},
		};
		const result = executeGoalCommand(fakeCtx(goals) as never, invocation, ["把这次会话的经验沉淀下来"]);
		expect(result.kind).toBe("success");
		expect(created?.objective).toBe("把这次会话的经验沉淀下来");
		expect(result.text).toContain("evolution goal ready");
		expect(result.text).toContain("active goal drives the review gate");
	});

	it("joins multi-word objectives", () => {
		let created: GoalViewLike | undefined;
		const goals: GoalServiceLike = {
			get: () => undefined,
			create: (_a, request) => {
				created = view({ objective: request.objective });
				return created;
			},
			edit: () => {
				throw new Error("unused");
			},
			complete: () => {
				throw new Error("unused");
			},
		};
		const result = executeGoalCommand(fakeCtx(goals) as never, invocation, ["记住", "这个", "约定"]);
		expect(result.kind).toBe("success");
		expect(created?.objective).toBe("记住 这个 约定");
	});

	it("completes an active goal", () => {
		const goals: GoalServiceLike = {
			get: () => view(),
			create: () => {
				throw new Error("unused");
			},
			edit: () => {
				throw new Error("unused");
			},
			complete: (_a, ref) => {
				expect(ref.revision).toBe(2);
				return view({ phase: "complete" });
			},
		};
		const result = executeGoalCommand(fakeCtx(goals) as never, invocation, ["done"]);
		expect(result.kind).toBe("success");
		expect(result.text).toContain("evolution goal completed");
		expect(result.text).toContain("[complete]");
	});

	it("reports no-op when completing without a goal", () => {
		const goals: GoalServiceLike = {
			get: () => undefined,
			create: () => {
				throw new Error("unused");
			},
			edit: () => {
				throw new Error("unused");
			},
			complete: () => {
				throw new Error("should not complete");
			},
		};
		const result = executeGoalCommand(fakeCtx(goals) as never, invocation, ["done"]);
		expect(result.kind).toBe("success");
		expect(result.text).toBe("(no goal to complete)");
	});

	it("blocks an active goal with the default reason", () => {
		const goals: GoalServiceLike = {
			get: () => view(),
			create: () => {
				throw new Error("unused");
			},
			edit: () => {
				throw new Error("unused");
			},
			complete: () => {
				throw new Error("unused");
			},
			block: (_a, ref, reason) => {
				expect(ref.revision).toBe(2);
				expect(reason.code).toBe("evolve-blocked");
				expect(reason.reason).toBe("user requested block");
				return view({ phase: "blocked" });
			},
		};
		const result = executeGoalCommand(fakeCtx(goals) as never, invocation, ["block"]);
		expect(result.kind).toBe("success");
		expect(result.text).toContain("evolution goal blocked");
		expect(result.text).toContain("[blocked]");
	});

	it("blocks with a custom reason joined from the rest", () => {
		const goals: GoalServiceLike = {
			get: () => view(),
			create: () => {
				throw new Error("unused");
			},
			edit: () => {
				throw new Error("unused");
			},
			complete: () => {
				throw new Error("unused");
			},
			block: (_a, _ref, reason) => view({ phase: "blocked", objective: reason.reason }),
		};
		const result = executeGoalCommand(fakeCtx(goals) as never, invocation, ["block", "预算", "用尽"]);
		expect(result.kind).toBe("success");
		expect(result.text).toContain("预算 用尽");
	});

	it("reports no-op when blocking without an active goal", () => {
		const goals: GoalServiceLike = {
			get: () => undefined,
			create: () => {
				throw new Error("unused");
			},
			edit: () => {
				throw new Error("unused");
			},
			complete: () => {
				throw new Error("unused");
			},
			block: () => {
				throw new Error("should not block");
			},
		};
		const result = executeGoalCommand(fakeCtx(goals) as never, invocation, ["block"]);
		expect(result.kind).toBe("success");
		expect(result.text).toBe("(no active goal to block)");
	});

	it("propagates service failures as error results", () => {
		const goals: GoalServiceLike = {
			get: () => {
				throw new Error("goal store is down");
			},
			create: () => {
				throw new Error("unused");
			},
			edit: () => {
				throw new Error("unused");
			},
			complete: () => {
				throw new Error("unused");
			},
		};
		const result = executeGoalCommand(fakeCtx(goals) as never, invocation, []);
		expect(result.kind).toBe("error");
		expect(result.text).toContain("goal store is down");
	});
});