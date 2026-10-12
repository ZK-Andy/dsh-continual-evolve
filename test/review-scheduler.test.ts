import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	collectCandidates,
	createReviewScheduler,
	runReviewBatch,
	todayUtc,
	type ReviewLlm,
} from "../src/review.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

let dbPath = "";
let store: MemoryStore;
const WS = "/tmp/work/review-scheduler-tests";
let savedDshHome: string | undefined;

beforeEach(async () => {
	dbPath = join(mkdtempSync(join(tmpdir(), "evolve-review-sched-")), "memory.db");
	store = await openMemoryStore(dbPath);
	mkdirSync(WS, { recursive: true });
	const home = mkdtempSync(join(tmpdir(), "evolve-review-sched-home-"));
	savedDshHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
});

afterEach(() => {
	if (savedDshHome === undefined) {
		delete process.env.DSH_HOME;
	} else {
		process.env.DSH_HOME = savedDshHome;
	}
	store.close();
});

function createSkill(ws: string, id: string, scope?: "project" | "global"): void {
	const { outcomes } = store.applySkillProposals(
		{ workspaceId: ws, trigger: "explicit", sessionId: "sess-1" },
		[{ action: "create", scope, id, title: `Title ${id}`, description: `steps for ${id}`, body: `1. build ${id}` }],
	);
	expect(outcomes[0]?.ok).toBe(true);
}

function fakeLlm(scenes: { gate: string; evolve: string }): ReviewLlm {
	return {
		async *stream(options: Record<string, unknown>): AsyncIterable<unknown> {
			const system = options.system as string;
			yield { type: "text-delta", text: system.includes("评审门") ? scenes.gate : scenes.evolve };
			yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
			yield { type: "finish", reason: { kind: "stop" } };
		},
	};
}

function throwingLlm(): ReviewLlm {
	return {
		async *stream(): AsyncIterable<unknown> {
			throw new Error("route down");
			yield { type: "text-delta", text: "unreachable" };
		},
	};
}

const flush = async (): Promise<void> => {
	for (let i = 0; i < 5; i += 1) {
		await new Promise((resolve) => setImmediate(resolve));
	}
};

describe("skill candidates", () => {
	it("lists project skills with scope and shadows globals", () => {
		createSkill(WS, "deploy", "project");
		// Global rows only come from manual moves, never direct creates.
		createSkill(WS, "shared", "project");
		const { outcomes } = store.applySkillProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{ action: "move-to-global", id: "shared" }],
		);
		expect(outcomes[0]?.ok).toBe(true);
		const found = collectCandidates(store, { limit: 10 });
		expect(found.find((c) => c.id === "deploy")).toMatchObject({ kind: "skill", scope: "project", priority: 0 });
		expect(found.find((c) => c.id === "shared")).toMatchObject({ scope: "global" });
	});

	it("applies skill rewrites through the skill gate", async () => {
		createSkill(WS, "deploy", "project");
		const llm = fakeLlm({
			gate: `{"worthReview": true, "reason": "看看"}`,
			evolve: `{"verdict": "rewrite", "reason": "补标点", "body": "1. build deploy."}`,
		});
		const candidates = collectCandidates(store, { limit: 10 }).filter((c) => c.id === "deploy");
		const summary = await runReviewBatch(
			{ store, llm }, candidates,
			{ day: "2026-10-12", budget: 100, dryRun: false, provider: "p", model: "m", sessionId: "s" },
		);
		expect(summary).toMatchObject({ approved: 1, applied: 1 });
		expect(store.getSkill(WS, "deploy")?.body).toBe("1. build deploy.");
	});

	it("quarantines skills without deleting them", async () => {
		createSkill(WS, "deploy", "project");
		const llm = fakeLlm({
			gate: `{"worthReview": true, "reason": "看看"}`,
			evolve: `{"verdict": "quarantine", "reason": "涉密"}`,
		});
		const candidates = collectCandidates(store, { limit: 10 }).filter((c) => c.id === "deploy");
		await runReviewBatch(
			{ store, llm }, candidates,
			{ day: "2026-10-12", budget: 100, dryRun: false, provider: "p", model: "m", sessionId: "s" },
		);
		expect(store.listAllSkills(WS).find((r) => r.id === "deploy")?.status).toBe("quarantined");
	});

	it("defaults missing skill scopes to project and ledgers gate refusals", async () => {
		const llm = fakeLlm({
			gate: `{"worthReview": true, "reason": "看看"}`,
			evolve: `{"verdict": "rewrite", "reason": "补", "body": "1. build ghost"}`,
		});
		const summary = await runReviewBatch(
			{ store, llm },
			[{ workspaceId: WS, kind: "skill", id: "ghost", priority: 0, title: "Ghost", description: "h", body: "1. build ghost" }],
			{ day: "2026-10-12", budget: 100, dryRun: false, provider: "p", model: "m", sessionId: "s" },
		);
		expect(summary).toMatchObject({ approved: 1, applied: 0 });
	});
});

describe("failure discipline", () => {
	it("degrades throwing LLM calls to skip rows and keeps the run alive", async () => {
		const [outcome] = store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{ action: "create", type: "user", title: "t", description: "d", body: "b" }],
		);
		expect(outcome?.ok).toBe(true);
		const candidates = collectCandidates(store, { limit: 10 });
		const summary = await runReviewBatch(
			{ store, llm: throwingLlm() }, candidates,
			{ day: "2026-10-12", budget: 100, dryRun: false, provider: "p", model: "m", sessionId: "s" },
		);
		expect(summary).toMatchObject({ reviewed: 1, approved: 0 });
		expect(store.getDaily("2026-10-12")?.skipTop).toContain("gate-llm-failed");
	});
});

describe("todayUtc", () => {
	it("returns the UTC day prefix", () => {
		expect(todayUtc()).toBe(new Date().toISOString().slice(0, 10));
	});
});

describe("createReviewScheduler", () => {
	function host() {
		const handlers = new Map<string, (...args: never[]) => void>();
		const warns: string[] = [];
		return {
			handlers,
			warns,
			on: vi.fn((event: string, handler: (...args: never[]) => void): unknown => {
				handlers.set(event, handler);
				return (): void => {
					handlers.delete(event);
				};
			}),
			logger: () => ({ info: (): void => {}, warn: (message: string): void => { warns.push(message); } }),
		};
	}

	function agent(id: string, cwd?: string) {
		return { id, options: { provider: "p", model: "m" }, session: cwd === undefined ? undefined : { header: { cwd } } };
	}

	it("drains one batch on turn-stopping and respects the minimum interval", async () => {
		store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{ action: "create", type: "user", title: "t", description: "d", body: "b" }],
		);
		const h = host();
		const llm = fakeLlm({ gate: `{"worthReview": false, "reason": "略"}`, evolve: `{"verdict": "keep", "reason": "x"}` });
		const dispose = createReviewScheduler(h, { store, llm }, {
			enabled: true, dryRun: true, dailyBudget: 100, batchSize: 10, staleDays: 30, minIntervalMs: 60_000,
		});
		h.handlers.get("agent/turn-stopping")?.({ agent: agent("sess-1") } as never);
		await flush();
		expect(store.getDaily(todayUtc())?.reviewed).toBe(1);
		// Second boundary inside the interval only re-arms, never re-runs.
		h.handlers.get("agent/turn-stopping")?.({ agent: agent("sess-1") } as never);
		await flush();
		expect(store.getDaily(todayUtc())?.reviewed).toBe(1);
		dispose();
	});

	it("drains on compaction and session close without a model route it stays quiet", async () => {
		const h = host();
		const llm = fakeLlm({ gate: `{"worthReview": false, "reason": "略"}`, evolve: `{"verdict": "keep", "reason": "x"}` });
		const dispose = createReviewScheduler(h, { store, llm }, {
			enabled: true, dryRun: true, dailyBudget: 100, batchSize: 10, staleDays: 30, minIntervalMs: 0,
		});
		// No route seen yet: drains stay quiet and ledger nothing.
		h.handlers.get("session/event")?.({ id: "sess-1" } as never, { type: "compaction/start" } as never);
		await flush();
		expect(store.getDaily(todayUtc())).toBeUndefined();
		h.handlers.get("agent/disposed")?.({ agent: agent("sess-1") } as never);
		await flush();
		expect(store.getDaily(todayUtc())).toBeUndefined();
		dispose();
	});

	it("stays inert when disabled", async () => {
		const h = host();
		const dispose = createReviewScheduler(h, { store, llm: undefined }, {
			enabled: false, dryRun: true, dailyBudget: 100, batchSize: 10, staleDays: 30, minIntervalMs: 0,
		});
		h.handlers.get("agent/turn-stopping")?.({ agent: agent("sess-1") } as never);
		await flush();
		expect(store.getDaily(todayUtc())).toBeUndefined();
		dispose();
	});

	it("orders the drain by triggering workspace and drops overlapping drains", async () => {
		store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{ action: "create", type: "user", title: "t", description: "d", body: "b" }],
		);
		const h = host();
		const llm = fakeLlm({ gate: `{"worthReview": false, "reason": "略"}`, evolve: `{"verdict": "keep", "reason": "x"}` });
		const dispose = createReviewScheduler(h, { store, llm }, {
			enabled: true, dryRun: false, dailyBudget: 100, batchSize: 10, staleDays: 30, minIntervalMs: 0,
		});
		// Two boundaries in the same tick: the second lands while the first
		// still runs and re-arms instead of overlapping.
		h.handlers.get("agent/turn-stopping")?.({ agent: agent("sess-1", WS) } as never);
		h.handlers.get("agent/turn-stopping")?.({ agent: agent("sess-1", WS) } as never);
		await flush();
		expect(store.getDaily(todayUtc())?.reviewed).toBe(1);
		dispose();
	});

	it("ignores malformed payloads and unrelated session events", async () => {
		const h = host();
		const llm = fakeLlm({ gate: `{"worthReview": false, "reason": "略"}`, evolve: `{"verdict": "keep", "reason": "x"}` });
		const dispose = createReviewScheduler(h, { store, llm }, {
			enabled: true, dryRun: true, dailyBudget: 100, batchSize: 10, staleDays: 30, minIntervalMs: 0,
		});
		h.handlers.get("agent/turn-stopping")?.({} as never);
		h.handlers.get("agent/turn-stopping")?.({ agent: {} } as never);
		h.handlers.get("session/event")?.({ id: "sess-1" } as never, { type: "other" } as never);
		h.handlers.get("session/event")?.({ id: 42 } as never, { type: "compaction/start" } as never);
		await flush();
		expect(store.getDaily(todayUtc())).toBeUndefined();
		dispose();
	});

	it("stays quiet past the daily budget and warns when the drain itself fails", async () => {
		store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{ action: "create", type: "user", title: "t", description: "d", body: "b" }],
		);
		const h = host();
		const llm = fakeLlm({ gate: `{"worthReview": false, "reason": "略"}`, evolve: `{"verdict": "keep", "reason": "x"}` });
		expect(store.consumeReviewBudget(todayUtc(), 1)).toBe(0);
		const dispose = createReviewScheduler(h, { store, llm }, {
			enabled: true, dryRun: true, dailyBudget: 1, batchSize: 10, staleDays: 30, minIntervalMs: 0,
		});
		h.handlers.get("agent/turn-stopping")?.({ agent: agent("sess-1", WS) } as never);
		await flush();
		expect(store.getDaily(todayUtc())?.reviewed).toBe(1);

		// A store that blows up mid-drain degrades to one warn, never a throw.
		const broken = { ...store, listWorkspaces: (): never => { throw new Error("disk gone"); } };
		const h2 = host();
		const dispose2 = createReviewScheduler(h2, { store: broken as MemoryStore, llm }, {
			enabled: true, dryRun: true, dailyBudget: 100, batchSize: 10, staleDays: 30, minIntervalMs: 0,
		});
		h2.handlers.get("agent/turn-stopping")?.({ agent: agent("sess-2", WS) } as never);
		await flush();
		expect(h2.warns.some((w) => w.includes("review drain failed"))).toBe(true);
		dispose();
		dispose2();
	});
});
