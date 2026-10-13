import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectCandidates, failureHead, rewriteMagnitude, runReviewBatch, type ReviewCandidate, type ReviewLlm } from "../src/review.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

let dbPath = "";
let store: MemoryStore;
const WS = "/tmp/work/review-run-tests";
let savedDshHome: string | undefined;

beforeEach(async () => {
	dbPath = join(mkdtempSync(join(tmpdir(), "evolve-review-run-")), "memory.db");
	store = await openMemoryStore(dbPath);
	const home = mkdtempSync(join(tmpdir(), "evolve-review-home-"));
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

function createMemory(title = "user env", body = "Fedora 44"): string {
	const [outcome] = store.applyProposals(
		{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
		[{ action: "create", type: "user", title, description: "用户的操作系统", body }],
	);
	expect(outcome?.ok).toBe(true);
	return outcome?.id ?? "";
}

/** Scripted host LLM: answers route by the system prompt (cheap vs evolve). */
function fakeLlm(
	scenes: { gate: string; evolve: string },
	usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
): ReviewLlm & { calls: number; prompts: { system: string; prompt: string }[] } {
	const llm = {
		calls: 0,
		prompts: [] as { system: string; prompt: string }[],
		async *stream(options: Record<string, unknown>): AsyncIterable<unknown> {
			llm.calls += 1;
			const system = options.system as string;
			const messages = options.messages as { content?: { text?: string }[] }[] | undefined;
			llm.prompts.push({ system, prompt: messages?.[0]?.content?.[0]?.text ?? "" });
			const text = system.includes("评审门") ? scenes.gate : scenes.evolve;
			yield { type: "text-delta", text };
			yield { type: "usage", usage };
			yield { type: "finish", reason: { kind: "stop" } };
		},
	};
	return llm;
}

/** Gate approves, evolve throws: the evolve leg degrades to a skip row. */
function gateThenThrowLlm(gate: string): ReviewLlm {
	return {
		async *stream(options: Record<string, unknown>): AsyncIterable<unknown> {
			const system = options.system as string;
			if (system.includes("评审门")) {
				yield { type: "text-delta", text: gate };
				yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
				yield { type: "finish", reason: { kind: "stop" } };
				return;
			}
			throw new Error("evolve route down");
			yield { type: "text-delta", text: "unreachable" };
		},
	};
}

/** Every call throws: the gate leg degrades to a skip row carrying the text. */
function throwingLlm(): ReviewLlm {
	return {
		async *stream(): AsyncIterable<unknown> {
			throw new Error("route down");
			yield { type: "text-delta", text: "unreachable" };
		},
	};
}

const OPTS = { day: "2026-10-12", budget: 100, dryRun: false, provider: "p", model: "m", sessionId: "sess-1" };

function candidateOf(id: string, body = "Fedora 44"): ReviewCandidate {
	return { workspaceId: WS, kind: "memory", id, priority: 0, title: "user env", description: "钩子", body };
}

describe("rewriteMagnitude", () => {
	it("measures relative body change against the 0.3 cap", () => {
		expect(rewriteMagnitude("1234567890", "1234567890")).toBe(0);
		expect(rewriteMagnitude("1234567890", "12345678")).toBeCloseTo(0.2);
		expect(rewriteMagnitude("1234567890", "1234567890ABCD")).toBeCloseTo(0.4);
		expect(rewriteMagnitude("", "abc")).toBe(3);
	});
});

describe("failureHead", () => {
	it("renders one capped line for Error and foreign throws", () => {
		expect(failureHead(new Error("route down"))).toBe("route down");
		expect(failureHead("plain string")).toBe("plain string");
		expect(failureHead(new Error("first\nsecond"))).toBe("first");
		expect(failureHead(new Error("x".repeat(200)))).toBe(`${"x".repeat(120)}…`);
	});
});

describe("collectCandidates", () => {
	it("lists new items first and skips reviewed ones", () => {
		const id = createMemory();
		let found = collectCandidates(store, { limit: 10 });
		expect(found.map((c) => c.id)).toContain(id);
		expect(found[0]?.priority).toBe(0);
		store.logReview({ workspaceId: WS, itemKind: "memory", itemId: id, verdict: "keep", reason: "ok", applied: 0 });
		found = collectCandidates(store, { limit: 10 });
		expect(found.map((c) => c.id)).not.toContain(id);
	});

	it("requeues stale items after the age bound", () => {
		const id = createMemory();
		store.logReview({ workspaceId: WS, itemKind: "memory", itemId: id, verdict: "keep", reason: "ok", applied: 0 });
		expect(collectCandidates(store, { limit: 10 }).map((c) => c.id)).not.toContain(id);
		const stale = collectCandidates(store, { limit: 10, now: Date.now() + 31 * 24 * 60 * 60 * 1000 });
		expect(stale.find((c) => c.id === id)?.priority).toBe(2);
	});

	it("requeues corrects targets with priority 1", () => {
		const oldId = createMemory("旧系统");
		createMemory("新系统");
		const [outcome] = store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{ action: "create", type: "user", title: "纠正", description: "纠正旧条", body: "新事实", corrects: oldId }],
		);
		expect(outcome?.ok).toBe(true);
		store.logReview({ workspaceId: WS, itemKind: "memory", itemId: oldId, verdict: "keep", reason: "ok", applied: 0 });
		const found = collectCandidates(store, { limit: 10 });
		expect(found.find((c) => c.id === oldId)?.priority).toBe(1);
	});

	it("skips quarantined rows and shadowed globals on later collections", async () => {
		const id = createMemory("user env", "Fedora 44");
		const llm = fakeLlm({
			gate: `{"worthReview": true, "reason": "看看"}`,
			evolve: `{"verdict": "quarantine", "reason": "涉密"}`,
		});
		await runReviewBatch({ store, llm }, [candidateOf(id, "Fedora 44")], OPTS);
		const found = collectCandidates(store);
		expect(found.map((c) => c.id)).not.toContain(id);
	});

	it("runs requeued items through the batch and counts them apart", async () => {
		const oldId = createMemory("旧系统", "旧事实");
		store.logReview({ workspaceId: WS, itemKind: "memory", itemId: oldId, verdict: "keep", reason: "ok", applied: 0 });
		const [outcome] = store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{ action: "create", type: "user", title: "纠正", description: "纠正旧条", body: "新事实", corrects: oldId }],
		);
		expect(outcome?.ok).toBe(true);
		const llm = fakeLlm({ gate: `{"worthReview": false, "reason": "略"}`, evolve: `{"verdict": "keep", "reason": "x"}` });
		const candidates = collectCandidates(store, { limit: 10 }).filter((c) => c.id === oldId);
		expect(candidates[0]?.priority).toBe(1);
		const summary = await runReviewBatch({ store, llm }, candidates, OPTS);
		expect(summary).toMatchObject({ reviewed: 1 });
		expect(store.getDaily(OPTS.day)).toMatchObject({ requeued: 1, newItems: 0 });
	});
});

describe("runReviewBatch", () => {
	it("skips everything without a model route and counts no-route", async () => {
		const id = createMemory();
		const summary = await runReviewBatch({ store, llm: undefined }, [candidateOf(id)], OPTS);
		expect(summary).toMatchObject({ reviewed: 1, approved: 0, applied: 0 });
		expect(store.getDaily(OPTS.day)).toMatchObject({ reviewed: 1 });
	});

	it("cheap-gate rejection ledgers a skip and never calls evolve", async () => {
		const id = createMemory();
		const llm = fakeLlm({ gate: `{"worthReview": false, "reason": "空话"}`, evolve: `{"verdict": "keep", "reason": "x"}` });
		const summary = await runReviewBatch({ store, llm }, [candidateOf(id)], OPTS);
		expect(llm.calls).toBe(1);
		expect(summary).toMatchObject({ reviewed: 1, approved: 0, applied: 0 });
		expect(store.getDaily(OPTS.day)?.skipTop).toContain("cheap-gate");
	});

	it("keep verdicts land verdict-only rows", async () => {
		const id = createMemory();
		const llm = fakeLlm({ gate: `{"worthReview": true, "reason": "看看"}`, evolve: `{"verdict": "keep", "reason": "写得好"}` });
		const summary = await runReviewBatch({ store, llm }, [candidateOf(id)], OPTS);
		expect(summary).toMatchObject({ reviewed: 1, approved: 1, applied: 0 });
		expect(store.reviewStateOf(WS, "memory", id)).toMatchObject({ evolveCount: 0 });
		expect(store.getDaily(OPTS.day)).toMatchObject({ approved: 1, cheapToken: 15, evolveToken: 15 });
	});

	it("applies rewrites through the gates and counts evolve history", async () => {
		const id = createMemory("user env", "Fedora 44");
		const llm = fakeLlm({
			gate: `{"worthReview": true, "reason": "看看"}`,
			evolve: `{"verdict": "rewrite", "reason": "补版本", "body": "Fedora 44.1"}`,
		});
		const summary = await runReviewBatch({ store, llm }, [candidateOf(id, "Fedora 44")], OPTS);
		expect(summary).toMatchObject({ approved: 1, applied: 1 });
		expect(store.get(WS, id)?.body).toBe("Fedora 44.1");
		expect(store.reviewStateOf(WS, "memory", id)).toMatchObject({ evolveCount: 1 });
	});

	it("dry-run ledgers rewrites without landing them", async () => {
		const id = createMemory("user env", "Fedora 44");
		const llm = fakeLlm({
			gate: `{"worthReview": true, "reason": "看看"}`,
			evolve: `{"verdict": "rewrite", "reason": "补版本", "body": "Fedora 44.1"}`,
		});
		const summary = await runReviewBatch({ store, llm }, [candidateOf(id, "Fedora 44")], { ...OPTS, dryRun: true });
		expect(summary).toMatchObject({ approved: 1, applied: 0 });
		expect(store.get(WS, id)?.body).toBe("Fedora 44");
		// Trial mode keeps what it declined to land: the rewrite is the part a
		// human has to judge before turning dry-run off.
		const db = new DatabaseSync(dbPath);
		try {
			const row = db.prepare("SELECT proposed FROM review_log ORDER BY rowid DESC LIMIT 1").get() as { proposed: string | null };
			expect(JSON.parse(row.proposed ?? "null")).toMatchObject({ body: "Fedora 44.1" });
		} finally {
			db.close();
		}
	});

	it("oversized rewrites degrade to quarantine instead of landing", async () => {
		const id = createMemory("user env", "short");
		const llm = fakeLlm({
			gate: `{"worthReview": true, "reason": "看看"}`,
			evolve: `{"verdict": "rewrite", "reason": "大改", "body": "short plus a whole new manual chapter that goes on and on"}`,
		});
		const summary = await runReviewBatch({ store, llm }, [candidateOf(id, "short")], OPTS);
		expect(summary).toMatchObject({ applied: 1 });
		const raw = store.listAll(WS).find((r) => r.id === id);
		expect(raw?.status).toBe("quarantined");
	});

	it("quarantine verdicts soft-isolate without deleting", async () => {
		const id = createMemory();
		const llm = fakeLlm({
			gate: `{"worthReview": true, "reason": "看看"}`,
			evolve: `{"verdict": "quarantine", "reason": "含密钥"}`,
		});
		await runReviewBatch({ store, llm }, [candidateOf(id)], OPTS);
		expect(store.listAll(WS).find((r) => r.id === id)?.status).toBe("quarantined");
	});

	it("gate refusals never starve the run and failures degrade to skips", async () => {
		const id = createMemory();
		const llm = fakeLlm({ gate: "not json at all", evolve: `{"verdict": "keep", "reason": "x"}` });
		const summary = await runReviewBatch({ store, llm }, [candidateOf(id)], OPTS);
		expect(summary).toMatchObject({ reviewed: 1, approved: 0 });
		expect(store.getDaily(OPTS.day)?.skipTop).toContain("gate-parse-failed");
	});

	it("keeps the feedback rubric out of the evolve prompt text", async () => {
		const [outcome] = store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{
				action: "create", type: "feedback", title: "部署经验", description: "部署前检查",
				body: "先构建。\n\n**Why:** 避免带病上线。\n\n**How to apply:** 发版前跑构建。",
			}],
		);
		expect(outcome?.ok).toBe(true);
		const llm = fakeLlm({ gate: `{"worthReview": true, "reason": "看看"}`, evolve: `{"verdict": "keep", "reason": "规范完整"}` });
		const candidates = collectCandidates(store, { limit: 10 });
		expect(candidates[0]?.memoryType).toBe("feedback");
		const summary = await runReviewBatch({ store, llm }, candidates, OPTS);
		expect(summary).toMatchObject({ approved: 1 });
		// The reminder used to ride the user prompt right below the body, and
		// the model copied it into the rewrite verbatim (2026-10-14).
		const evolveCall = llm.prompts.find((call) => !call.system.includes("评审门"));
		expect(evolveCall?.prompt).toContain(`id=${candidates[0]?.id ?? ""}`);
		expect(evolveCall?.prompt).not.toContain("feedback 类正文必须带 Why 与 How to apply");
	});

	it("still refuses a feedback rewrite that drops the Why line at landing", async () => {
		const body = "先构建。\n\n**Why:** 避免带病上线。\n\n**How to apply:** 发版前跑构建。";
		const [outcome] = store.applyProposals(
			{ workspaceId: WS, trigger: "explicit", sessionId: "sess-1" },
			[{ action: "create", type: "feedback", title: "部署经验", description: "部署前检查", body }],
		);
		const id = outcome?.id ?? "";
		const llm = fakeLlm({
			gate: `{"worthReview": true, "reason": "看看"}`,
			evolve: `{"verdict": "rewrite", "reason": "精简", "body": ${JSON.stringify(body.replace("**Why:** ", ""))}}`,
		});
		const candidate: ReviewCandidate = { workspaceId: WS, kind: "memory", id, priority: 0, title: "部署经验", description: "部署前检查", body, memoryType: "feedback" };
		const summary = await runReviewBatch({ store, llm }, [candidate], OPTS);
		expect(summary).toMatchObject({ approved: 1, applied: 0 });
		expect(store.get(WS, id)?.body).toBe(body);
		const db = new DatabaseSync(dbPath);
		try {
			const row = db.prepare("SELECT reason FROM review_log ORDER BY rowid DESC LIMIT 1").get() as { reason: string };
			expect(row.reason).toContain("门禁拒绝");
		} finally {
			db.close();
		}
	});

	it("unparseable evolve answers ledger a skip without landing", async () => {
		const id = createMemory();
		const llm = fakeLlm({ gate: `{"worthReview": true, "reason": "看看"}`, evolve: "胡言乱语" });
		const summary = await runReviewBatch({ store, llm }, [candidateOf(id)], OPTS);
		expect(summary).toMatchObject({ approved: 1, applied: 0 });
		expect(store.getDaily(OPTS.day)?.skipTop).toContain("evolve-parse-failed");
	});

	it("evolve call failures degrade to skips and keep the batch alive", async () => {
		const id = createMemory();
		const summary = await runReviewBatch({ store, llm: gateThenThrowLlm(`{"worthReview": true, "reason": "看看"}`) }, [candidateOf(id)], OPTS);
		expect(summary).toMatchObject({ approved: 1, applied: 0 });
		expect(store.getDaily(OPTS.day)?.skipTop).toContain("evolve-llm-failed");
	});

	it("ledger rows carry the failure text instead of a bare code", async () => {
		const id = createMemory();
		const summary = await runReviewBatch({ store, llm: throwingLlm() }, [candidateOf(id)], OPTS);
		expect(summary).toMatchObject({ approved: 0 });
		const db = new DatabaseSync(dbPath);
		try {
			const row = db.prepare("SELECT reason FROM review_log ORDER BY rowid DESC LIMIT 1").get() as { reason: string };
			expect(row.reason).toContain("gate-llm-failed: route down");
		} finally {
			db.close();
		}
	});

	it("quarantine verdicts stay ledger-only in dry-run", async () => {
		const id = createMemory();
		const llm = fakeLlm({
			gate: `{"worthReview": true, "reason": "看看"}`,
			evolve: `{"verdict": "quarantine", "reason": "涉密"}`,
		});
		const summary = await runReviewBatch({ store, llm }, [candidateOf(id)], { ...OPTS, dryRun: true });
		expect(summary).toMatchObject({ applied: 0 });
		expect(store.listAll(WS).find((r) => r.id === id)?.status).toBe("active");
		const db = new DatabaseSync(dbPath);
		try {
			// A quarantine verdict proposed no text, so the column stays empty.
			const row = db.prepare("SELECT proposed FROM review_log ORDER BY rowid DESC LIMIT 1").get() as { proposed: string | null };
			expect(row.proposed).toBeNull();
		} finally {
			db.close();
		}
	});

	it("gate-rejected rewrites ledger the refusal without landing", async () => {
		const id = createMemory("user env", "Fedora 44");
		const llm = fakeLlm({
			gate: `{"worthReview": true, "reason": "看看"}`,
			evolve: `{"verdict": "rewrite", "reason": "自指", "body": "Fedora 44.", "corrects": "${id}"}`,
		});
		const summary = await runReviewBatch({ store, llm }, [candidateOf(id, "Fedora 44")], OPTS);
		expect(summary).toMatchObject({ approved: 1, applied: 0 });
		expect(store.get(WS, id)?.body).toBe("Fedora 44");
	});

	it("unrecognized usage payloads account as zero instead of failing", async () => {
		const id = createMemory();
		const llm = fakeLlm(
			{ gate: `{"worthReview": false, "reason": "略"}`, evolve: `{"verdict": "keep", "reason": "x"}` },
			{ exotic: true } as never,
		);
		const summary = await runReviewBatch({ store, llm }, [candidateOf(id)], OPTS);
		expect(summary).toMatchObject({ reviewed: 1, cheapToken: 0 });
	});

	it("hard cap drops the tail and counts backlog", async () => {
		const ids = [createMemory("第一条"), createMemory("第二条"), createMemory("第三条")];
		const llm = fakeLlm({ gate: `{"worthReview": false, "reason": "略"}`, evolve: `{"verdict": "keep", "reason": "x"}` });
		const candidates = ids.map((id) => candidateOf(id));
		const summary = await runReviewBatch({ store, llm }, candidates, { ...OPTS, budget: 1 });
		expect(summary).toMatchObject({ reviewed: 1, dropped: 2, backlog: 0 });
		expect(store.getDaily(OPTS.day)).toMatchObject({ reviewed: 1, dropped: 2 });
	});
});
