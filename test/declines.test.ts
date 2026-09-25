import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
	applyMemoryExtractionProposal,
	type MemoryExtractionProposal,
} from "../src/memory-agent.js";
import {
	declinedContentTokens,
	declinedMemoryPath,
	fingerprintMemoryBatch,
	isDeclinedRepeat,
	loadDeclinedMemory,
	matchDeclinedCheckpoint,
	MAX_DECLINED_ENTRY_TOKENS,
	MAX_DECLINED_MEMORY_LEDGER,
	recordDeclinedMemory,
} from "../src/declines.js";
import { tokenize } from "../src/search.js";
import { createEvolutionEngine } from "../src/service.js";

function proposal(edits: MemoryExtractionProposal["edits"] = []): MemoryExtractionProposal {
	return { summary: "Memory checkpoint", rationale: "durable evidence", expectedOutcome: "better recall", edits };
}

function withEngine(run: (engine: ReturnType<typeof createEvolutionEngine>) => Promise<void>): () => Promise<void> {
	return async () => {
		const engine = createEvolutionEngine(mkdtempSync(join(tmpdir(), "evolve-declines-")));
		try {
			await run(engine);
		} finally {
			rmSync(engine.baseDir, { recursive: true, force: true });
		}
	};
}

function loggerCtx(ask: () => Promise<unknown>): Context {
	return {
		userQuestions: { ask },
		logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
	} as unknown as Context;
}

const batch = [
	{
		action: "create",
		kind: "memory",
		targetScope: "global",
		blastRadius: "general",
		title: "输入法环境",
		content: "fcitx5 需要 GTK_IM_MODULE=fcitx。",
		metadata: { memoryType: "user" },
	},
] as const;

describe("fingerprintMemoryBatch", () => {
	it("is stable across whitespace variants", () => {
		const base = fingerprintMemoryBatch("global", [{ action: "create", title: "t", content: "a  b" }]);
		const variant = fingerprintMemoryBatch("global", [{ action: "create", title: "t", content: "a\n\t b " }]);
		expect(variant).toBe(base);
	});

	it("differs across scope, action, title, and content", () => {
		const base = fingerprintMemoryBatch("global", [{ action: "create", title: "t", content: "c" }]);
		expect(fingerprintMemoryBatch("project", [{ action: "create", title: "t", content: "c" }])).not.toBe(base);
		expect(fingerprintMemoryBatch("global", [{ action: "update", title: "t", content: "c" }])).not.toBe(base);
		expect(fingerprintMemoryBatch("global", [{ action: "create", title: "other", content: "c" }])).not.toBe(base);
		expect(fingerprintMemoryBatch("global", [{ action: "create", title: "t", content: "changed" }])).not.toBe(base);
		expect(fingerprintMemoryBatch("global", [{ action: "update", id: "abc", title: "t", content: "c" }])).not.toBe(
			fingerprintMemoryBatch("global", [{ action: "update", title: "t", content: "c" }]),
		);
	});
});

describe("decline ledger IO", () => {
	it("reads missing and corrupt files as empty (fail-closed to asking)", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-declines-io-"));
		try {
			expect(loadDeclinedMemory(dir)).toEqual([]);
			mkdirSync(join(dir, "evolve"), { recursive: true });
			writeFileSync(declinedMemoryPath(dir), "not json{{{", "utf8");
			expect(loadDeclinedMemory(dir)).toEqual([]);
			writeFileSync(declinedMemoryPath(dir), `{"not":"a list"}`, "utf8");
			expect(loadDeclinedMemory(dir)).toEqual([]);
			writeFileSync(
				declinedMemoryPath(dir),
				JSON.stringify(["junk", null, 42, { scope: "global", fingerprint: "fp", title: "t", declinedAt: "2026-09-25T00:00:00.000Z" }]),
				"utf8",
			);
			expect(loadDeclinedMemory(dir)).toEqual([
				{ scope: "global", fingerprint: "fp", title: "t", tokens: [], declinedAt: "2026-09-25T00:00:00.000Z" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("caps the ledger oldest-first", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-declines-cap-"));
		try {
			for (let index = 0; index < MAX_DECLINED_MEMORY_LEDGER + 5; index += 1) {
				recordDeclinedMemory(dir, "global", [{ action: "create", title: `title-${index}`, content: `content-${index}` }], `title-${index}`);
			}
			const entries = loadDeclinedMemory(dir);
			expect(entries).toHaveLength(MAX_DECLINED_MEMORY_LEDGER);
			const fps = new Set(entries.map((entry) => entry.fingerprint));
			expect(fps.size).toBe(MAX_DECLINED_MEMORY_LEDGER);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sorts stable when timestamps tie", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-declines-tie-"));
		try {
			mkdirSync(join(dir, "evolve"), { recursive: true });
			writeFileSync(
				declinedMemoryPath(dir),
				JSON.stringify([
					{ scope: "global", fingerprint: "fp-a", title: "a", declinedAt: "2026-09-25T00:00:00.000Z" },
					{ scope: "global", fingerprint: "fp-b", title: "b", declinedAt: "2026-09-25T00:00:00.000Z" },
				]),
				"utf8",
			);
			recordDeclinedMemory(dir, "project", [{ action: "create", title: "c", content: "cc" }], "c");
			expect(loadDeclinedMemory(dir)).toHaveLength(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("decline repeat suppression in apply", () => {
	const globalBatch = () => proposal([...batch.map((edit) => ({ ...edit }))]);

	it("records a decline and suppresses the exact repeat without asking again", withEngine(async (engine) => {
		const agent = { id: "session-decline-loop" } as Agent;
		let approvals = 0;
		const ctx = loggerCtx(async () => {
			approvals += 1;
			return { answers: [{ id: "approve-global-evolve", selected: ["拒绝"] }] };
		});
		const baselines = () => ({ local: engine.load("local", agent.id), global: engine.load("global", undefined) });
		const first = await applyMemoryExtractionProposal(ctx, engine, globalBatch(), {
			agent,
			baselines: baselines(),
			requireApproval: true,
		});
		expect(first.declinedScopes).toEqual(["global"]);
		expect(approvals).toBe(1);
		expect(loadDeclinedMemory(engine.baseDir)).toHaveLength(1);

		const second = await applyMemoryExtractionProposal(ctx, engine, globalBatch(), {
			agent,
			baselines: baselines(),
			requireApproval: true,
		});
		expect(second.declinedScopes).toEqual(["global"]);
		expect(approvals).toBe(1);
	}));

	it("still asks when the batch content changes", withEngine(async (engine) => {
		const agent = { id: "session-decline-changed" } as Agent;
		let approvals = 0;
		const ctx = loggerCtx(async () => {
			approvals += 1;
			return { answers: [{ id: "approve-global-evolve", selected: ["拒绝"] }] };
		});
		const baselines = () => ({ local: engine.load("local", agent.id), global: engine.load("global", undefined) });
		await applyMemoryExtractionProposal(ctx, engine, globalBatch(), { agent, baselines: baselines(), requireApproval: true });
		const changed = globalBatch();
		if (changed.edits[0] !== undefined) changed.edits[0].content = "ibus 需要 GTK_IM_MODULE=ibus。";
		await applyMemoryExtractionProposal(ctx, engine, changed, { agent, baselines: baselines(), requireApproval: true });
		expect(approvals).toBe(2);
		expect(isDeclinedRepeat(
			loadDeclinedMemory(engine.baseDir),
			"global",
			fingerprintMemoryBatch("global", changed.edits),
		)).toBe(true);
	}));
});

describe("decline secret screen and checkpoint precheck", () => {
	const fcitx = [{ action: "create", title: "输入法环境", content: "fcitx5 需要设置 GTK_IM_MODULE 变量为 fcitx。" }];

	it("skips secret-shaped declines without touching the ledger", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-declines-secret-"));
		try {
			const secret = [{ action: "create", title: "发布令牌", content: `Call the API with token ghp_${"abcdefghijklmnopqrstuvwxyz123456"}` }];
			expect(recordDeclinedMemory(dir, "global", secret, "发布令牌")).toBeUndefined();
			expect(loadDeclinedMemory(dir)).toEqual([]);
			expect(recordDeclinedMemory(dir, "global", fcitx, "输入法环境")).not.toBeUndefined();
			expect(loadDeclinedMemory(dir)).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("matches checkpoints that re-cover declined content", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-declines-match-"));
		try {
			recordDeclinedMemory(dir, "global", fcitx, "输入法环境");
			const entries = loadDeclinedMemory(dir);
			expect(entries[0]?.tokens.length).toBeGreaterThan(0);
			const hit = matchDeclinedCheckpoint(entries, tokenize("今晚又在调输入法环境，fcitx5 需要设置 GTK_IM_MODULE 变量为 fcitx 才能连拼。"));
			expect(hit?.entry.scope).toBe("global");
			expect(hit?.coverage).toBeGreaterThanOrEqual(0.85);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores unrelated checkpoints and tiny entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-declines-miss-"));
		try {
			recordDeclinedMemory(dir, "global", fcitx, "输入法环境");
			recordDeclinedMemory(dir, "global", [{ action: "create", title: "好", content: "" }], "好");
			const entries = loadDeclinedMemory(dir);
			expect(matchDeclinedCheckpoint(entries, tokenize("今天把覆盖率又往上打了一轮，门禁全绿。"))).toBeUndefined();
			expect(matchDeclinedCheckpoint(entries, tokenize("好"))).toBeUndefined();
			expect(matchDeclinedCheckpoint([], tokenize("fcitx5 GTK_IM_MODULE"))).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("caps stored tokens per entry", () => {
		const tokens = declinedContentTokens([{ action: "create", title: "t", content: "内容 ".repeat(300) }]);
		expect(tokens.length).toBeLessThanOrEqual(MAX_DECLINED_ENTRY_TOKENS);
	});
});

describe("matchDeclinedCheckpoint selection", () => {
	function seed(dir: string): void {
		mkdirSync(join(dir, "evolve"), { recursive: true });
		writeFileSync(
			declinedMemoryPath(dir),
			JSON.stringify([
				{ scope: "global", fingerprint: "a", title: "a", tokens: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"], declinedAt: "2026-09-25T00:00:00.000Z" },
				{ scope: "global", fingerprint: "b", title: "b", tokens: ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"], declinedAt: "2026-09-25T00:00:00.000Z" },
				{ scope: "global", fingerprint: "empty", title: "e", tokens: [], declinedAt: "2026-09-25T00:00:00.000Z" },
			]),
			"utf8",
		);
	}

	it("picks the strongest coverage and skips tokenless entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-declines-best-"));
		try {
			seed(dir);
			const entries = loadDeclinedMemory(dir);
			const hit = matchDeclinedCheckpoint(entries, ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "extra"]);
			expect(hit?.entry.fingerprint).toBe("b");
			expect(hit?.coverage).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("misses when coverage clears the token floor but not the coverage floor", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-declines-partial-"));
		try {
			seed(dir);
			const entries = loadDeclinedMemory(dir);
			expect(matchDeclinedCheckpoint(entries, ["alpha", "beta", "gamma", "delta", "epsilon", "zzz"])).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
