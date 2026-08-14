/**
 * Goal-driven evolution round tests: phase gating, create-vs-edit semantics,
 * completion/blocking, and missing-service errors.
 */
import { describe, expect, it } from "vitest";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
	DEFAULT_EVOLVE_GOAL_OBJECTIVE,
	blockEvolutionGoal,
	completeEvolutionGoal,
	goalDrivesRounds,
	goalExists,
	upsertEvolutionGoal,
	type GoalServiceLike,
	type GoalViewLike,
} from "../src/goal.js";

function view(overrides: Partial<GoalViewLike> = {}): GoalViewLike {
	return {
		id: "goal-1",
		revision: 3,
		objective: "evolve",
		phase: "active",
		maxGoalRounds: 10,
		...overrides,
	};
}

function fakeCtx(goals: GoalServiceLike | undefined): { goals?: GoalServiceLike } {
	return { goals };
}

const agent = { id: "session-x" } as unknown as Agent;

describe("goalDrivesRounds / goalExists", () => {
	it("drives rounds only while the goal is active", () => {
		expect(goalDrivesRounds(view({ phase: "active" }))).toBe(true);
		expect(goalDrivesRounds(view({ phase: "paused" }))).toBe(false);
		expect(goalDrivesRounds(view({ phase: "complete" }))).toBe(false);
		expect(goalDrivesRounds(view({ phase: "blocked" }))).toBe(false);
		expect(goalDrivesRounds(undefined)).toBe(false);
	});

	it("goalExists narrows undefined", () => {
		expect(goalExists(undefined)).toBe(false);
		expect(goalExists(view())).toBe(true);
	});
});

describe("upsertEvolutionGoal", () => {
	it("creates with the default objective when none is given", () => {
		let created: GoalViewLike | undefined;
		const goals: GoalServiceLike = {
			get: () => undefined,
			create: (_a, request) => {
				created = view({ objective: request.objective });
				return created;
			},
			edit: () => {
				throw new Error("should not edit");
			},
			complete: () => {
				throw new Error("should not complete");
			},
		};
		const result = upsertEvolutionGoal(fakeCtx(goals), agent, undefined);
		expect(created?.objective).toBe(DEFAULT_EVOLVE_GOAL_OBJECTIVE);
		expect(result.phase).toBe("active");
	});

	it("edits an active goal's objective instead of creating", () => {
		const current = view({ objective: "old" });
		let edited: GoalViewLike | undefined;
		const goals: GoalServiceLike = {
			get: () => current,
			create: () => {
				throw new Error("should not create");
			},
			edit: (_a, ref, request) => {
				expect(ref.id).toBe("goal-1");
				expect(ref.revision).toBe(3);
				edited = view({ ...current, objective: request.objective ?? "" });
				return edited;
			},
			complete: () => {
				throw new Error("should not complete");
			},
		};
		const result = upsertEvolutionGoal(fakeCtx(goals), agent, "new objective");
		expect(edited?.objective).toBe("new objective");
		expect(result).toBe(edited);
	});

	it("creates over a completed goal (replacement semantics)", () => {
		const goals: GoalServiceLike = {
			get: () => view({ phase: "complete" }),
			create: (_a, request) => view({ objective: request.objective }),
			edit: () => {
				throw new Error("should not edit a completed goal");
			},
			complete: () => {
				throw new Error("should not complete");
			},
		};
		const result = upsertEvolutionGoal(fakeCtx(goals), agent, "again");
		expect(result.objective).toBe("again");
	});

	it("throws when the goals service is missing", () => {
		expect(() => upsertEvolutionGoal(fakeCtx(undefined), agent, "x")).toThrow(/goals service/);
	});
});

describe("completeEvolutionGoal / blockEvolutionGoal", () => {
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
				expect(ref.revision).toBe(3);
				return view({ phase: "complete" });
			},
		};
		const result = completeEvolutionGoal(fakeCtx(goals), agent);
		expect(result?.phase).toBe("complete");
	});

	it("does nothing when no goal exists", () => {
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
		expect(completeEvolutionGoal(fakeCtx(goals), agent)).toBeUndefined();
	});

	it("blocks only an active goal and only when supported", () => {
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
				expect(reason.code).toBe("evolve-blocked");
				return view({ phase: "blocked" });
			},
		};
		expect(blockEvolutionGoal(fakeCtx(goals), agent, "no budget")?.phase).toBe("blocked");
		const noBlock: GoalServiceLike = { ...goals, block: undefined };
		expect(blockEvolutionGoal(fakeCtx(noBlock), agent, "x")).toBeUndefined();
	});
});
