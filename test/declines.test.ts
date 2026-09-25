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
	declinedMemoryPath,
	fingerprintMemoryBatch,
	isDeclinedRepeat,
	loadDeclinedMemory,
	MAX_DECLINED_MEMORY_LEDGER,
	recordDeclinedMemory,
} from "../src/declines.js";
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
				{ scope: "global", fingerprint: "fp", title: "t", declinedAt: "2026-09-25T00:00:00.000Z" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("caps the ledger oldest-first", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-declines-cap-"));
		try {
			for (let index = 0; index < MAX_DECLINED_MEMORY_LEDGER + 5; index += 1) {
				recordDeclinedMemory(dir, "global", `fp-${index}`, `title-${index}`);
			}
			const entries = loadDeclinedMemory(dir);
			expect(entries).toHaveLength(MAX_DECLINED_MEMORY_LEDGER);
			expect(entries.some((entry) => entry.fingerprint === "fp-0")).toBe(false);
			expect(entries.some((entry) => entry.fingerprint === `fp-${MAX_DECLINED_MEMORY_LEDGER + 4}`)).toBe(true);
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
			recordDeclinedMemory(dir, "project", "fp-c", "c");
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
