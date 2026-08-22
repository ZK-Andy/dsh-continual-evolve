/**
 * Tests for the gate turn counter, the review-model override parser, the
 * event wiring of registerAutoReview (armed marker, interval check,
 * goal-driven override, compaction trigger, failure containment), and the
 * D3 goal-blocked fate trigger.
 */
import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
	advanceGateState,
	consultSkillEdits,
	loadGateHarnessView,
	parseReviewModel,
	registerAutoReview,
	runGoalBlockedFate,
	SKILL_CONSULT_COOLDOWN_TURNS,
	splitSkillEdits,
	type AutoReviewConfig,
	type GateState,
} from "../src/auto.js";
import { createEvolutionEngine } from "../src/service.js";
import { saveHarnessState } from "../src/state.js";
import { storePaths } from "../src/store.js";
import { emptyHarnessState, type HarnessEntry, type RefinementProposal } from "../src/types.js";
import type { Context } from "@deepseek-ai/cordis";

function fresh(): GateState {
	return { turns: 0, lastReviewAt: 0, running: false, skillRejects: new Map(), lastFateAt: 0, fateRejects: new Map(), goalBlockStreak: 0 };
}

function baseConfig(overrides: Partial<AutoReviewConfig> = {}): AutoReviewConfig {
	return {
		intervalTurns: 3,
		maxInputChars: 2000,
		budgetTokens: 512,
		notifyOnAutoReview: false,
		localFate: false,
		fateIntervalTurns: 5,
		goalBlockedWrapupTurns: 0,
		...overrides,
	};
}

function fullEntry(id: string, kind: HarnessEntry["kind"], title: string): HarnessEntry {
	return {
		id,
		kind,
		title,
		content: "body",
		path: "general",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "evolve",
		created_at: "2026-08-14T00:00:00.000Z",
		updated_at: "2026-08-14T00:00:00.000Z",
		version: 1,
	};
}

describe("advanceGateState", () => {
	it("counts one turn per running → idle transition", () => {
		const state = fresh();
		expect(advanceGateState(state, "running")).toBe(false);
		expect(advanceGateState(state, "idle")).toBe(true);
		expect(state.turns).toBe(1);
		expect(advanceGateState(state, "running")).toBe(false);
		expect(advanceGateState(state, "idle")).toBe(true);
		expect(state.turns).toBe(2);
	});

	it("ignores duplicate idle emissions without an intervening running", () => {
		const state = fresh();
		advanceGateState(state, "running");
		expect(advanceGateState(state, "idle")).toBe(true);
		expect(advanceGateState(state, "idle")).toBe(false);
		expect(state.turns).toBe(1);
	});

	it("ignores initial idle before any running", () => {
		const state = fresh();
		expect(advanceGateState(state, "idle")).toBe(false);
		expect(state.turns).toBe(0);
	});

	it("ignores unknown statuses", () => {
		const state = fresh();
		expect(advanceGateState(state, "bogus")).toBe(false);
		expect(state.turns).toBe(0);
	});
});

describe("loadGateHarnessView", () => {
	it("merges global entries into the gate's view with their real scope", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-gateview-"));
		try {
			const engine = createEvolutionEngine(dir);
			const global = emptyHarnessState();
			global.entries.memory["readme"] = fullEntry("readme", "memory", "README upkeep");
			global.entries.memory["readme"].scope = "global";
			saveHarnessState(storePaths(dir, "global", undefined).stateDir, global);

			const local = emptyHarnessState();
			local.entries.memory["lint"] = fullEntry("lint", "memory", "Lint first");
			saveHarnessState(storePaths(dir, "local", "session-gate").stateDir, local);

			const view = loadGateHarnessView(engine, "session-gate");
			expect(view.entries.memory["readme"]?.scope).toBe("global");
			expect(view.entries.memory["lint"]?.scope).toBe("local");
			expect(Object.keys(view.entries.memory)).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps both sides visible on id collision (global keeps the id, local is prefixed)", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-gateview-"));
		try {
			const engine = createEvolutionEngine(dir);
			const global = emptyHarnessState();
			const g = fullEntry("shared", "memory", "Global version");
			g.scope = "global";
			global.entries.memory["shared"] = g;
			saveHarnessState(storePaths(dir, "global", undefined).stateDir, global);

			const local = emptyHarnessState();
			local.entries.memory["shared"] = fullEntry("shared", "memory", "Local version");
			saveHarnessState(storePaths(dir, "local", "session-gate").stateDir, local);

			const view = loadGateHarnessView(engine, "session-gate");
			expect(view.entries.memory["shared"]?.title).toBe("Global version");
			expect(view.entries.memory["local:shared"]?.title).toBe("Local version");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

function proposalWith(edits: RefinementProposal["edits"]): RefinementProposal {
	return { summary: "s", rationale: "r", expectedOutcome: "o", edits };
}

const skillEdit = {
	action: "create",
	kind: "skill" as const,
	title: "会话交接流程",
	content: "# 交接流程\n\nbody",
	skill_kind: "guidance" as const,
};

const memoryEdit = { action: "create", kind: "memory" as const, title: "m", content: "c" };

describe("splitSkillEdits", () => {
	it("separates skill edits from the rest of a proposal", () => {
		const { skillEdits, otherEdits } = splitSkillEdits(proposalWith([skillEdit, memoryEdit]));
		expect(skillEdits).toHaveLength(1);
		expect(skillEdits[0]?.kind).toBe("skill");
		expect(otherEdits).toHaveLength(1);
		expect(otherEdits[0]?.kind).toBe("memory");
	});

	it("handles proposals without skill edits", () => {
		const { skillEdits, otherEdits } = splitSkillEdits(proposalWith([memoryEdit]));
		expect(skillEdits).toHaveLength(0);
		expect(otherEdits).toHaveLength(1);
	});
});

function fakeCtx(answer: "固化" | "不固化" | "throw" | "missing"): {
	ctx: Context;
	askCount: () => number;
} {
	let calls = 0;
	const ctx = {
		userQuestions:
			answer === "missing"
				? undefined
				: {
						ask: async () => {
							calls += 1;
							if (answer === "throw") throw new Error("aborted");
							return { answers: [{ id: "evolve-skill-consult", selected: [answer] }] };
						},
					},
	} as unknown as Context;
	return { ctx, askCount: () => calls };
}

const fakeAgent = { id: "session-consult" } as never;

describe("consultSkillEdits", () => {
	it("returns true immediately when there are no skill edits", async () => {
		const { ctx } = fakeCtx("missing");
		expect(await consultSkillEdits(ctx, fakeAgent, [], fresh())).toBe(true);
	});

	it("consents when the user chooses 固化, without recording a rejection", async () => {
		const { ctx, askCount } = fakeCtx("固化");
		const gate = fresh();
		expect(await consultSkillEdits(ctx, fakeAgent, [skillEdit], gate)).toBe(true);
		expect(askCount()).toBe(1);
		expect(gate.skillRejects.size).toBe(0);
	});

	it("declines when the user chooses 不固化 and records the cooldown", async () => {
		const { ctx } = fakeCtx("不固化");
		const gate = fresh();
		expect(await consultSkillEdits(ctx, fakeAgent, [skillEdit], gate)).toBe(false);
		expect(gate.skillRejects.size).toBe(1);
	});

	it("does not re-ask a candidate rejected within the cooldown window", async () => {
		const { ctx, askCount } = fakeCtx("不固化");
		const gate = fresh();
		expect(await consultSkillEdits(ctx, fakeAgent, [skillEdit], gate)).toBe(false);
		expect(askCount()).toBe(1);
		// same candidate again, inside the cooldown: silent skip, no question
		gate.turns = SKILL_CONSULT_COOLDOWN_TURNS - 1;
		expect(await consultSkillEdits(ctx, fakeAgent, [skillEdit], gate)).toBe(false);
		expect(askCount()).toBe(1);
		// after the cooldown elapses the candidate is offered again
		gate.turns = SKILL_CONSULT_COOLDOWN_TURNS + 1;
		expect(await consultSkillEdits(ctx, fakeAgent, [skillEdit], gate)).toBe(false);
		expect(askCount()).toBe(2);
	});

	it("never writes a skill silently without the question service", async () => {
		const { ctx } = fakeCtx("missing");
		expect(await consultSkillEdits(ctx, fakeAgent, [skillEdit], fresh())).toBe(false);
	});

	it("is conservative when the question call fails", async () => {
		const { ctx } = fakeCtx("throw");
		expect(await consultSkillEdits(ctx, fakeAgent, [skillEdit], fresh())).toBe(false);
	});
});

describe("parseReviewModel", () => {
	it("returns undefined for empty overrides", () => {
		expect(parseReviewModel(undefined, "deepseek")).toBeUndefined();
		expect(parseReviewModel("", "deepseek")).toBeUndefined();
		expect(parseReviewModel("   ", "deepseek")).toBeUndefined();
	});

	it("splits an explicit provider/model route", () => {
		expect(parseReviewModel("openai/gpt-mini", "deepseek")).toEqual({ provider: "openai", model: "gpt-mini" });
	});

	it("falls back to the agent provider, then deepseek, for bare model names", () => {
		expect(parseReviewModel("glm-5", "zhipu")).toEqual({ provider: "zhipu", model: "glm-5" });
		expect(parseReviewModel("glm-5", undefined)).toEqual({ provider: "deepseek", model: "glm-5" });
	});
});

/** Wiring harness: captures listeners so tests can fire harness events. */
function wiringHarness(options: { goals?: { get(agent: unknown): unknown }; agents?: Map<string, unknown> } = {}): {
	dir: string;
	emit: (event: string, payload: unknown) => void;
	warnings: string[];
	infos: string[];
	reviewsLines: () => string[];
} {
	const dir = mkdtempSync(join(tmpdir(), "evolve-autowire-"));
	const engine = createEvolutionEngine(dir);
	const listeners = new Map<string, Array<(payload: unknown) => void>>();
	const warnings: string[] = [];
	const infos: string[] = [];
	const ctx = {
		on: (event: string, fn: (payload: unknown) => void) => {
			const list = listeners.get(event) ?? [];
			list.push(fn);
			listeners.set(event, list);
		},
		logger: () => ({
			warn: (message: string) => warnings.push(message),
			info: (message: string) => infos.push(message),
		}),
		get: (name: string) => (name === "goals" ? options.goals : undefined),
		...(options.agents ? { agents: { get: (id: string) => options.agents?.get(id) } } : {}),
	} as unknown as Context;
	registerAutoReview(ctx, engine, baseConfig());
	return {
		dir,
		emit: (event, ...payloads) => {
			for (const fn of listeners.get(event) ?? []) fn(...payloads);
		},
		warnings,
		infos,
		reviewsLines: () =>
			existsSync(join(dir, "evolve", "reviews.jsonl"))
				? readFileSync(join(dir, "evolve", "reviews.jsonl"), "utf8").trimEnd().split("\n").filter((l) => l.length > 0)
				: [],
	};
}

const wireAgent = { id: "session-wire" };

describe("registerAutoReview wiring", () => {
	it("writes the armed marker with the configured interval on registration", () => {
		const h = wiringHarness();
		try {
			const lines = h.reviewsLines();
			expect(lines).toHaveLength(1);
			const record = JSON.parse(lines[0] ?? "{}") as { outcome?: string; rationale?: string };
			expect(record.outcome).toBe("armed");
			expect(record.rationale).toContain("interval=3");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("warns and skips the count when turn-stopping carries no agent", () => {
		const h = wiringHarness();
		try {
			h.emit("agent/turn-stopping", {});
			expect(h.warnings.some((w) => w.includes("missing agent"))).toBe(true);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("does not run the gate below the interval threshold", async () => {
		const h = wiringHarness();
		try {
			h.emit("agent/turn-stopping", { agent: wireAgent });
			h.emit("agent/turn-stopping", { agent: wireAgent });
			h.emit("agent/status", { agent: wireAgent, status: "idle" }); // 2 < interval 3
			await vi.waitFor(() => expect(true).toBe(true)); // flush microtasks
			expect(h.reviewsLines()).toHaveLength(1); // armed marker only
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("runs the gate at the interval; trajectory failure is contained as a failed record", async () => {
		const h = wiringHarness(); // no sessionQuery → readTrajectory always fails
		try {
			h.emit("agent/turn-stopping", { agent: wireAgent });
			h.emit("agent/turn-stopping", { agent: wireAgent });
			h.emit("agent/turn-stopping", { agent: wireAgent });
			h.emit("agent/status", { agent: wireAgent, status: "idle" });
			await vi.waitFor(() => expect(h.reviewsLines().length).toBe(2));
			const record = JSON.parse(h.reviewsLines()[1] ?? "{}") as { outcome?: string; reason?: string; rationale?: string };
			expect(record.outcome).toBe("failed");
			expect(record.reason).toBe("turn_interval");
			expect(record.rationale).toContain("trajectory unavailable");
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("an active goal drives the gate even below the plain turn interval", async () => {
		const h = wiringHarness({ goals: { get: () => ({ phase: "active" }) } });
		try {
			h.emit("agent/turn-stopping", { agent: wireAgent }); // 1 turn only
			h.emit("agent/status", { agent: wireAgent, status: "idle" });
			await vi.waitFor(() => expect(h.reviewsLines().length).toBe(2));
			const record = JSON.parse(h.reviewsLines()[1] ?? "{}") as { outcome?: string };
			expect(record.outcome).toBe("failed"); // gate ran (and failed on the missing trajectory)
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("compaction triggers the gate unconditionally; cold sessions are ignored", async () => {
		const agents = new Map<string, unknown>([["session-wire", wireAgent]]);
		const h = wiringHarness({ agents });
		try {
			h.emit("session/event", { id: "session-wire" }, { type: "compaction/start" });
			await vi.waitFor(() => expect(h.reviewsLines().length).toBe(2));
			const record = JSON.parse(h.reviewsLines()[1] ?? "{}") as { reason?: string };
			expect(record.reason).toBe("compact");

			h.emit("session/event", { id: "session-cold" }, { type: "compaction/start" });
			await vi.waitFor(() => expect(true).toBe(true));
			expect(h.reviewsLines()).toHaveLength(2);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});
});

describe("runGoalBlockedFate (D3)", () => {
	function blockedCtx(): { ctx: Context; infos: string[] } {
		const infos: string[] = [];
		const ctx = {
			logger: () => ({
				warn: () => undefined,
				info: (message: string) => infos.push(message),
			}),
			get: (name: string) => (name === "goals" ? { get: () => ({ phase: "blocked" }) } : undefined),
		} as unknown as Context;
		return { ctx, infos };
	}

	function collector(): (entry: Record<string, unknown>) => void {
		return () => undefined;
	}

	it("returns immediately when the trigger is disabled", async () => {
		const { ctx } = blockedCtx();
		const state = fresh();
		const engine = createEvolutionEngine(mkdtempSync(join(tmpdir(), "evolve-d3-off-")));
		try {
			await runGoalBlockedFate(ctx, engine, wireAgent as never, baseConfig({ goalBlockedWrapupTurns: 0 }), state, "turn_interval", collector());
			expect(state.goalBlockStreak).toBe(0);
			expect(state.turns).toBe(0);
		} finally {
			rmSync(engine.baseDir, { recursive: true, force: true });
		}
	});

	it("a non-blocked goal resets the streak without running fate", async () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-d3-reset-"));
		const engine = createEvolutionEngine(dir);
		const ctx = {
			logger: () => ({ warn: () => undefined, info: () => undefined }),
			get: (name: string) => (name === "goals" ? { get: () => ({ phase: "active" }) } : undefined),
		} as unknown as Context;
		const state = fresh();
		state.goalBlockStreak = 2;
		try {
			await runGoalBlockedFate(ctx, engine, wireAgent as never, baseConfig({ goalBlockedWrapupTurns: 3 }), state, "turn_interval", collector());
			expect(state.goalBlockStreak).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("triggers one fate assessment at the streak threshold and resets", async () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-d3-fire-"));
		const engine = createEvolutionEngine(dir);
		const { ctx, infos } = blockedCtx();
		const config = baseConfig({ goalBlockedWrapupTurns: 3, localFate: true });
		const state = fresh();
		try {
			await runGoalBlockedFate(ctx, engine, wireAgent as never, config, state, "turn_interval", collector());
			await runGoalBlockedFate(ctx, engine, wireAgent as never, config, state, "turn_interval", collector());
			expect(state.goalBlockStreak).toBe(2);
			expect(infos.some((m) => m.includes("goal-blocked trigger"))).toBe(false);

			await runGoalBlockedFate(ctx, engine, wireAgent as never, config, state, "turn_interval", collector());
			expect(state.goalBlockStreak).toBe(0);
			expect(infos.some((m) => m.includes("goal-blocked trigger"))).toBe(true);

			// a fresh streak must build up again — no immediate re-trigger
			await runGoalBlockedFate(ctx, engine, wireAgent as never, config, state, "turn_interval", collector());
			expect(state.goalBlockStreak).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
