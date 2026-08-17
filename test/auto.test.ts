/**
 * Tests for the gate turn counter: completed turns are counted from
 * running → idle transitions only, and the gate's harness view merges the
 * global store so it can recognize topics already covered cross-session.
 * Skill proposals are governed: the gate offers them to the user (consult)
 * before applying, with a rejection cooldown.
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
	advanceGateState,
	consultSkillEdits,
	loadGateHarnessView,
	SKILL_CONSULT_COOLDOWN_TURNS,
	splitSkillEdits,
	type GateState,
} from "../src/auto.js";
import { createEvolutionEngine } from "../src/service.js";
import { saveHarnessState } from "../src/state.js";
import { storePaths } from "../src/store.js";
import { emptyHarnessState, type HarnessEntry, type RefinementProposal } from "../src/types.js";
import type { Context } from "@deepseek-ai/cordis";

function fresh(): GateState {
	return { turns: 0, lastReviewAt: 0, running: false, skillRejects: new Map(), lastFateAt: 0, fateRejects: new Map() };
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
