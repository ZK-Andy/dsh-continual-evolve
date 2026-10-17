import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { todayUtc } from "../src/services/prompt-date.js";
import { collectCandidates } from "../src/services/review-candidates.js";
import { runReviewBatch, type ReviewLlm } from "../src/services/review.js";
import { createReviewScheduler, type ReviewSettings } from "../src/services/review-scheduler.js";
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

/** The scheduler re-reads these per drain, so tests hand it a mutable box. */
function settings(over: Partial<ReviewSettings> = {}): ReviewSettings {
	return Object.assign({ dryRun: true, dailyBudget: 100, batchSize: 10, staleDays: 30 }, over);
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

/** A gate whose stream is cut at its budget; the evolve call stays healthy. */
function cutGateLlm(gateText: string): ReviewLlm {
	return {
		async *stream(options: Record<string, unknown>): AsyncIterable<unknown> {
			const system = options.system as string;
			if (system.includes("评审门")) {
				yield { type: "text-delta", text: gateText };
				yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
				yield { type: "finish", reason: { kind: "max-tokens" } };
				return;
			}
			yield { type: "text-delta", text: `{"verdict": "keep", "reason": "x"}` };
			yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
			yield { type: "finish", reason: { kind: "stop" } };
		},
	};
}

/** An LLM that always refuses the route with one host failure code. */
function refusedLlm(code: string): ReviewLlm & { calls: number } {
	const llm = {
		calls: 0,
		async *stream(): AsyncIterable<unknown> {
			llm.calls += 1;
			const error = new Error("opencode-go API error (403)") as Error & { code: string };
			error.code = code;
			throw error;
			yield { type: "text-delta", text: "unreachable" };
		},
	};
	return llm;
}

function throwingLlm(): ReviewLlm {
	return {
		async *stream(): AsyncIterable<unknown> {
			throw new Error("route down");
			yield { type: "text-delta", text: "unreachable" };
		},
	};
}

function rawReviewRows(): { reason: string | null; verdict: string }[] {
	const db = new DatabaseSync(dbPath);
	try {
		return db.prepare("SELECT reason, verdict FROM review_log ORDER BY rowid").all() as { reason: string | null; verdict: string }[];
	} finally {
		db.close();
	}
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
		expect(found.find((c) => c.id === "deploy")).toMatchObject({ kind: "skill", scope: "project", priority: 0, source: "new" });
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
			[{ workspaceId: WS, kind: "skill", id: "ghost", priority: 0, source: "new", title: "Ghost", description: "h", body: "1. build ghost" }],
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

	it("keeps a gate verdict that arrived before the budget cut", async () => {
		store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{ action: "create", type: "user", title: "t", description: "d", body: "b" }],
		);
		const candidates = collectCandidates(store, { limit: 10 });
		const summary = await runReviewBatch(
			{ store, llm: cutGateLlm(`{"worthReview": true, "reason": "值得看"}`) }, candidates,
			{ day: "2026-10-12", budget: 100, dryRun: true, provider: "p", model: "m", sessionId: "s" },
		);
		// The JSON completed before the cut: a real verdict, not a failure.
		expect(summary).toMatchObject({ reviewed: 1, approved: 1 });
		expect(store.getDaily("2026-10-12")?.skipTop ?? "").not.toContain("gate-llm-failed");
	});

	it("fails a cut gate that left no usable verdict", async () => {
		store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{ action: "create", type: "user", title: "t", description: "d", body: "b" }],
		);
		const candidates = collectCandidates(store, { limit: 10 });
		const summary = await runReviewBatch(
			{ store, llm: cutGateLlm(`{"worthReview": tr`) }, candidates,
			{ day: "2026-10-12", budget: 100, dryRun: true, provider: "p", model: "m", sessionId: "s" },
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
		const infos: string[] = [];
		return {
			handlers,
			warns,
			infos,
			on: vi.fn((event: string, handler: (...args: never[]) => void): unknown => {
				handlers.set(event, handler);
				return (): void => {
					handlers.delete(event);
				};
			}),
			log: {
				info: (event: string, message: string): void => { infos.push(`${event}: ${message}`); },
				warn: (event: string, message: string): void => { warns.push(`${event}: ${message}`); },
				error: (event: string, message: string): void => { warns.push(`${event}: ${message}`); },
			},
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
			enabled: true, read: () => settings(), minIntervalMs: 60_000,
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

	it("stops the drain when the route is refused, and halts that route", async () => {
		for (const id of ["a", "b", "c"]) {
			store.applyProposals(
				{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
				[{ action: "create", id, type: "user", title: `title ${id}`, description: `d ${id}`, body: `b ${id}` }],
			);
		}
		const h = host();
		const refused = refusedLlm("AUTH");
		let routeModel = "refused";
		let llm: ReviewLlm = refused;
		const dispose = createReviewScheduler(h, {
			store,
			get llm() {
				return llm;
			},
			resolveRoute: () => ({ selection: { provider: "p", model: routeModel }, source: "agent-options" }),
		}, { enabled: true, read: () => settings(), minIntervalMs: 0 });

		const boundary = () => h.handlers.get("agent/turn-stopping")?.({ agent: { id: "sess-1", session: { header: { cwd: WS } } } } as never);
		boundary();
		await flush();

		// Only the first candidate paid for the refusal (its gate leg is the first
		// call made, and the refusal is terminal, so no evolve leg runs); the rest
		// stayed queued instead of each buying the same refusal.
		expect(refused.calls).toBe(1);
		const daily = store.getDaily(todayUtc());
		expect(daily?.reviewed).toBe(1);
		expect(daily?.dropped).toBe(0);
		expect(rawReviewRows().filter((row) => row.reason === "route-rejected")).toHaveLength(1);
		expect(h.warns.some((line) => line.startsWith("route-halted"))).toBe(true);

		// The next boundary on the same route sends nothing at all.
		const before = store.getDaily(todayUtc())?.reviewed ?? 0;
		boundary();
		await flush();
		expect(refused.calls).toBe(1);
		expect(store.getDaily(todayUtc())?.reviewed).toBe(before);

		// A different route is the unfreeze, and it reviews again.
		routeModel = "healthy";
		llm = fakeLlm({ gate: `{"worthReview": false, "reason": "略"}`, evolve: `{"verdict": "keep", "reason": "x"}` });
		boundary();
		await flush();
		expect(h.infos.some((line) => line.startsWith("route-unfrozen"))).toBe(true);
		expect(store.getDaily(todayUtc())?.reviewed).toBeGreaterThan(before);
		dispose();
	});

	it("stops the drain when the evolve leg is refused", async () => {
		for (const id of ["a", "b"]) {
			store.applyProposals(
				{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
				[{ action: "create", id, type: "user", title: `title ${id}`, description: `d ${id}`, body: `b ${id}` }],
			);
		}
		const h = host();
		let calls = 0;
		const llm: ReviewLlm = {
			async *stream(options: Record<string, unknown>): AsyncIterable<unknown> {
				calls += 1;
				if ((options.system as string).includes("评审门")) {
					yield { type: "text-delta", text: `{"worthReview": true, "reason": "略"}` };
					yield { type: "finish", reason: { kind: "stop" } };
					return;
				}
				throw Object.assign(new Error("opencode-go API error (403)"), { code: "AUTH" });
			},
		};
		const dispose = createReviewScheduler(h, {
			store, llm,
			resolveRoute: () => ({ selection: { provider: "p", model: "refused" }, source: "agent-options" }),
		}, { enabled: true, read: () => settings(), minIntervalMs: 0 });

		h.handlers.get("agent/turn-stopping")?.({ agent: { id: "sess-1", session: { header: { cwd: WS } } } } as never);
		await flush();

		// Gate plus evolve for the first candidate; the second never starts.
		expect(calls).toBe(2);
		expect(store.getDaily(todayUtc())?.reviewed).toBe(1);
		expect(store.getDaily(todayUtc())?.dropped).toBe(0);
		expect(rawReviewRows().some((row) => row.reason?.startsWith("evolve-llm-failed"))).toBe(true);
		expect(rawReviewRows().filter((row) => row.reason === "route-rejected")).toHaveLength(1);
		dispose();
	});

	it("traces which candidate supplied the route", async () => {
		store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{ action: "create", type: "user", title: "t", description: "d", body: "b" }],
		);
		const h = host();
		const llm = fakeLlm({ gate: `{"worthReview": false, "reason": "略"}`, evolve: `{"verdict": "keep", "reason": "x"}` });
		const dispose = createReviewScheduler(h, {
			store, llm,
			resolveRoute: () => ({ selection: { provider: "dsh-opencode-go", model: "deepseek-v4.1-flash" }, source: "session-selection" }),
		}, { enabled: true, read: () => settings(), minIntervalMs: 0 });

		h.handlers.get("agent/turn-stopping")?.({ agent: { id: "sess-1", session: { header: { cwd: WS } } } } as never);
		await flush();

		expect(h.infos).toContain("route-resolved: dsh-opencode-go/deepseek-v4.1-flash via session-selection (review drain)");
		dispose();
	});

	it("stays quiet on compaction and session close, because neither carries a live route", async () => {
		const h = host();
		const llm = fakeLlm({ gate: `{"worthReview": false, "reason": "略"}`, evolve: `{"verdict": "keep", "reason": "x"}` });
		const dispose = createReviewScheduler(h, { store, llm }, {
			enabled: true, read: () => settings(), minIntervalMs: 0,
		});
		// Neither boundary has a session to call on: nothing is drained here.
		h.handlers.get("session/event")?.({ id: "sess-1" } as never, { type: "compaction/start" } as never);
		await flush();
		expect(store.getDaily(todayUtc())).toBeUndefined();
		h.handlers.get("agent/disposed")?.({ agent: agent("sess-1") } as never);
		await flush();
		expect(store.getDaily(todayUtc())).toBeUndefined();
		dispose();
	});

	it("falls back to the host default model when the session carries no explicit selection", async () => {
		store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{ action: "create", type: "user", title: "t", description: "d", body: "b" }],
		);
		const h = host();
		const llm = fakeLlm({ gate: `{"worthReview": false, "reason": "略"}`, evolve: `{"verdict": "keep", "reason": "x"}` });
		const dispose = createReviewScheduler(h, {
			store, llm,
			resolveRoute: () => ({ selection: { provider: "dsh-opencode-go", model: "deepseek-v4.1-flash" }, source: "agent-options" }),
		}, { enabled: true, read: () => settings(), minIntervalMs: 0 });
		// The session has no explicit selection at all — only the default model.
		h.handlers.get("agent/turn-stopping")?.({ agent: { id: "sess-1", session: { header: { cwd: WS } } } } as never);
		await flush();
		expect(store.getDaily(todayUtc())?.reviewed).toBe(1);
		dispose();
	});

	it("refuses to call when neither the session nor the host has a route", async () => {
		store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{ action: "create", type: "user", title: "t", description: "d", body: "b" }],
		);
		const h = host();
		let calls = 0;
		const llm: ReviewLlm = {
			async *stream(): AsyncIterable<unknown> {
				calls += 1;
				yield { type: "finish", reason: { kind: "stop" } };
			},
		};
		const dispose = createReviewScheduler(h, { store, llm, resolveRoute: () => undefined }, {
			enabled: true, read: () => settings(), minIntervalMs: 0,
		});
		h.handlers.get("agent/turn-stopping")?.({ agent: { id: "sess-1", session: { header: { cwd: WS } } } } as never);
		await flush();
		expect(calls).toBe(0);
		expect(store.getDaily(todayUtc())).toBeUndefined();
		dispose();
	});

	it("detaches its listener on dispose, so a remount never double-reviews", () => {
		const h = host();
		const llm = fakeLlm({ gate: `{"worthReview": false, "reason": "略"}`, evolve: `{"verdict": "keep", "reason": "x"}` });
		const dispose = createReviewScheduler(h, { store, llm }, {
			enabled: true, read: () => settings(), minIntervalMs: 0,
		});
		expect(h.handlers.has("agent/turn-stopping")).toBe(true);
		dispose();
		expect(h.handlers.has("agent/turn-stopping")).toBe(false);
	});

	it("stays inert when disabled", async () => {
		const h = host();
		const dispose = createReviewScheduler(h, { store, llm: undefined }, {
			enabled: false, read: () => settings(), minIntervalMs: 0,
		});
		h.handlers.get("agent/turn-stopping")?.({ agent: agent("sess-1") } as never);
		await flush();
		expect(store.getDaily(todayUtc())).toBeUndefined();
		dispose();
	});

	it("re-reads settings on every drain so a live edit takes effect", async () => {
		store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{ action: "create", type: "user", title: "t", description: "d", body: "1. build the thing now" }],
		);
		const h = host();
		const llm = fakeLlm({
			gate: `{"worthReview": true, "reason": "值得看"}`,
			evolve: `{"verdict": "rewrite", "reason": "补", "body": "1. build the thing fast"}`,
		});
		let live = settings({ dailyBudget: 0 });
		const dispose = createReviewScheduler(h, { store, llm }, {
			enabled: true, read: () => live, minIntervalMs: 0,
		});
		// Budget 0 for today: the drain stops before reviewing, item stays new.
		h.handlers.get("agent/turn-stopping")?.({ agent: agent("sess-1", WS) } as never);
		await flush();
		expect(store.list(WS)[0]?.body).toBe("1. build the thing now");
		// The next drain sees the edit: trial off, so the rewrite lands.
		live = settings({ dailyBudget: 100, dryRun: false });
		h.handlers.get("agent/turn-stopping")?.({ agent: agent("sess-1", WS) } as never);
		await flush();
		expect(store.list(WS)[0]?.body).toBe("1. build the thing fast");
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
			enabled: true, read: () => settings({ dryRun: false }), minIntervalMs: 0,
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
			enabled: true, read: () => settings(), minIntervalMs: 0,
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
			enabled: true, read: () => settings({ dailyBudget: 1 }), minIntervalMs: 0,
		});
		h.handlers.get("agent/turn-stopping")?.({ agent: agent("sess-1", WS) } as never);
		await flush();
		expect(store.getDaily(todayUtc())?.reviewed).toBe(1);

		// A store that blows up mid-drain degrades to one warn, never a throw.
		const broken = { ...store, listWorkspaces: (): never => { throw new Error("disk gone"); } };
		const h2 = host();
		const dispose2 = createReviewScheduler(h2, { store: broken as MemoryStore, llm }, {
			enabled: true, read: () => settings(), minIntervalMs: 0,
		});
		h2.handlers.get("agent/turn-stopping")?.({ agent: agent("sess-2", WS) } as never);
		await flush();
		expect(h2.warns.some((w) => w.includes("review-drain-failed"))).toBe(true);
		dispose();
		dispose2();
	});

	it("records a failed drain in the day's rollup, not only in the log", async () => {
		store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{ action: "create", type: "user", title: "t", description: "d", body: "b" }],
		);
		const h = host();
		const llm = fakeLlm({ gate: `{"worthReview": false, "reason": "略"}`, evolve: `{"verdict": "keep", "reason": "x"}` });
		const broken = { ...store, listWorkspaces: (): never => { throw new Error("disk gone"); } };
		const dispose = createReviewScheduler(h, { store: broken as MemoryStore, llm }, {
			enabled: true, read: () => settings(), minIntervalMs: 0,
		});
		h.handlers.get("agent/turn-stopping")?.({ agent: agent("sess-9", WS) } as never);
		await flush();

		expect(h.warns.some((w) => w.includes("review-drain-failed"))).toBe(true);
		expect(store.getDaily(todayUtc())?.skipTop ?? "").toContain("drain-failed");
		dispose();
	});

	it("ledgers a failing item with its error text and merges the whole day's account", async () => {
		store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{ action: "create", type: "user", title: "t", description: "d", body: "b" }],
		);
		const candidates = collectCandidates(store);
		expect(candidates).toHaveLength(1);
		// A fault inside the chain, where a store or wiring bug lands: the evolve
		// pass's evolve-count read blows up after the gate approved the item.
		const broken = { ...store, reviewStateOf: (): never => { throw new Error("索引炸了"); } };
		const llm = fakeLlm({ gate: `{"worthReview": true, "reason": "值得"}`, evolve: `{"verdict": "quarantine", "reason": "该隔离"}` });
		const summary = await runReviewBatch({ store: broken as MemoryStore, llm }, candidates, {
			day: todayUtc(), budget: 100, dryRun: true, provider: "p", model: "m",
		});

		expect(summary.reviewed).toBe(1);
		const db = new DatabaseSync(dbPath, { readOnly: true });
		const row = db.prepare("SELECT verdict, reason FROM review_log ORDER BY rowid DESC LIMIT 1").get() as {
			verdict: string; reason: string;
		};
		db.close();
		expect(row.verdict).toBe("skip");
		expect(row.reason).toBe("review-failed: 索引炸了");
		const daily = store.getDaily(todayUtc());
		expect(daily?.reviewed).toBe(1);
		// The account is whole: a bare `reviewed` with every other counter at zero
		// is exactly the shape that hid the 2026-10-14 fault.
		expect(daily?.newItems).toBe(1);
		expect(daily?.skipTop ?? "").toContain("review-failed");
	});
});
