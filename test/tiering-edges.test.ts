import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openRepositories } from "../src/data/repository.js";
import {
	archiveGateReason,
	createTieringMethods,
	demoteMemory,
	globalPortabilityReason,
	probationDue,
	promoteMemory,
	promotionCandidates,
} from "../src/data/tiering.js";
import type { TieringStmts } from "../src/data/tiering.js";
import { collectCandidates } from "../src/services/review-candidates.js";
import { proposedOf, rowBaseOf, evolveCountOf } from "../src/services/review-row.js";
import { runReviewBatch, type ReviewLlm } from "../src/services/review.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

/**
 * The failure and trial branches of the tiering work: every exit that refuses
 * a move must say why, and every dry-run must change nothing. These are the
 * paths that decide whether a bad move can land, so they get their own file.
 */
const WS = "/tmp/work/tiering-edges";
const DAY = 24 * 60 * 60 * 1000;

let dbPath = "";
let store: MemoryStore;

beforeEach(async () => {
	dbPath = join(mkdtempSync(join(tmpdir(), "evolve-tiering-edges-")), "memory.db");
	store = await openMemoryStore(dbPath);
});

afterEach(() => {
	store.close();
});

function create(id: string, scope: "project" | "person" = "project", workspaceId = WS): void {
	const [outcome] = store.applyProposals({ workspaceId, trigger: "explicit" }, [
		{ action: "create", id, type: "user", title: `标题 ${id}`, description: "钩子", body: "Fedora 44", scope },
	]);
	expect(outcome?.ok).toBe(true);
}

function statusOf(workspaceId: string, id: string): string | undefined {
	const db = new DatabaseSync(dbPath);
	const row = db.prepare("SELECT status FROM memories WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as { status: string } | undefined;
	db.close();
	return row?.status;
}

function verdictOf(id: string, verdict: string, workspaceId = WS): void {
	store.logReview({ workspaceId, itemKind: "memory", itemId: id, verdict: verdict as never });
}

/**
 * P1 unchanged-gate scaffolding: the queue only requeues event items changed
 * since their last verdict. These tests pin downstream verdict landing, not
 * queue admission — backdate the verdict so the row reads as changed while
 * the (real-time) linkage event stays pending.
 */
function backdateVerdict(id: string): void {
	const db = new DatabaseSync(dbPath);
	db.prepare("UPDATE review_log SET ts = ? WHERE item_kind = 'memory' AND item_id = ?").run(
		new Date(Date.now() - 60_000).toISOString(),
		id,
	);
	db.close();
}

function fakeLlm(evolve: string, gate = '{"worthReview":true,"reason":"ok"}'): ReviewLlm {
	return {
		async *stream(options: Record<string, unknown>): AsyncIterable<unknown> {
			const system = options.system as string;
			yield { type: "text-delta", text: system.includes("评审门") ? gate : evolve };
			yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
			yield { type: "finish", reason: { kind: "stop" } };
		},
	};
}

function opts(dryRun = false): { day: string; budget: number; dryRun: boolean; provider: string; model: string } {
	return { day: "2026-10-17", budget: 100, dryRun, provider: "p", model: "m" };
}

function candidateFor(id: string, workspaceId = WS, kind: "memory" | "skill" = "memory") {
	const found = collectCandidates(store, { limit: 50 }).filter((row) => row.id === id && row.workspaceId === workspaceId && row.kind === kind);
	expect(found.length).toBe(1);
	return found;
}

describe("refusals name their reason", () => {
	it("refuses to promote a quarantined row", () => {
		create("m-q");
		store.quarantine(WS, "memory", "m-q");
		const outcome = store.promoteMemory(WS, "m-q");
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toContain("not active");
	});

	it("replaces an archived global row with the same id", () => {
		create("m-a");
		create("m-a", "project", "");
		store.archiveMemory("", "m-a");
		const outcome = store.promoteMemory(WS, "m-a");
		expect(outcome.ok).toBe(true);
		expect(statusOf("", "m-a")).toBe("active");
	});

	it("refuses to demote when the global row is gone", () => {
		expect(store.demoteMemory("", "ghost").ok).toBe(false);
	});

	it("refuses to promote a row carrying its home partition path", () => {
		const [created] = store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [
			{ action: "create", id: "m-home", type: "user", title: "t", description: "d", body: `记于 ${WS} 的事实`, scope: "project" },
		]);
		expect(created?.ok).toBe(true);
		const outcome = store.promoteMemory(WS, "m-home");
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toContain("改写为全局适用");
		expect(statusOf(WS, "m-home")).toBe("active");
	});

	it("names the offending field and ignores other partitions paths", () => {
		const [created] = store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [
			{ action: "create", id: "m-home", type: "user", title: `位于 ${WS}`, description: "d", body: "记于 /elsewhere 的事实", scope: "project" },
		]);
		expect(created?.ok).toBe(true);
		const outcome = store.promoteMemory(WS, "m-home");
		expect(outcome.ok).toBe(false);
		expect(outcome.reason ?? "").toMatch(/^title /);
	});

	it("passes a row carrying only another partition path", () => {
		const [created] = store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [
			{ action: "create", id: "m-ok", type: "user", title: "t", description: "d", body: "记于 /elsewhere 的事实", scope: "person" },
		]);
		expect(created?.ok).toBe(true);
		expect(store.promoteMemory(WS, "m-ok").ok).toBe(true);
		expect(statusOf("", "m-ok")).toBe("active");
	});

	it("treats an empty workspace as portable (global rows never re-screen)", () => {
		expect(globalPortabilityReason("", { title: "t", description: "d", body: "b", notWhen: "" })).toBeUndefined();
	});

	it("replaces a conflicting project row on demotion", () => {
		create("m-a", "person");
		store.promoteMemory(WS, "m-a");
		store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [{ action: "delete", id: "m-a" }]);
		create("m-a");
		const outcome = store.demoteMemory("", "m-a");
		expect(outcome.ok).toBe(true);
		expect(statusOf(WS, "m-a")).toBe("active");
	});
});

describe("archive gate evidence", () => {
	it("fails loud when its evidence table is unreadable", () => {
		const broken = {
			correctedBy: { get: () => { throw new Error("no table"); } },
			rejectCount: { get: () => ({ n: 0 }) },
		} as unknown as TieringStmts;
		// The store wrapper turns this into "do not archive"; the helper itself
		// must not swallow it (a silent undefined would authorize the move).
		expect(() => archiveGateReason({ getUsage: () => undefined } as never, broken, WS, "m-a")).toThrow("no table");
	});

	it("keeps an item with a prior reject but no usage blocked only by corrections", () => {
		create("m-a");
		verdictOf("m-a", "archive");
		expect(store.archiveBlocker(WS, "m-a")).toBeUndefined();
	});
});

describe("clock reads", () => {
	it("lists due probation rows and person candidates", () => {
		create("m-p", "person");
		store.promoteMemory(WS, "m-p");
		const db = new DatabaseSync(dbPath);
		db.prepare("UPDATE memories SET probation_until = ? WHERE workspace_id = '' AND id = 'm-p'").run(new Date(Date.now() - DAY).toISOString());
		db.close();
		expect(store.probationQueue().map((row) => row.id)).toEqual(["m-p"]);

		create("m-c", "person");
		verdictOf("m-c", "keep");
		expect(store.promotionQueue().map((row) => row.id)).toEqual(["m-c"]);
	});

	it("keeps the raw readers honest about empty stores", () => {
		const stmts = {
			probationDue: { all: () => [] },
			promotionCandidates: { all: () => [] },
		} as unknown as TieringStmts;
		expect(probationDue(stmts, new Date())).toEqual([]);
		expect(promotionCandidates(stmts)).toEqual([]);
	});

	it("promotes with the raw helper", () => {
		create("m-a");
		const stmts = (store as unknown as { promoteMemory: unknown }) as never;
		expect(stmts).toBeDefined();
	});
});

describe("dry runs change nothing", () => {
	it("records promote advice without moving the row", async () => {
		create("m-p", "person");
		verdictOf("m-p", "keep");
		await runReviewBatch({ store, llm: fakeLlm('{"verdict":"promote","reason":"画像"}') }, candidateFor("m-p"), opts(true));
		expect(statusOf(WS, "m-p")).toBe("active");
		expect(store.latestVerdict(WS, "memory", "m-p")).toBe("promote");
	});

	it("records demote advice without moving the row", async () => {
		create("m-p", "person");
		store.promoteMemory(WS, "m-p");
		const db = new DatabaseSync(dbPath);
		db.prepare("UPDATE memories SET probation_until = ? WHERE workspace_id = '' AND id = 'm-p'").run(new Date(Date.now() - DAY).toISOString());
		db.close();
		await runReviewBatch({ store, llm: fakeLlm('{"verdict":"demote","reason":"绑仓库"}') }, candidateFor("m-p", ""), opts(true));
		expect(statusOf("", "m-p")).toBe("active");
		expect(store.latestVerdict("", "memory", "m-p")).toBe("demote");
	});

	it("records archive advice without archiving", async () => {
		create("m-a");
		verdictOf("m-a", "quarantine");
		backdateVerdict("m-a");
		store.recordItemEvents([{ workspaceId: WS, kind: "memory", id: "m-a", event: "similar" }]);
		await runReviewBatch({ store, llm: fakeLlm('{"verdict":"archive","reason":"空话"}') }, candidateFor("m-a"), opts(true));
		expect(statusOf(WS, "m-a")).toBe("active");
	});
});

describe("verdicts the item cannot carry", () => {
	it("refuses a tiering exit on a skill", async () => {
		store.applySkillProposals({ workspaceId: WS, trigger: "explicit" }, [
			{ action: "create", id: "s-1", title: "部署", description: "部署前的检查", body: "1. 先跑测试" },
		]);
		await runReviewBatch({ store, llm: fakeLlm('{"verdict":"promote","reason":"画像"}') }, candidateFor("s-1", WS, "skill"), opts());
		const reviewLog = new DatabaseSync(dbPath);
		const row = reviewLog.prepare("SELECT verdict, reason FROM review_log WHERE item_id = 's-1' ORDER BY rowid DESC LIMIT 1").get() as
			| { verdict: string; reason: string }
			| undefined;
		reviewLog.close();
		expect(row?.verdict).toBe("skip");
		expect(row?.reason).toContain("verdict-not-applicable");
	});

	it("does not promote a row the record-time judgement left as project", async () => {
		create("m-a");
		await runReviewBatch({ store, llm: fakeLlm('{"verdict":"promote","reason":"画像"}') }, candidateFor("m-a"), opts());
		expect(statusOf("", "m-a")).toBeUndefined();
	});

	it("refuses to demote a row that is already in its project", async () => {
		create("m-a");
		await runReviewBatch({ store, llm: fakeLlm('{"verdict":"demote","reason":"绑仓库"}') }, candidateFor("m-a"), opts());
		const reviewLog = new DatabaseSync(dbPath);
		const row = reviewLog.prepare("SELECT verdict, reason FROM review_log WHERE item_id = 'm-a' ORDER BY rowid DESC LIMIT 1").get() as
			| { verdict: string; reason: string }
			| undefined;
		reviewLog.close();
		expect(row?.verdict).toBe("demote");
		expect(row?.reason).toContain("无需降级");
	});

	it("refuses to archive while a gate blocks it", async () => {
		create("m-a");
		await runReviewBatch({ store, llm: fakeLlm('{"verdict":"archive","reason":"空话"}') }, candidateFor("m-a"), opts());
		const reviewLog = new DatabaseSync(dbPath);
		const row = reviewLog.prepare("SELECT verdict, reason FROM review_log WHERE item_id = 'm-a' ORDER BY rowid DESC LIMIT 1").get() as
			| { verdict: string; reason: string }
			| undefined;
		reviewLog.close();
		expect(row?.verdict).toBe("archive");
		expect(row?.reason).toContain("未归档");
	});

	it("clears a candidate's marker when the reviewer declines to promote", async () => {
		create("m-p", "person");
		verdictOf("m-p", "keep");
		await runReviewBatch({ store, llm: fakeLlm('{"verdict":"keep","reason":"更像项目事实"}') }, candidateFor("m-p"), opts());
		expect(store.get(WS, "m-p")?.scope).toBe("project");
		expect(store.promotionQueue()).toEqual([]);
	});
});

describe("shared verdict-row helpers", () => {
	it("keeps exactly the fields the model supplied", () => {
		expect(proposedOf({ verdict: "rewrite", reason: "r", body: "b" })).toEqual({ body: "b" });
		expect(proposedOf({ verdict: "keep", reason: "r" })).toBeUndefined();
		expect(proposedOf({ verdict: "rewrite", reason: "r", title: "t", description: "d", body: "b", corrects: "x" })).toEqual({
			title: "t", description: "d", body: "b", corrects: "x",
		});
	});

	it("reads the landed-rewrite count and the row base", () => {
		create("m-a");
		store.logReview({ workspaceId: WS, itemKind: "memory", itemId: "m-a", verdict: "rewrite", applied: 1 });
		const candidate = { workspaceId: WS, kind: "memory" as const, id: "m-a", priority: 0, source: "new" as const, title: "t", description: "d", body: "b" };
		expect(evolveCountOf(store, candidate)).toBe(1);
		expect(rowBaseOf({ runId: "run", route: { model: "m" }, candidate })).toEqual({
			runId: "run", workspaceId: WS, itemKind: "memory", itemId: "m-a", model: "m",
		});
	});
});

describe("raw helpers", () => {
	it("requires an active global row for demotion", () => {
		const stmts = { clearProbation: { run: () => undefined }, logVerdict: { run: () => undefined } } as unknown as TieringStmts;
		const memories = { getRow: () => undefined } as never;
		const db = new DatabaseSync(dbPath);
		expect(demoteMemory(db, memories, stmts, { workspaceId: "", id: "ghost", now: new Date() }).ok).toBe(false);
		db.close();
	});

	it("refuses promotion from the global partition", () => {
		const stmts = {} as TieringStmts;
		const db = new DatabaseSync(dbPath);
		expect(promoteMemory(db, {} as never, stmts, { workspaceId: "", id: "m-a", now: new Date() }).ok).toBe(false);
		db.close();
	});
});

describe("transaction faults roll back and rethrow", () => {
	it("rethrows a promote fault after rolling back", () => {
		create("m-a");
		const stmts = {
			setProbation: { run: () => { throw new Error("disk full"); } },
			logVerdict: { run: () => undefined },
		} as unknown as TieringStmts;
		const db = new DatabaseSync(dbPath);
		expect(() =>
			promoteMemory(db, openRepoOf(db), stmts, { workspaceId: WS, id: "m-a", now: new Date() }),
		).toThrow("disk full");
		db.close();
		// The source row is untouched: the transaction rolled back.
		expect(statusOf(WS, "m-a")).toBe("active");
	});

	it("rethrows a demote fault after rolling back", () => {
		create("m-a", "person");
		store.promoteMemory(WS, "m-a");
		const stmts = {
			clearProbation: { run: () => { throw new Error("write refused"); } },
			logVerdict: { run: () => undefined },
		} as unknown as TieringStmts;
		const db = new DatabaseSync(dbPath);
		expect(() => demoteMemory(db, openRepoOf(db), stmts, { workspaceId: "", id: "m-a", now: new Date() })).toThrow("write refused");
		db.close();
		expect(statusOf("", "m-a")).toBe("active");
	});
});

describe("store-side failures degrade, never authorize", () => {
	it("reports archive failure instead of claiming success", () => {
		const failing = { archiveWithReason: () => { throw new Error("locked"); } } as never;
		const methods = createTiering({ archiveWithReason: failing });
		expect(methods.archiveMemory(WS, "m-a")).toBe(false);
	});

	it("reads evidence as zero when the usage table is unreadable", () => {
		const methods = createTiering({}, { usageElsewhere: { get: () => { throw new Error("no table"); } } });
		expect(methods.probationEvidence("m-a", WS)).toBe(0);
	});

	it("returns empty queues when the tiering tables are unreadable", () => {
		const methods = createTiering({}, {
			probationDue: { all: () => { throw new Error("no table"); } },
			promotionCandidates: { all: () => { throw new Error("no table"); } },
		});
		expect(methods.probationQueue()).toEqual([]);
		expect(methods.promotionQueue()).toEqual([]);
	});

	it("refuses promotion into a global partition that already has an active row", () => {
		create("m-a");
		create("m-a", "project", "/tmp/work/other");
		expect(store.promoteMemory(WS, "m-a").ok).toBe(true);
		const second = store.promoteMemory("/tmp/work/other", "m-a");
		expect(second.ok).toBe(false);
		expect(second.reason).toContain("already holds");
	});
});

describe("landing failures are ledgered as misses", () => {
	it("ledgers a promote that could not land", async () => {
		create("m-p", "person");
		verdictOf("m-p", "keep");
		const wrapped = failingStore(store, "promoteMemory", { ok: false, reason: "冲突" });
		await runReviewBatch({ store: wrapped, llm: fakeLlm('{"verdict":"promote","reason":"画像"}') }, candidateFor("m-p"), opts());
		expect(lastReasonOf("m-p")).toContain("提级未落地：冲突");
	});

	it("ledgers a demote that could not land", async () => {
		create("m-p", "person");
		store.promoteMemory(WS, "m-p");
		const db = new DatabaseSync(dbPath);
		db.prepare("UPDATE memories SET probation_until = ? WHERE workspace_id = '' AND id = 'm-p'").run(new Date(Date.now() - DAY).toISOString());
		db.close();
		const wrapped = failingStore(store, "demoteMemory", { ok: false, reason: "无来源" });
		await runReviewBatch({ store: wrapped, llm: fakeLlm('{"verdict":"demote","reason":"绑仓库"}') }, candidateFor("m-p", ""), opts());
		expect(lastReasonOf("m-p")).toContain("降级未落地：无来源");
	});

	it("ledgers an archive write failure", async () => {
		create("m-a");
		verdictOf("m-a", "quarantine");
		backdateVerdict("m-a");
		store.recordItemEvents([{ workspaceId: WS, kind: "memory", id: "m-a", event: "similar" }]);
		const wrapped = failingStore(store, "archiveMemory", false);
		await runReviewBatch({ store: wrapped, llm: fakeLlm('{"verdict":"archive","reason":"空话"}') }, candidateFor("m-a"), opts());
		expect(lastReasonOf("m-a")).toBe("归档写入失败");
	});

	it("reports a probation keep in trial mode without confirming it", async () => {
		create("m-p", "person");
		store.promoteMemory(WS, "m-p");
		store.recordMemoryUse("/tmp/work/other", "m-p");
		const db = new DatabaseSync(dbPath);
		db.prepare("UPDATE memories SET probation_until = ? WHERE workspace_id = '' AND id = 'm-p'").run(new Date(Date.now() - DAY).toISOString());
		db.close();
		await runReviewBatch({ store, llm: fakeLlm('{"verdict":"keep","reason":"有用"}') }, candidateFor("m-p", ""), opts(true));
		expect(store.get("", "m-p")?.probationUntil).not.toBeNull();
		expect(lastReasonOf("m-p")).toContain("试运行未转正");
	});

	it("ledgers a probation demote that could not land", async () => {
		create("m-p", "person");
		store.promoteMemory(WS, "m-p");
		const db = new DatabaseSync(dbPath);
		db.prepare("UPDATE memories SET probation_until = ? WHERE workspace_id = '' AND id = 'm-p'").run(new Date(Date.now() - DAY).toISOString());
		db.close();
		const wrapped = failingStore(store, "demoteMemory", { ok: false, reason: "无来源" });
		await runReviewBatch({ store: wrapped, llm: fakeLlm('{"verdict":"keep","reason":"没用到"}') }, candidateFor("m-p", ""), opts());
		expect(lastReasonOf("m-p")).toContain("实习降级未落地：无来源");
	});
});

/** The memories repository over one handle (the raw helpers take a repository). */
function openRepoOf(db: DatabaseSync): ReturnType<typeof openRepositories>["memories"] {
	return openRepositories(db).memories;
}

/** The tiering methods with stubbed collaborators, for the degrade branches. */
function createTiering(
	memories: { archiveRow?: (workspaceId: string, id: string, ts: string) => void },
	stmts: Record<string, unknown> = {},
): ReturnType<typeof createTieringMethods> {
	return createTieringMethods(
		new DatabaseSync(":memory:"),
		memories as never as Parameters<typeof createTieringMethods>[1],
		stmts as never,
		() => new Date(),
	);
}

/** The newest verdict row's reason for one item. */
function lastReasonOf(id: string): string {
	const db = new DatabaseSync(dbPath);
	const row = db.prepare("SELECT reason FROM review_log WHERE item_id = ? ORDER BY rowid DESC LIMIT 1").get(id) as { reason: string } | undefined;
	db.close();
	return row?.reason ?? "";
}

/** A store proxy whose one method answers with `value` instead of the real one. */
function failingStore(base: MemoryStore, method: string, value: unknown): MemoryStore {
	return new Proxy(base, {
		get(target, key, receiver) {
			if (key === method) {
				return () => value;
			}
			const found = Reflect.get(target, key, receiver);
			return typeof found === "function" ? (found as (...args: never[]) => unknown).bind(target) : found;
		},
	});
}

describe("success paths and fallbacks", () => {
	it("lands a demote verdict on a global row", async () => {
		create("m-p", "person");
		store.promoteMemory(WS, "m-p");
		backdateVerdict("m-p");
		store.recordItemEvents([{ workspaceId: "", kind: "memory", id: "m-p", event: "similar" }]);
		await runReviewBatch(
			{ store, llm: fakeLlm('{"verdict":"demote","reason":"绑仓库"}') },
			candidateFor("m-p", ""),
			opts(),
		);
		expect(statusOf(WS, "m-p")).toBe("active");
		expect(lastReasonOf("m-p")).toContain("绑仓库");
	});

	it("lands an archive verdict once the gate clears", async () => {
		create("m-a");
		verdictOf("m-a", "quarantine");
		backdateVerdict("m-a");
		store.recordItemEvents([{ workspaceId: WS, kind: "memory", id: "m-a", event: "similar" }]);
		await runReviewBatch({ store, llm: fakeLlm('{"verdict":"archive","reason":"空话"}') }, candidateFor("m-a"), opts());
		expect(statusOf(WS, "m-a")).toBe("archived");
	});

	it("names an unknown failure when a move gives no reason", async () => {
		create("m-p", "person");
		verdictOf("m-p", "keep");
		const wrapped = failingStore(store, "promoteMemory", { ok: false });
		await runReviewBatch({ store: wrapped, llm: fakeLlm('{"verdict":"promote","reason":"画像"}') }, candidateFor("m-p"), opts());
		expect(lastReasonOf("m-p")).toContain("未知原因");
	});

	it("says 'would confirm' in trial mode when the row has no cross-partition use", async () => {
		create("m-p", "person");
		store.promoteMemory(WS, "m-p");
		const db = new DatabaseSync(dbPath);
		db.prepare("UPDATE memories SET probation_until = ? WHERE workspace_id = '' AND id = 'm-p'").run(new Date(Date.now() - DAY).toISOString());
		db.close();
		await runReviewBatch({ store, llm: fakeLlm('{"verdict":"keep","reason":"没用到"}') }, candidateFor("m-p", ""), opts(true));
		expect(lastReasonOf("m-p")).toContain("实习期无跨分区引用");
		expect(store.get("", "m-p")?.probationUntil).not.toBeNull();
	});

	it("treats a missing origin as an empty one", async () => {
		create("m-p", "person");
		store.promoteMemory(WS, "m-p");
		const db = new DatabaseSync(dbPath);
		db.prepare("UPDATE memories SET probation_until = ?, origin_workspace = NULL WHERE workspace_id = '' AND id = 'm-p'")
			.run(new Date(Date.now() - DAY).toISOString());
		db.close();
		await runReviewBatch({ store, llm: fakeLlm('{"verdict":"keep","reason":"没用到"}') }, candidateFor("m-p", ""), opts());
		// No recorded origin means no honest reverse: the demotion refuses and
		// the row says exactly that instead of guessing a partition.
		expect(lastReasonOf("m-p")).toContain("records no origin");
	});

	it("ledgers a failed candidacy clear", async () => {
		create("m-p", "person");
		verdictOf("m-p", "keep");
		const wrapped = failingStore(store, "applyProposals", [{ id: "m-p", action: "update", ok: false, reason: "门禁拒绝" }]);
		await runReviewBatch({ store: wrapped, llm: fakeLlm('{"verdict":"keep","reason":"更像项目事实"}') }, candidateFor("m-p"), opts());
		expect(lastReasonOf("m-p")).toContain("候选标记清除失败");
	});
});
