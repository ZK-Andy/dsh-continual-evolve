import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectCandidates } from "../src/services/review-candidates.js";
import { memorySnapshot } from "../src/surfaces/memory-snapshot.js";
import { runReviewBatch, type ReviewLlm } from "../src/services/review.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

/**
 * The tiering exits end to end (`2026-10-13-memory-tiering-and-promotion`):
 * promotion keeps one active copy and starts probation, demotion returns the
 * row home, the archive gate needs a second judgement, and the queue's clock
 * tier fires without waiting out `staleDays`.
 */
const WS = "/tmp/work/tiering-review";
const OTHER = "/tmp/work/other-project";
const DAY = 24 * 60 * 60 * 1000;

let dbPath = "";
let store: MemoryStore;

beforeEach(async () => {
	dbPath = join(mkdtempSync(join(tmpdir(), "evolve-tiering-review-")), "memory.db");
	store = await openMemoryStore(dbPath);
});

afterEach(() => {
	store.close();
});

function createMemory(id: string, scope: "project" | "person" = "project"): void {
	const [outcome] = store.applyProposals({ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" }, [
		{ action: "create", id, type: "user", title: `标题 ${id}`, description: "钩子", body: "Fedora 44", scope },
	]);
	expect(outcome?.ok).toBe(true);
}

function verdictOf(id: string, verdict: "keep" | "quarantine" | "promote" | "demote" | "archive", workspaceId = WS): void {
	store.logReview({ workspaceId, itemKind: "memory", itemId: id, verdict });
}

/** The stored status of one row in one partition (the merged read hides it). */
function statusOf(workspaceId: string, id: string): string | undefined {
	const db = new DatabaseSync(dbPath);
	const row = db.prepare("SELECT status FROM memories WHERE workspace_id = ? AND id = ?").get(workspaceId, id) as { status: string } | undefined;
	db.close();
	return row?.status;
}

/** Set a row's probation window directly (the clock is the test's to move). */
function setProbation(workspaceId: string, id: string, iso: string | null): void {
	const db = new DatabaseSync(dbPath);
	db.prepare("UPDATE memories SET probation_until = ? WHERE workspace_id = ? AND id = ?").run(iso, workspaceId, id);
	db.close();
}

/** A scripted host LLM: one answer for the gate, one for the evolve pass. */
function fakeLlm(gate: string, evolve: string): ReviewLlm {
	return {
		async *stream(options: Record<string, unknown>): AsyncIterable<unknown> {
			const system = options.system as string;
			yield { type: "text-delta", text: system.includes("评审门") ? gate : evolve };
			yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
			yield { type: "finish", reason: { kind: "stop" } };
		},
	};
}

const OPTS = { day: "2026-10-17", budget: 100, dryRun: false, provider: "p", model: "m", sessionId: "sess-1" };

describe("promotion and demotion", () => {
	it("moves a person candidate into the global partition on probation", () => {
		createMemory("m-person", "person");
		const outcome = store.promoteMemory(WS, "m-person");
		expect(outcome.ok).toBe(true);

		const global = store.get("", "m-person");
		expect(global?.status).toBe("active");
		expect(global?.scope).toBe("person");
		expect(global?.originWorkspace).toBe(WS);
		expect(global?.probationUntil).not.toBeNull();
		// One active copy, and the source is history — not deleted. `get` merges
		// (it returns the promoted copy), so look at the partition's own rows.
		expect(statusOf(WS, "m-person")).toBe("archived");
		expect(store.list(WS).map((record) => record.id)).toContain("m-person");
	});

	it("makes a promoted row visible from another workspace", () => {
		createMemory("m-person", "person");
		store.promoteMemory(WS, "m-person");
		expect(store.get(OTHER, "m-person")?.id).toBe("m-person");
		expect(store.list(OTHER).map((record) => record.id)).toEqual(["m-person"]);
	});

	it("refuses to promote a row that is already global or missing", () => {
		createMemory("m-a");
		expect(store.promoteMemory(WS, "nope").ok).toBe(false);
		store.promoteMemory(WS, "m-a");
		expect(store.promoteMemory("", "m-a").ok).toBe(false);
	});

	it("demotes a global row back to the partition it came from", () => {
		createMemory("m-person", "person");
		store.promoteMemory(WS, "m-person");
		const outcome = store.demoteMemory("", "m-person");
		expect(outcome.ok).toBe(true);
		expect(store.get(WS, "m-person")?.status).toBe("active");
		expect(store.get(WS, "m-person")?.scope).toBe("project");
	});

	it("refuses to demote a global row with no recorded origin", () => {
		store.applyProposals({ workspaceId: "", trigger: "explicit" }, [
			{ action: "create", id: "g-1", type: "user", title: "global", description: "d", body: "b" },
		]);
		const outcome = store.demoteMemory("", "g-1");
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toContain("origin");
	});
});

describe("archive gate", () => {
	it("blocks the first judgement and unblocks the second with no references", () => {
		createMemory("m-a");
		expect(store.archiveBlocker(WS, "m-a")).toContain("第一次判淘汰");
		verdictOf("m-a", "quarantine");
		expect(store.archiveBlocker(WS, "m-a")).toBeUndefined();
		expect(store.archiveMemory(WS, "m-a")).toBe(true);
		expect(store.get(WS, "m-a")?.status).toBe("archived");
	});

	it("blocks while another row corrects it", () => {
		createMemory("m-a");
		verdictOf("m-a", "quarantine");
		store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [
			{ action: "create", id: "m-b", type: "user", title: "纠正", description: "d", body: "b", corrects: "m-a" },
		]);
		expect(store.archiveBlocker(WS, "m-a")).toContain("corrects");
	});

	it("blocks while the row was ever served by id", () => {
		createMemory("m-a");
		verdictOf("m-a", "quarantine");
		store.recordMemoryUse(WS, "m-a");
		expect(store.archiveBlocker(WS, "m-a")).toContain("引用");
	});
});

describe("clock tiers", () => {
	it("queues a person candidate waiting for its second judgement", () => {
		createMemory("m-person", "person");
		verdictOf("m-person", "keep");
		const found = collectCandidates(store, { now: Date.now(), staleDays: 30, batchSize: 10, limit: 10 });
		expect(found.find((row) => row.id === "m-person")?.source).toBe("clock");
	});

	it("queues a promoted row once probation comes due, ignoring staleDays", () => {
		createMemory("m-person", "person");
		store.promoteMemory(WS, "m-person");
		setProbation("", "m-person", new Date(Date.now() - DAY).toISOString());
		const found = collectCandidates(store, { now: Date.now(), staleDays: 30, batchSize: 10, limit: 10 });
		expect(found.find((row) => row.id === "m-person")?.source).toBe("clock");
	});
});

describe("verdicts that move rows", () => {
	it("promotes on the model's promote verdict", async () => {
		createMemory("m-person", "person");
		verdictOf("m-person", "quarantine");
		await runReviewBatch(
			{ store, llm: fakeLlm('{"worthReview":true,"reason":"ok"}', '{"verdict":"promote","reason":"跟人走"}') },
			collectCandidates(store, { limit: 10 }).filter((row) => row.id === "m-person"),
			OPTS,
		);
		expect(store.get("", "m-person")?.status).toBe("active");
		expect(statusOf(WS, "m-person")).toBe("archived");
	});

	it("demotes a probation row that earned no cross-partition use", async () => {
		createMemory("m-person", "person");
		store.promoteMemory(WS, "m-person");
		setProbation("", "m-person", new Date(Date.now() - DAY).toISOString());
		const candidates = collectCandidates(store, { limit: 10 }).filter((row) => row.workspaceId === "");
		await runReviewBatch(
			{ store, llm: fakeLlm('{"worthReview":true,"reason":"ok"}', '{"verdict":"keep","reason":"看着没问题"}') },
			candidates,
			OPTS,
		);
		expect(statusOf(WS, "m-person")).toBe("active");
		expect(store.get("", "m-person")?.status).toBe("archived");
	});

	it("confirms a probation row another workspace actually used", async () => {
		createMemory("m-person", "person");
		store.promoteMemory(WS, "m-person");
		store.recordMemoryUse(OTHER, "m-person");
		setProbation("", "m-person", new Date(Date.now() - DAY).toISOString());
		const candidates = collectCandidates(store, { limit: 10 }).filter((row) => row.workspaceId === "");
		await runReviewBatch(
			{ store, llm: fakeLlm('{"worthReview":true,"reason":"ok"}', '{"verdict":"keep","reason":"有用"}') },
			candidates,
			OPTS,
		);
		expect(store.get("", "m-person")?.probationUntil).toBeNull();
		expect(store.get("", "m-person")?.status).toBe("active");
	});
});

describe("export suggestion", () => {
	it("records the advice without touching the row", async () => {
		createMemory("m-doc");
		await runReviewBatch(
			{ store, llm: fakeLlm('{"worthReview":true,"reason":"ok"}', '{"verdict":"export-suggestion","reason":"该进仓库文档"}') },
			collectCandidates(store, { limit: 10 }).filter((row) => row.id === "m-doc"),
			OPTS,
		);
		expect(store.latestVerdict(WS, "memory", "m-doc")).toBe("export-suggestion");
		expect(store.get(WS, "m-doc")?.status).toBe("active");
	});

	it("surfaces on the card as a suggestion, not a status change", async () => {
		createMemory("m-doc");
		store.logReview({ workspaceId: WS, itemKind: "memory", itemId: "m-doc", verdict: "export-suggestion", reason: "该进仓库文档" });
		const snapshot = memorySnapshot(store, WS);
		expect(snapshot.files.find((file) => file.id === "m-doc")?.suggestExport).toBe(true);
		expect(snapshot.files.every((file) => file.id === "m-doc" || file.suggestExport === false)).toBe(true);
	});
});
