import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runExtraction, type ExtractionDeps, type LlmStream } from "../src/extraction.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

let store: MemoryStore;
const WS = "/tmp/work/extraction-tests";

const USER_EVENT = { seq: 10, type: "user/message", data: { content: "请记住：我在 Fedora 上工作" } };
const ASSISTANT_EVENT = { seq: 11, type: "assistant/message", data: { content: "好的，已了解。" } };

function fakeLlm(text: string): LlmStream & { calls: Record<string, unknown>[] } {
	return {
		calls: [],
		async *stream(options: Record<string, unknown>) {
			this.calls.push(options);
			yield { type: "text-delta", text };
			yield { type: "usage", usage: { total_tokens: 42 } };
			yield { type: "finish", reason: { kind: "stop" } };
		},
	};
}

function surfaceOf(...events: unknown[]): { readSurface(id: string): Promise<{ events: unknown[] }> } {
	return { async readSurface(_id) { return { events }; } };
}

function deps(overrides: Partial<ExtractionDeps> & { llmAnswer?: string } = {}): ExtractionDeps & { llm: LlmStream & { calls: Record<string, unknown>[] } } {
	const llm = fakeLlm(
		overrides.llmAnswer ??
			JSON.stringify({
				decision: "apply",
				reason: "用户环境事实",
				proposals: [{ action: "create", type: "user", title: "Fedora 环境", description: "用户的操作系统", body: "Fedora 44", sourceSeqs: "10-10" }],
			}),
	);
	return {
		store,
		surface: overrides.surface ?? surfaceOf(USER_EVENT, ASSISTANT_EVENT),
		llm,
	};
}

const target = {
	workspaceId: WS,
	sessionId: "sess-1",
	internalAgent: false,
	provider: "deepseek",
	model: "deepseek-chat",
};

function rawDb(): DatabaseSync {
	return new DatabaseSync(store.path);
}

beforeEach(async () => {
	store = await openMemoryStore(join(mkdtempSync(join(tmpdir(), "evolve-extract-")), "memory.db"));
});

afterEach(() => {
	store.close();
});

describe("runExtraction — mechanical skips (each ledgered, cursor untouched)", () => {
	it("skips internal agents", async () => {
		const result = await runExtraction(deps(), { ...target, internalAgent: true }, { trigger: "turn-debounce" });
		expect(result).toEqual({ status: "skipped", skipReason: "internal-agent" });
	});

	it("skips without a workspace", async () => {
		const result = await runExtraction(deps(), { ...target, workspaceId: undefined }, { trigger: "turn-debounce" });
		expect(result.skipReason).toBe("no-workspace");
	});

	it("skips without a surface reader", async () => {
		const result = await runExtraction({ store, surface: undefined, llm: fakeLlm("{}") }, target, { trigger: "turn-debounce" });
		expect(result.skipReason).toBe("no-surface");
	});

	it("skips without a provider/model route", async () => {
		const result = await runExtraction(deps(), { ...target, provider: undefined }, { trigger: "turn-debounce" });
		expect(result.skipReason).toBe("no-route");
	});

	it("skips when the increment adds nothing new", async () => {
		store.setCursor(WS, "sess-1", 11);
		const result = await runExtraction(deps(), target, { trigger: "turn-debounce" });
		expect(result.skipReason).toBe("no-new-events");
	});

	it("skips when there is no real user prose", async () => {
		const result = await runExtraction(
			deps({ surface: surfaceOf({ seq: 10, type: "user/message", data: { content: "好的" } }) }),
			target,
			{ trigger: "turn-debounce" },
		);
		expect(result.skipReason).toBe("no-user-prose");
	});

	it("skips when the turn already carried an explicit memory_write", async () => {
		const result = await runExtraction(
			deps({ surface: surfaceOf(USER_EVENT, { seq: 11, type: "tool/call", data: { name: "memory_write" } }) }),
			target,
			{ trigger: "turn-debounce" },
		);
		expect(result.skipReason).toBe("direct-memory-write");
	});

	it("every skip above left a ledger row and no cursor", async () => {
		await runExtraction(deps(), { ...target, internalAgent: true }, { trigger: "turn-debounce" });
		const raw = rawDb();
		const row = raw.prepare("SELECT skip_reason, status FROM extraction_log").get() as { skip_reason: string; status: string };
		raw.close();
		expect(row.skip_reason).toBe("internal-agent");
		expect(row.status).toBe("skipped");
		expect(store.cursor(WS, "sess-1")).toBeUndefined();
	});
});

describe("runExtraction — model round-trip", () => {
	it("applies proposals, lands provenance, advances the cursor, and runs patrol", async () => {
		const d = deps();
		const result = await runExtraction(d, target, { trigger: "turn-debounce" });
		expect(result.status).toBe("applied");
		expect(result.applied).toBe(1);
		expect(result.cursor).toBe(11);
		expect(store.cursor(WS, "sess-1")).toBe(11);
		const record = store.get(WS, "fedora-环境") ?? store.list(WS)[0];
		expect(record?.sourceSeqs).toBe("10-10");
		expect(record?.sourceRun).toContain("extract:sess-1");
		expect(record?.sourceSession).toBe("sess-1");
		// The host session identity reached the LLM boundary (MissingSessionID pitfall).
		expect(d.llm.calls[0]?.sessionId).toBe("sess-1");
		expect(d.llm.calls[0]?.provider).toBe("deepseek");
		// Patrol rode along on the applied run.
		expect(store.state("", "patrol:last")).toBeDefined();
		// The applied ledger row carries before/after files.
		const raw = rawDb();
		const row = raw.prepare("SELECT status, files, usage FROM extraction_log WHERE files IS NOT NULL").get() as {
			status: string;
			files: string;
			usage: string;
		};
		raw.close();
		expect(row.status).toBe("applied");
		const files = JSON.parse(row.files) as { after?: { id: string } }[];
		expect(files[0]?.after?.id).toBeDefined();
		expect(JSON.parse(row.usage)).toEqual({ total_tokens: 42 });
	});

	it("feeds existing memories as manifest and candidates", async () => {
		store.applyProposals({ workspaceId: WS, trigger: "explicit" }, [
			{ action: "create", id: "env", type: "user", title: "环境", description: "Fedora 44 环境", body: "旧正文" },
		]);
		const d = deps({
			llmAnswer: JSON.stringify({
				decision: "apply",
				reason: "补充",
				proposals: [{ action: "update", id: "env", body: "Fedora 44 + Zed" }],
			}),
		});
		const result = await runExtraction(d, target, { trigger: "turn-debounce" });
		expect(result.status).toBe("applied");
		expect(store.get(WS, "env")?.body).toBe("Fedora 44 + Zed");
		const prompt = String(d.llm.calls[0]?.messages && (d.llm.calls[0].messages as { content: { text: string }[] }[])[0].content[0].text);
		expect(prompt).toContain("id=env｜type=user");
		expect(prompt).toContain("旧正文");
	});

	it("a model skip consumes the increment and advances the cursor", async () => {
		const d = deps({ llmAnswer: JSON.stringify({ decision: "skip", reason: "没有值得沉淀的" }) });
		const result = await runExtraction(d, target, { trigger: "turn-debounce" });
		expect(result.status).toBe("skipped");
		expect(store.cursor(WS, "sess-1")).toBe(11);
		const raw = rawDb();
		const row = raw.prepare("SELECT skip_reason FROM extraction_log WHERE skip_reason LIKE 'model-skip%'").get() as { skip_reason: string };
		raw.close();
		expect(row.skip_reason).toBe("model-skip: 没有值得沉淀的");
	});

	it("a gate rejection leaves the cursor untouched for a retry", async () => {
		const d = deps({
			llmAnswer: JSON.stringify({
				decision: "apply",
				proposals: [{ action: "create", type: "feedback", title: "缺两行", description: "d", body: "没有 Why/How" }],
			}),
		});
		const result = await runExtraction(d, target, { trigger: "turn-debounce" });
		expect(result.status).toBe("rejected");
		expect(store.cursor(WS, "sess-1")).toBeUndefined();
		expect(store.list(WS)).toEqual([]);
	});

	it("an unparseable or failing LLM answer is a ledgered failure without cursor movement", async () => {
		const bad = await runExtraction(deps({ llmAnswer: "这不是 JSON" }), target, { trigger: "turn-debounce" });
		expect(bad.status).toBe("failed");
		expect(store.cursor(WS, "sess-1")).toBeUndefined();

		const errorLlm: LlmStream = {
			async *stream() {
				throw new Error("provider down");
				yield {}; // unreachable — satisfies the generator contract
			},
		};
		const failed = await runExtraction({ store, surface: surfaceOf(USER_EVENT), llm: errorLlm }, target, { trigger: "compaction" });
		expect(failed.status).toBe("failed");
		expect(failed.skipReason).toContain("provider down");

		const emptyFinish: LlmStream = {
			async *stream() {
				yield { type: "finish", reason: { kind: "max-tokens" } };
			},
		};
		const truncated = await runExtraction({ store, surface: surfaceOf(USER_EVENT), llm: emptyFinish }, target, { trigger: "compaction" });
		expect(truncated.status).toBe("failed");
		expect(truncated.skipReason).toContain("max-tokens");
	});

	it("a failing surface read is a ledgered failure", async () => {
		const result = await runExtraction(
			{ store, surface: { async readSurface() { throw new Error("disk gone"); } }, llm: fakeLlm("{}") },
			target,
			{ trigger: "compaction" },
		);
		expect(result.status).toBe("failed");
		expect(result.skipReason).toContain("disk gone");
	});
});

describe("createExtractionScheduler", () => {
	function makeHost(depsOverrides: Partial<ExtractionDeps> = {}) {
		const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
		const warns: string[] = [];
		const d = deps(depsOverrides);
		const host = {
			on(event: string, handler: (...args: unknown[]) => void) {
				const list = listeners.get(event) ?? [];
				list.push(handler);
				listeners.set(event, list);
				return () => listeners.set(event, list.filter((h) => h !== handler));
			},
			logger: () => ({ info: () => undefined, warn: (m: string) => warns.push(m) }),
		};
		return { listeners, warns, d, host };
	}

	/** An LLM whose every stream waits on its own gate, so runs can overlap. */
	function gatedLlm(text: string) {
		const calls: Record<string, unknown>[] = [];
		const gates: Array<() => void> = [];
		return {
			calls,
			release(index: number) {
				gates[index]?.();
			},
			async *stream(options: Record<string, unknown>) {
				calls.push(options);
				const index = calls.length - 1;
				await new Promise<void>((resolve) => {
					gates[index] = resolve;
				});
				yield { type: "text-delta", text };
				yield { type: "finish", reason: { kind: "stop" } };
			},
		};
	}

	const answer = JSON.stringify({
		decision: "apply",
		reason: "用户环境事实",
		proposals: [{ action: "create", type: "user", title: "Fedora 环境", description: "用户的操作系统", body: "Fedora 44", sourceSeqs: "10-10" }],
	});

	const agent = { id: "sess-1", options: { provider: "deepseek", model: "deepseek-chat" }, session: { header: { cwd: WS } } };
	const otherAgent = { id: "sess-2", options: { provider: "deepseek", model: "deepseek-chat" }, session: { header: { cwd: WS } } };
	const events = surfaceOf(USER_EVENT, ASSISTANT_EVENT);

	it("runs on the turn that scheduled it — no idle timer", async () => {
		const { listeners, d, host } = makeHost();
		const { createExtractionScheduler } = await import("../src/extraction.js");
		createExtractionScheduler(host, d);
		listeners.get("agent/turn-stopping")![0]({ agent });
		await vi.waitFor(() => {
			if (store.list(WS).length === 0) {
				throw new Error("not applied yet");
			}
		});
		expect(store.cursor(WS, "sess-1")).toBe(11);
	});

	it("coalesces a mid-run turn into one follow-up run", async () => {
		const llm = gatedLlm(answer);
		const surface = {
			rows: [USER_EVENT, ASSISTANT_EVENT] as unknown[],
			async readSurface(_id: string) {
				return { events: [...surface.rows] };
			},
		};
		const { listeners, host } = makeHost();
		const { createExtractionScheduler } = await import("../src/extraction.js");
		createExtractionScheduler(host, { store, surface, llm });
		listeners.get("agent/turn-stopping")![0]({ agent });
		await vi.waitFor(() => {
			if (llm.calls.length < 1) {
				throw new Error("first run not started");
			}
		});
		// A new turn with fresh content lands while the first run is in flight:
		// it refreshes the boundary instead of starting a second concurrent run.
		surface.rows.push({ seq: 12, type: "user/message", data: { content: "再说一句：我用 Fedora" } });
		listeners.get("agent/turn-stopping")![0]({ agent });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(llm.calls).toHaveLength(1);
		llm.release(0);
		await vi.waitFor(() => {
			if (llm.calls.length < 2) {
				throw new Error("coalesced boundary was never drained");
			}
		});
		llm.release(1);
	});

	it("keeps sessions isolated: a busy session never delays another", async () => {
		const llm = gatedLlm(answer);
		const { listeners, host } = makeHost();
		const { createExtractionScheduler } = await import("../src/extraction.js");
		createExtractionScheduler(host, { store, surface: events, llm });
		listeners.get("agent/turn-stopping")![0]({ agent });
		await vi.waitFor(() => {
			if (llm.calls.length < 1) {
				throw new Error("session 1 not started");
			}
		});
		// Session 2 schedules while session 1 is still running: it starts its
		// own run instead of waiting behind session 1's slot.
		listeners.get("agent/turn-stopping")![0]({ agent: otherAgent });
		await vi.waitFor(() => {
			if (llm.calls.length < 2) {
				throw new Error("session 2 was blocked by session 1");
			}
		});
		llm.release(0);
		llm.release(1);
	});

	it("filters internal agents at the entry: no run and no ledger row", async () => {
		const { listeners, d, host } = makeHost();
		const { createExtractionScheduler } = await import("../src/extraction.js");
		createExtractionScheduler(host, d);
		const subagent = { ...agent, session: { header: { cwd: WS, origin: "subagent" } } };
		listeners.get("agent/turn-stopping")![0]({ agent: subagent });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(d.llm.calls).toHaveLength(0);
		const rows = rawDb().prepare("select count(*) as c from extraction_log").get() as { c: number };
		expect(rows.c).toBe(0);
	});

	it("never doubles a run that is already in flight (compaction)", async () => {
		const llm = gatedLlm(answer);
		const { listeners, host } = makeHost();
		const { createExtractionScheduler } = await import("../src/extraction.js");
		createExtractionScheduler(host, { store, surface: events, llm });
		listeners.get("agent/turn-stopping")![0]({ agent });
		await vi.waitFor(() => {
			if (llm.calls.length < 1) {
				throw new Error("not started");
			}
		});
		listeners.get("session/event")![0]({ id: "sess-1" }, { type: "compaction/start" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(llm.calls).toHaveLength(1);
		llm.release(0);
	});

	it("ignores lifecycle events when no boundary is pending", async () => {
		const { listeners, d, host } = makeHost();
		const { createExtractionScheduler } = await import("../src/extraction.js");
		createExtractionScheduler(host, d);
		listeners.get("session/event")![0]({ id: "sess-1" }, { type: "compaction/start" });
		listeners.get("agent/disposed")![0]({ agent });
		listeners.get("agent/turn-stopping")![0]({}); // payload without an agent
		listeners.get("agent/turn-stopping")![0]({ agent: { id: "" } }); // no session id
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(d.llm.calls).toHaveLength(0);
	});

	it("tolerates lifecycle events for a drained session and for unknown ones", async () => {
		const { listeners, d, host } = makeHost();
		const { createExtractionScheduler } = await import("../src/extraction.js");
		createExtractionScheduler(host, d);
		listeners.get("agent/turn-stopping")![0]({ agent });
		await vi.waitFor(() => {
			if (store.list(WS).length === 0) {
				throw new Error("not run");
			}
		});
		// The slot exists but holds no boundary; the other ids have no slot.
		listeners.get("session/event")![0]({ id: "sess-1" }, { type: "compaction/start" });
		listeners.get("session/event")![0]({ id: "unknown" }, { type: "compaction/start" });
		listeners.get("session/event")![0]({}, { type: "compaction/start" });
		listeners.get("session/event")![0]({ id: "sess-1" }, { type: "other" });
		listeners.get("agent/disposed")![0]({ agent: { id: "unknown" } });
		listeners.get("agent/disposed")![0]({ agent: {} });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(d.llm.calls).toHaveLength(1);
	});

	it("drops a closing session's slot without doubling its run", async () => {
		const llm = gatedLlm(answer);
		const { listeners, host } = makeHost();
		const { createExtractionScheduler } = await import("../src/extraction.js");
		createExtractionScheduler(host, { store, surface: events, llm });
		listeners.get("agent/turn-stopping")![0]({ agent });
		await vi.waitFor(() => {
			if (llm.calls.length < 1) {
				throw new Error("not started");
			}
		});
		listeners.get("agent/turn-stopping")![0]({ agent }); // a boundary lands mid-run
		listeners.get("agent/disposed")![0]({ agent }); // the session closes while running
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(llm.calls).toHaveLength(1);
		llm.release(0);
	});

	it("dispose removes the listeners", async () => {
		const { listeners, d, host } = makeHost();
		const { createExtractionScheduler } = await import("../src/extraction.js");
		const dispose = createExtractionScheduler(host, d);
		dispose();
		expect(listeners.get("agent/turn-stopping")).toHaveLength(0);
		expect(listeners.get("session/event")).toHaveLength(0);
		expect(listeners.get("agent/disposed")).toHaveLength(0);
	});
});
