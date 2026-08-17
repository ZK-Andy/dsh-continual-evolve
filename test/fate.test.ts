/**
 * Tests for the gate's local-fate dimension (#11 P2): the automatic review
 * gate audits the session's local entries on its own cadence and proposes
 * promote/archive — consulted first (the consultSkillEdits pattern), with a
 * decline cooldown, and never opening dialogs during compaction. The LLM
 * classification itself stays out of unit tests (stubbed); application goes
 * through the SAME proposals as the wrap-up command.
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import type { HarnessEntry, HarnessState, RefinementKind } from "../src/types.js";
import { PROMOTED_TO_KEY, SOURCED_FROM_KEY, emptyHarnessState } from "../src/types.js";
import type { AutoReviewConfig, GateState, ReviewRecord } from "../src/auto.js";
import { runGoalBlockedFate } from "../src/auto.js";
import {
	applyLocalFates,
	buildFateNotice,
	consultLocalFates,
	fateCadenceDue,
	fateSetKey,
	FATE_CONSULT_COOLDOWN_TURNS,
	planLocalFates,
	runLocalFatePhase,
} from "../src/fate.js";
import { createEvolutionEngine } from "../src/service.js";
import { saveHarnessState } from "../src/state.js";
import { storePaths } from "../src/store.js";
import type { WrapupCandidate } from "../src/wrapup.js";

function entry(id: string, kind: RefinementKind, title: string, overrides: Partial<HarnessEntry> = {}): HarnessEntry {
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
		created_at: "2026-08-17T00:00:00.000Z",
		updated_at: "2026-08-17T00:00:00.000Z",
		version: 1,
		...overrides,
	};
}

function candidateOf(entry: HarnessEntry, coveredGlobally = false): WrapupCandidate {
	return {
		kind: entry.kind,
		id: entry.id,
		title: entry.title,
		content: entry.content,
		path: entry.path,
		version: entry.version,
		metadata: entry.metadata,
		coveredGlobally,
		globalHints: [],
	};
}

function gateWith(overrides: Partial<GateState> = {}): GateState {
	return {
		turns: 6,
		lastReviewAt: 0,
		running: false,
		skillRejects: new Map(),
		lastFateAt: 0,
		fateRejects: new Map(),
		goalBlockStreak: 0,
		...overrides,
	};
}

function configWith(overrides: Partial<AutoReviewConfig> = {}): AutoReviewConfig {
	return {
		intervalTurns: 6,
		maxInputChars: 40000,
		budgetTokens: 4096,
		notifyOnAutoReview: false,
		localFate: true,
		fateIntervalTurns: 1,
		goalBlockedWrapupTurns: 0, // off by default in fate-unit tests; D3 tests enable it explicitly
		...overrides,
	};
}

const noopLogger = () => ({ info: () => {}, warn: () => {}, error: () => {} });

/** A fake llm.stream yielding a canned assessment JSON (planner.test.ts pattern). */
function llmStreaming(text: string): Context["llm"] {
	return {
		stream: async function* () {
			const chunks: StreamChunk[] = [
				{ type: "block-start", index: 0, blockType: "text" },
				{ type: "text-delta", index: 0, text },
				{ type: "block-end", index: 0, block: { type: "text", text } },
				{ type: "finish", reason: { kind: "stop" } },
			];
			for (const chunk of chunks) {
				yield chunk;
			}
		},
	} as unknown as Context["llm"];
}

const fakeAgent = {
	id: "session-fate",
	options: { provider: "test-provider", model: "test-model" },
	followup: () => {},
} as never;

describe("fateCadenceDue", () => {
	it("is due on turn_interval once the interval has elapsed", () => {
		const gate = gateWith({ turns: 10, lastFateAt: 4 });
		expect(fateCadenceDue(gate, "turn_interval", 6)).toBe(true);
	});

	it("is not due on turn_interval inside the interval", () => {
		const gate = gateWith({ turns: 9, lastFateAt: 4 });
		expect(fateCadenceDue(gate, "turn_interval", 6)).toBe(false);
	});

	it("is unconditional on compaction", () => {
		const gate = gateWith({ turns: 5, lastFateAt: 5 });
		expect(fateCadenceDue(gate, "compact", 6)).toBe(true);
	});

	it("is unconditional on goal_blocked (the gate's streak counter already gates it)", () => {
		const gate = gateWith({ turns: 5, lastFateAt: 5 });
		expect(fateCadenceDue(gate, "goal_blocked", 6)).toBe(true);
	});
});

describe("fateSetKey", () => {
	it("builds a stable sorted key from a candidate set", () => {
		const a = candidateOf(entry("first", "memory", "A"));
		const b = candidateOf(entry("second", "memory", "B"));
		expect(fateSetKey([a, b])).toBe("memory:first|memory:second");
		expect(fateSetKey([b, a])).toBe("memory:first|memory:second");
	});

	it("changes when the set changes (fresh consultation after new entries)", () => {
		const a = candidateOf(entry("first", "memory", "A"));
		const b = candidateOf(entry("second", "memory", "B"));
		expect(fateSetKey([a])).not.toBe(fateSetKey([a, b]));
	});
});

describe("planLocalFates", () => {
	function planWith(candidates: WrapupCandidate[], items: Parameters<typeof planLocalFates>[0], global: HarnessState = emptyHarnessState()) {
		return planLocalFates(items, candidates, global);
	}

	it("partitions promotes, splits, and both archive kinds", () => {
		const sourced = entry("m1", "memory", "持久结论", { metadata: { sourceSeqs: [1], sourceSession: "session-x" } });
		const covered = entry("m2", "memory", "已被全局覆盖的话题");
		const noSource = entry("m3", "memory", "操作性条目");
		const mixed = entry("m4", "memory", "混合条目", { metadata: { sourceSeqs: [2], sourceSession: "session-x" } });
		const global = emptyHarnessState();
		global.entries.memory["m2"] = entry("m2", "memory", "已被全局覆盖的话题", { scope: "global" });
		const candidates = [
			candidateOf(sourced),
			candidateOf(covered, /* coveredGlobally */ true),
			candidateOf(noSource),
			candidateOf(mixed),
		];
		const items = [
			{ key: "memory:m1", verdict: "promote" as const, reason: "durable" },
			{ key: "memory:m2", verdict: "promote" as const, reason: "should be blocked" },
			{ key: "memory:m3", verdict: "archive" as const, reason: "operational" },
			{
				key: "memory:m4",
				verdict: "archive" as const,
				reason: "snapshot half",
				promote: { title: "清洗后的持久部分", content: "only the durable part" },
			},
		];
		const plan = planWith(candidates, items, global);
		expect(plan.promotable.map((item) => item.key)).toEqual(["memory:m1"]);
		expect(plan.skipped).toEqual([{ key: "memory:m2", reason: "already covered globally" }]);
		expect(plan.silentArchives.map((item) => item.key)).toEqual(["memory:m3"]);
		expect(plan.reviewArchives.map((item) => item.key)).toEqual([]);
		expect(plan.splits.map(({ item }) => item.key)).toEqual(["memory:m4"]);
	});

	it("routes sourced+uncovered archives to review and splits that duplicate a global topic to splitSkipped", () => {
		const sourced = entry("m1", "memory", "有来源且未覆盖", { metadata: { sourceSeqs: [1], sourceSession: "session-x" } });
		const duplicate = entry("m2", "memory", "混合但清洗会重复全局", { metadata: { sourceSeqs: [2], sourceSession: "session-x" } });
		const global = emptyHarnessState();
		global.entries.memory["g"] = entry("g", "memory", "已存在的全局话题");
		const candidates = [candidateOf(sourced), candidateOf(duplicate)];
		const items = [
			{ key: "memory:m1", verdict: "archive" as const, reason: "not covered" },
			{
				key: "memory:m2",
				verdict: "archive" as const,
				reason: "duplicate split",
				promote: { title: "已存在的全局话题 2", content: "body" },
			},
		];
		const plan = planWith(candidates, items, global);
		expect(plan.reviewArchives.map((item) => item.key)).toEqual(["memory:m1"]);
		expect(plan.silentArchives).toEqual([]);
		expect(plan.splits).toEqual([]);
		expect(plan.splitSkipped[0]?.reason).toContain("globally covered");
	});

	it("defaults unmentioned candidates to keep (no action)", () => {
		const candidates = [candidateOf(entry("m1", "memory", "未提及"))];
		const plan = planWith(candidates, [], emptyHarnessState());
		expect(plan.promotable).toEqual([]);
		expect(plan.silentArchives).toEqual([]);
		expect(plan.reviewArchives).toEqual([]);
	});
});

describe("consultLocalFates", () => {
	const plan = {
		candidates: [candidateOf(entry("m1", "memory", "要提升"))],
		promotable: [{ key: "memory:m1", verdict: "promote" as const, reason: "durable" }],
		splits: [],
		silentArchives: [],
		reviewArchives: [],
		skipped: [],
		splitSkipped: [],
	};

	function userCtx(answer: "执行" | "不执行" | "throw" | "missing"): { ctx: Context; askCount: () => number } {
		let calls = 0;
		const ctx = {
			llm: llmStreaming("{}"),
			logger: noopLogger,
			userQuestions:
				answer === "missing"
					? undefined
					: {
							ask: async () => {
								calls += 1;
								if (answer === "throw") throw new Error("aborted");
								return { answers: [{ id: "evolve-fate-consult", selected: [answer] }] };
							},
						},
		} as unknown as Context;
		return { ctx, askCount: () => calls };
	}

	it("approves immediately when there is nothing to ask", async () => {
		const { ctx } = userCtx("missing");
		const emptyPlan = { ...plan, promotable: [], splits: [], reviewArchives: [] };
		const result = await consultLocalFates(ctx, fakeAgent, emptyPlan, gateWith());
		expect(result).toEqual({ approved: true, asked: false, reason: "nothing-to-ask" });
	});

	it("conservatively declines without the question service", async () => {
		const { ctx } = userCtx("missing");
		expect(await consultLocalFates(ctx, fakeAgent, plan, gateWith())).toMatchObject({ approved: false, reason: "unavailable" });
	});

	it("consents when the user chooses 执行, without recording a rejection", async () => {
		const { ctx, askCount } = userCtx("执行");
		const gate = gateWith();
		expect(await consultLocalFates(ctx, fakeAgent, plan, gate)).toMatchObject({ approved: true, asked: true, reason: "consented" });
		expect(askCount()).toBe(1);
		expect(gate.fateRejects.size).toBe(0);
	});

	it("declines on 不执行 and records the cooldown", async () => {
		const { ctx } = userCtx("不执行");
		const gate = gateWith();
		expect(await consultLocalFates(ctx, fakeAgent, plan, gate)).toMatchObject({ approved: false, asked: true, reason: "declined" });
		expect(gate.fateRejects.size).toBe(1);
	});

	it("does not re-ask a declined set within the cooldown", async () => {
		const { ctx, askCount } = userCtx("不执行");
		const gate = gateWith();
		await consultLocalFates(ctx, fakeAgent, plan, gate);
		expect(askCount()).toBe(1);
		gate.turns = FATE_CONSULT_COOLDOWN_TURNS - 1;
		expect(await consultLocalFates(ctx, fakeAgent, plan, gate)).toMatchObject({ approved: false, reason: "cooldown" });
		expect(askCount()).toBe(1);
		// after the cooldown elapses the set is offered again (recorded at turn 6)
		gate.turns = 6 + FATE_CONSULT_COOLDOWN_TURNS + 1;
		expect(await consultLocalFates(ctx, fakeAgent, plan, gate)).toMatchObject({ approved: false, reason: "declined" });
		expect(askCount()).toBe(2);
	});

	it("is conservative when the question call fails", async () => {
		const { ctx } = userCtx("throw");
		expect(await consultLocalFates(ctx, fakeAgent, plan, gateWith())).toMatchObject({ approved: false, reason: "error" });
	});
});

describe("applyLocalFates", () => {
	it("applies everything in full mode: global creates + local retirement stamps + archives", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-fate-apply-"));
		try {
			const engine = createEvolutionEngine(dir);
			const local = emptyHarnessState();
			local.entries.memory["prom"] = entry("prom", "memory", "要提升");
			local.entries.memory["spl"] = entry("spl", "memory", "混合", { metadata: { sourceSeqs: [1] } });
			local.entries.memory["arc"] = entry("arc", "memory", "操作性归档");
			saveHarnessState(storePaths(dir, "local", "session-fate").stateDir, local);

			const plan = planLocalFates(
				[
					{ key: "memory:prom", verdict: "promote", reason: "durable" },
					{
						key: "memory:spl",
						verdict: "archive",
						reason: "snapshot",
						promote: { title: "清洗结论", content: "cleaned" },
					},
					{ key: "memory:arc", verdict: "archive", reason: "operational" },
				],
				[
					candidateOf(local.entries.memory["prom"]!),
					candidateOf(local.entries.memory["spl"]!),
					candidateOf(local.entries.memory["arc"]!),
				],
				emptyHarnessState(),
			);
			expect(plan.skipped).toEqual([]);

			const localState = engine.load("local", "session-fate");
			const { applied } = applyLocalFates(engine, "session-fate", plan, localState, "full");
			expect(applied.some((line) => line.startsWith("提升 memory:prom"))).toBe(true);
			expect(applied.some((line) => line.startsWith("拆解 memory:spl"))).toBe(true);
			expect(applied.some((line) => line.startsWith("归档 memory:arc"))).toBe(true);

			const globalState = engine.load("global", undefined);
			expect(globalState.entries.memory["prom"]?.scope).toBe("global");
			expect(globalState.entries.memory["prom"]?.metadata[SOURCED_FROM_KEY]).toBe("session-fate:prom");
			expect(globalState.entries.memory["spl"]?.title).toBe("清洗结论");
			expect(globalState.entries.memory["spl"]?.content).toBe("cleaned");

			const after = engine.load("local", "session-fate");
			expect(after.entries.memory["prom"]?.metadata[PROMOTED_TO_KEY]).toBe("prom");
			expect(after.entries.memory["prom"]?.metadata.archivedAt).toBeTruthy();
			expect(after.entries.memory["spl"]?.metadata[PROMOTED_TO_KEY]).toBe("spl");
			expect(after.entries.memory["arc"]?.metadata.archivedAt).toBeTruthy();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("applies only silent archives in silent-only mode (nothing governed)", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-fate-silent-"));
		try {
			const engine = createEvolutionEngine(dir);
			const local = emptyHarnessState();
			local.entries.memory["prom"] = entry("prom", "memory", "要提升");
			local.entries.memory["arc"] = entry("arc", "memory", "操作性归档");
			saveHarnessState(storePaths(dir, "local", "session-fate").stateDir, local);

			const plan = planLocalFates(
				[
					{ key: "memory:prom", verdict: "promote", reason: "durable" },
					{ key: "memory:arc", verdict: "archive", reason: "operational" },
				],
				[candidateOf(local.entries.memory["prom"]!), candidateOf(local.entries.memory["arc"]!)],
				emptyHarnessState(),
			);
			const localState = engine.load("local", "session-fate");
			const { applied } = applyLocalFates(engine, "session-fate", plan, localState, "silent-only");
			expect(applied.some((line) => line.startsWith("提升"))).toBe(false);
			expect(applied.some((line) => line.startsWith("归档 memory:arc"))).toBe(true);
			expect(engine.load("global", undefined).entries.memory["prom"]).toBeUndefined();
			const after = engine.load("local", "session-fate");
			expect(after.entries.memory["prom"]?.metadata[PROMOTED_TO_KEY]).toBeUndefined();
			expect(after.entries.memory["arc"]?.metadata.archivedAt).toBeTruthy();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("runLocalFatePhase", () => {
	interface Harness {
		ctx: Context;
		engine: ReturnType<typeof createEvolutionEngine>;
		records: Array<Omit<ReviewRecord, "timestamp">>;
		llmCalls: () => number;
		asks: () => number;
	}

	function scenario(
		json: string,
		answers: "执行" | "不执行" | "missing",
		localEntries: Record<string, HarnessEntry>,
		globalEntries: Record<string, HarnessEntry> = {},
	): Harness {
		const dir = mkdtempSync(join(tmpdir(), "evolve-fate-phase-"));
		const engine = createEvolutionEngine(dir);
		const local = emptyHarnessState();
		local.entries.memory = localEntries;
		saveHarnessState(storePaths(dir, "local", "session-fate").stateDir, local);
		if (Object.keys(globalEntries).length > 0) {
			const global = emptyHarnessState();
			global.entries.memory = globalEntries;
			saveHarnessState(storePaths(dir, "global", undefined).stateDir, global);
		}
		let llmCount = 0;
		let askCount = 0;
		const ctx = {
			llm: {
				stream: async function* () {
					llmCount += 1;
					const chunks: StreamChunk[] = [
						{ type: "block-start", index: 0, blockType: "text" },
						{ type: "text-delta", index: 0, text: json },
						{ type: "block-end", index: 0, block: { type: "text", text: json } },
						{ type: "finish", reason: { kind: "stop" } },
					];
					for (const chunk of chunks) {
						yield chunk;
					}
				},
			},
			logger: noopLogger,
			userQuestions:
				answers === "missing"
					? undefined
					: {
							ask: async () => {
								askCount += 1;
								return { answers: [{ id: "evolve-fate-consult", selected: [answers] }] };
							},
						},
		} as unknown as Context;
		return { ctx, engine, records: [], llmCalls: () => llmCount, asks: () => askCount };
	}

	async function runAgainst(
		h: Harness,
		gate: GateState,
		reason: "turn_interval" | "compact",
		config: AutoReviewConfig = configWith(),
	): Promise<void> {
		await runLocalFatePhase(h.ctx, h.engine, fakeAgent, config, gate, reason, (entry) => h.records.push(entry));
	}

	it("promotes on user approval: global create + local stamp, audited as approved", async () => {
		const h = scenario(
			JSON.stringify({
				rationale: "durable lesson",
				items: [{ key: "memory:m1", verdict: "promote", reason: "cross-session durable" }],
			}),
			"执行",
			{ m1: entry("m1", "memory", "持久结论") },
		);
		const gate = gateWith({ turns: 6, lastFateAt: 0 });
		await runAgainst(h, gate, "turn_interval");

		expect(h.llmCalls()).toBe(1);
		const global = h.engine.load("global", undefined);
		expect(global.entries.memory["m1"]?.metadata[SOURCED_FROM_KEY]).toBe("session-fate:m1");
		const local = h.engine.load("local", "session-fate");
		expect(local.entries.memory["m1"]?.metadata[PROMOTED_TO_KEY]).toBe("m1");
		expect(local.entries.memory["m1"]?.metadata.archivedAt).toBeTruthy();
		expect(h.records.some((entry) => entry.outcome === "approved" && entry.rationale?.includes("fate:"))).toBe(true);
	});

	it("declines without applying and records the cooldown (no re-ask within it)", async () => {
		const h = scenario(
			JSON.stringify({
				rationale: "durable lesson",
				items: [{ key: "memory:m1", verdict: "promote", reason: "cross-session durable" }],
			}),
			"不执行",
			{ m1: entry("m1", "memory", "持久结论") },
		);
		const gate = gateWith({ turns: 6, lastFateAt: 0 });
		await runAgainst(h, gate, "turn_interval");

		expect(h.asks()).toBe(1);
		expect(h.engine.load("global", undefined).entries.memory["m1"]).toBeUndefined();
		expect(h.engine.load("local", "session-fate").entries.memory["m1"]?.metadata.archivedAt).toBeUndefined();
		expect(h.records.some((entry) => entry.outcome === "declined")).toBe(true);
		expect(gate.fateRejects.size).toBe(1);

		// Same set, same session, still inside the cooldown: no second LLM call.
		const gate2 = gateWith({ turns: 8, lastFateAt: 6, fateRejects: new Map(gate.fateRejects) });
		await runAgainst(h, gate2, "turn_interval");
		expect(h.llmCalls()).toBe(1);

		// After the cooldown elapses the set is assessed (and can be approved).
		const gate3 = gateWith({ turns: 20, lastFateAt: 6, fateRejects: new Map(gate.fateRejects) });
		const h3 = scenario(
			JSON.stringify({
				rationale: "durable lesson",
				items: [{ key: "memory:m1", verdict: "promote", reason: "cross-session durable" }],
			}),
			"执行",
			{ m1: entry("m1", "memory", "持久结论") },
		);
		await runAgainst(h3, gate3, "turn_interval");
		expect(h3.llmCalls()).toBe(1);
		expect(h3.engine.load("global", undefined).entries.memory["m1"]).toBeTruthy();
	});

	it("is conservative without the question service (nothing governed applied)", async () => {
		const h = scenario(
			JSON.stringify({
				rationale: "durable lesson",
				items: [{ key: "memory:m1", verdict: "promote", reason: "cross-session durable" }],
			}),
			"missing",
			{ m1: entry("m1", "memory", "持久结论") },
		);
		const gate = gateWith();
		await runAgainst(h, gate, "turn_interval");
		expect(h.engine.load("global", undefined).entries.memory["m1"]).toBeUndefined();
		expect(h.records.some((entry) => entry.outcome === "deferred")).toBe(true);
	});

	it("defers even silent archives when the question call fails (conservative)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-fate-error-"));
		try {
			const engine = createEvolutionEngine(dir);
			const local = emptyHarnessState();
			// One covered-globally entry (would silently archive) + one promote.
			local.entries.memory["dup"] = entry("dup", "memory", "已被全局覆盖的话题");
			local.entries.memory["m1"] = entry("m1", "memory", "持久结论");
			saveHarnessState(storePaths(dir, "local", "session-fate").stateDir, local);
			const global = emptyHarnessState();
			global.entries.memory["dup"] = entry("dup", "memory", "已被全局覆盖的话题", { scope: "global" });
			saveHarnessState(storePaths(dir, "global", undefined).stateDir, global);
			let asked = false;
			const ctx = {
				llm: llmStreaming(
					JSON.stringify({
						rationale: "one covered archive, one promote",
						items: [
							{ key: "memory:dup", verdict: "archive", reason: "covered globally" },
							{ key: "memory:m1", verdict: "promote", reason: "durable" },
						],
					}),
				),
				logger: noopLogger,
				userQuestions: { ask: async () => { asked = true; throw new Error("dialog aborted"); } },
			} as unknown as Context;
			const records: Array<Omit<ReviewRecord, "timestamp">> = [];
			const gate = gateWith();
			await runLocalFatePhase(ctx, engine, fakeAgent, configWith(), gate, "turn_interval", (entry) => records.push(entry));
			expect(asked).toBe(true);
			const after = engine.load("local", "session-fate");
			expect(after.entries.memory["dup"]?.metadata.archivedAt).toBeUndefined();
			expect(after.entries.memory["m1"]?.metadata.archivedAt).toBeUndefined();
			expect(engine.load("global", undefined).entries.memory["m1"]).toBeUndefined();
			expect(records.some((entry) => entry.outcome === "deferred")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("at compaction archives silently but defers governed actions without a dialog", async () => {
		const h = scenario(
			JSON.stringify({
				rationale: "one covered archive, one promote",
				items: [
					{ key: "memory:dup", verdict: "archive", reason: "covered globally" },
					{ key: "memory:m1", verdict: "promote", reason: "durable" },
				],
			}),
			"missing", // must NOT be consulted at compaction even with a service
			{
				dup: entry("dup", "memory", "已被全局覆盖的话题"),
				m1: entry("m1", "memory", "持久结论"),
			},
			{ dup: entry("dup", "memory", "已被全局覆盖的话题", { scope: "global" }) },
		);
		const gate = gateWith({ turns: 5, lastFateAt: 0 });
		await runAgainst(h, gate, "compact");

		expect(h.asks()).toBe(0);
		const local = h.engine.load("local", "session-fate");
		expect(local.entries.memory["dup"]?.metadata.archivedAt).toBeTruthy();
		expect(local.entries.memory["m1"]?.metadata.archivedAt).toBeUndefined();
		expect(h.engine.load("global", undefined).entries.memory["m1"]).toBeUndefined();
		expect(h.records.some((entry) => entry.outcome === "approved")).toBe(true);
		expect(h.records.some((entry) => entry.outcome === "deferred" && entry.rationale?.includes("/evolve wrapup"))).toBe(true);
	});

	it("records failed and does not crash when the assessor errors", async () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-fate-fail-"));
		try {
			const engine = createEvolutionEngine(dir);
			const local = emptyHarnessState();
			local.entries.memory["m1"] = entry("m1", "memory", "持久结论");
			saveHarnessState(storePaths(dir, "local", "session-fate").stateDir, local);
			const ctx = {
				llm: {
					stream: async function* () {
						throw new Error("provider down");
					},
				},
				logger: noopLogger,
			} as unknown as Context;
			const records: Array<Omit<ReviewRecord, "timestamp">> = [];
			const gate = gateWith();
			await runLocalFatePhase(ctx, engine, fakeAgent, configWith(), gate, "turn_interval", (entry) => records.push(entry));
			expect(records.some((entry) => entry.outcome === "failed" && entry.rationale?.includes("provider down"))).toBe(true);
			expect(engine.load("global", undefined).entries.memory["m1"]).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("respects the fate cadence on turn_interval (no assessment inside the interval)", async () => {
		const h = scenario(
			JSON.stringify({
				rationale: "durable lesson",
				items: [{ key: "memory:m1", verdict: "promote", reason: "durable" }],
			}),
			"执行",
			{ m1: entry("m1", "memory", "持久结论") },
		);
		const gate = gateWith({ turns: 6, lastFateAt: 5 }); // only 1 turn since last fate
		await runAgainst(h, gate, "turn_interval", configWith({ fateIntervalTurns: 6 }));
		expect(h.llmCalls()).toBe(0);
		expect(h.engine.load("global", undefined).entries.memory["m1"]).toBeUndefined();
	});

	it("is a no-op when the dimension is disabled", async () => {
		const h = scenario(
			JSON.stringify({
				rationale: "durable lesson",
				items: [{ key: "memory:m1", verdict: "promote", reason: "durable" }],
			}),
			"执行",
			{ m1: entry("m1", "memory", "持久结论") },
		);
		const gate = gateWith();
		await runAgainst(h, gate, "turn_interval", configWith({ localFate: false }));
		expect(h.llmCalls()).toBe(0);
		expect(h.engine.load("global", undefined).entries.memory["m1"]).toBeUndefined();
	});
});

describe("buildFateNotice", () => {
	it("lists the applied actions with the rollback pointer", () => {
		const notice = buildFateNotice(["提升 memory:m1 → 全局 store", "归档 memory:m2「旧结论」"]);
		expect(notice).toContain("提升 memory:m1");
		expect(notice).toContain("归档 memory:m2");
		expect(notice).toContain("/evolve rollback");
	});
});

describe("goal-blocked trigger (D3)", () => {
	const ASSESS = JSON.stringify({
		rationale: "durable lesson",
		items: [{ key: "memory:m1", verdict: "promote", reason: "blocked 教训值得沉淀" }],
	});

	/** A ctx whose goal service reports the requested phase; "none" = no service at all. */
	function goalCtx(phase: "blocked" | "active" | "none", json: string): Context {
		const goals = phase === "none" ? undefined : { get: () => ({ id: "g1", revision: 1, objective: "o", phase, maxGoalRounds: 10 }) };
		return {
			get: (name: string) => (name === "goals" ? goals : undefined),
			llm: llmStreaming(json),
			logger: noopLogger,
			userQuestions: { ask: async () => ({ answers: [{ id: "evolve-fate-consult", selected: ["执行"] }] }) },
		} as unknown as Context;
	}

	function blockedHarness(): { dir: string; engine: ReturnType<typeof createEvolutionEngine>; records: Array<Omit<ReviewRecord, "timestamp">> } {
		const dir = mkdtempSync(join(tmpdir(), "evolve-goal-blocked-"));
		const engine = createEvolutionEngine(dir);
		const local = emptyHarnessState();
		local.entries.memory["m1"] = entry("m1", "memory", "goal 卡住的教训");
		saveHarnessState(storePaths(dir, "local", "session-fate").stateDir, local);
		return { dir, engine, records: [] };
	}

	it("counts consecutive blocked runs and triggers ONE assessment at the threshold", async () => {
		const h = blockedHarness();
		try {
			const gate = gateWith();
			const config = configWith({ goalBlockedWrapupTurns: 3 });
			// First two runs: streak 1 → 2, no assessment (no LLM call, no audit).
			await runGoalBlockedFate(goalCtx("blocked", ASSESS), h.engine, fakeAgent, config, gate, "turn_interval", (e) => h.records.push(e));
			await runGoalBlockedFate(goalCtx("blocked", ASSESS), h.engine, fakeAgent, config, gate, "turn_interval", (e) => h.records.push(e));
			expect(gate.goalBlockStreak).toBe(2);
			expect(h.records).toHaveLength(0);
			// Third run: threshold reached → one local-fate assessment, streak reset.
			await runGoalBlockedFate(goalCtx("blocked", ASSESS), h.engine, fakeAgent, config, gate, "turn_interval", (e) => h.records.push(e));
			expect(gate.goalBlockStreak).toBe(0);
			expect(h.records.length).toBeGreaterThan(0);
			expect(h.records.some((e) => e.outcome === "approved")).toBe(true);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("resets the streak on a non-blocked goal", async () => {
		const h = blockedHarness();
		try {
			const gate = gateWith();
			const config = configWith({ goalBlockedWrapupTurns: 3 });
			await runGoalBlockedFate(goalCtx("blocked", ASSESS), h.engine, fakeAgent, config, gate, "turn_interval", () => {});
			expect(gate.goalBlockStreak).toBe(1);
			await runGoalBlockedFate(goalCtx("active", ASSESS), h.engine, fakeAgent, config, gate, "turn_interval", () => {});
			expect(gate.goalBlockStreak).toBe(0);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("is disabled when goalBlockedWrapupTurns is 0", async () => {
		const h = blockedHarness();
		try {
			const gate = gateWith();
			const config = configWith({ goalBlockedWrapupTurns: 0 });
			for (let i = 0; i < 5; i += 1) {
				await runGoalBlockedFate(goalCtx("blocked", ASSESS), h.engine, fakeAgent, config, gate, "turn_interval", (e) => h.records.push(e));
			}
			expect(gate.goalBlockStreak).toBe(0);
			expect(h.records).toHaveLength(0);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});

	it("is a no-op without the goals service", async () => {
		const h = blockedHarness();
		try {
			const gate = gateWith();
			const config = configWith({ goalBlockedWrapupTurns: 3 });
			await runGoalBlockedFate(goalCtx("none", ASSESS), h.engine, fakeAgent, config, gate, "turn_interval", (e) => h.records.push(e));
			expect(gate.goalBlockStreak).toBe(0);
			expect(h.records).toHaveLength(0);
		} finally {
			rmSync(h.dir, { recursive: true, force: true });
		}
	});
});