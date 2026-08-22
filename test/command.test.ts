/**
 * Tests for the /evolve command input parser and the full subcommand
 * dispatch surface: comment stripping, angle-bracket tolerance, and the
 * engine-level handlers (list/history/rollback/archive/unarchive/failures/
 * log/export/import/plan) driven through a real engine on a temp dir.
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import { findEntryById, registerEvolveCommand, stripAngleBrackets, tokenizeEvolveInput } from "../src/command.js";
import { createEvolutionEngine } from "../src/service.js";
import { emptyHarnessState, ARCHIVED_AT_KEY, type HarnessEntry } from "../src/types.js";

describe("tokenizeEvolveInput", () => {
	it("splits on whitespace", () => {
		expect(tokenizeEvolveInput("  plan 记住我的约定 ")).toEqual(["plan", "记住我的约定"]);
	});

	it("strips trailing shell-style comments", () => {
		expect(tokenizeEvolveInput("rollback evolve_x    # 验证确定性回滚（条目应消失）")).toEqual(["rollback", "evolve_x"]);
	});

	it("handles empty and comment-only input", () => {
		expect(tokenizeEvolveInput("   ")).toEqual([]);
		expect(tokenizeEvolveInput("# just a comment")).toEqual([]);
	});

	it("groups double-quoted words into one token and strips the quotes", () => {
		expect(tokenizeEvolveInput('benchmark add-case git_workflow "Commit hygiene" "Run pnpm test" "Message format"')).toEqual([
			"benchmark",
			"add-case",
			"git_workflow",
			"Commit hygiene",
			"Run pnpm test",
			"Message format",
		]);
	});

	it("supports single quotes and mixed quoting", () => {
		expect(tokenizeEvolveInput("plan '记住 这条 约定' 提交规范")).toEqual(["plan", "记住 这条 约定", "提交规范"]);
	});

	it("does not strip a # inside quotes", () => {
		expect(tokenizeEvolveInput('add-case b "fix #123" rest')).toEqual(["add-case", "b", "fix #123", "rest"]);
	});
});

describe("stripAngleBrackets", () => {
	it("strips wrapping angle brackets from pasted placeholder ids", () => {
		expect(stripAngleBrackets("<evolve_msrwsdy5_l3xzgn>")).toBe("evolve_msrwsdy5_l3xzgn");
		expect(stripAngleBrackets("evolve_msrwsdy5_l3xzgn")).toBe("evolve_msrwsdy5_l3xzgn");
		expect(stripAngleBrackets("")).toBe("");
	});
});

describe("findEntryById", () => {
	function fullEntry(id: string, kind: HarnessEntry["kind"]): HarnessEntry {
		return {
			id,
			kind,
			title: id,
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

	it("finds an entry across kinds", () => {
		const state = emptyHarnessState();
		state.entries.memory["m1"] = fullEntry("m1", "memory");
		state.entries.skill["s1"] = fullEntry("s1", "skill");
		expect(findEntryById(state, "s1")?.[0]).toBe("skill");
		expect(findEntryById(state, "s1")?.[1].id).toBe("s1");
		expect(findEntryById(state, "m1")?.[0]).toBe("memory");
	});

	it("returns undefined for unknown ids and empty stores", () => {
		expect(findEntryById(emptyHarnessState(), "nope")).toBeUndefined();
		const state = emptyHarnessState();
		state.entries.prompt["p1"] = fullEntry("p1", "prompt");
		expect(findEntryById(state, "p2")).toBeUndefined();
	});
});

/** Harness driving the real `/evolve` handler against a temp-dir engine. */
function commandHarness(): {
	dir: string;
	engine: ReturnType<typeof createEvolutionEngine>;
	run: (rawInput: string, sessionId?: string) => Promise<CommandResult>;
} {
	const dir = mkdtempSync(join(tmpdir(), "evolve-cmd-"));
	const engine = createEvolutionEngine(dir);
	let handler: ((invocation: CommandInvocation) => Promise<CommandResult>) | undefined;
	const ctx = {
		commands: {
			register: (def: { handler: (invocation: CommandInvocation) => Promise<CommandResult> }) => {
				handler = def.handler;
			},
		},
	} as unknown as Context;
	registerEvolveCommand(
		ctx,
		engine,
		{ requireGlobalApproval: false },
		{ rubricKey: Buffer.alloc(32, 7), autoRollbackOnReject: true },
	);
	if (!handler) throw new Error("evolve command was not registered");
	return {
		dir,
		engine,
		run: (rawInput, sessionId = "session-cmd") => handler({ rawInput, agent: { id: sessionId }, signal: undefined } as never),
	};
}

/** Test body wrapper: builds the harness and always cleans the temp dir up. */
function withDir(fn: (harness: ReturnType<typeof commandHarness>) => Promise<void>): () => Promise<void> {
	return async () => {
		const harness = commandHarness();
		try {
			await fn(harness);
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	};
}

async function seedMemory(harness: ReturnType<typeof commandHarness>): Promise<{ entryId: string; refinementId: string }> {
	const result = harness.engine.apply("local", "session-cmd", {
		summary: "seed",
		rationale: "test seed",
		expectedOutcome: "one memory exists",
		edits: [{ action: "create", kind: "memory", title: "seed entry", content: "body" }],
	}, { scope: "local" });
	const applied = result.appliedEdits.find((e) => e.applied);
	if (!applied?.id) throw new Error("seed edit failed");
	return { entryId: applied.id, refinementId: result.id };
}

describe("executeEvolveCommand — help / dispatch", () => {
	it("shows usage plus the local store for bare /evolve", withDir(async (h) => {
		const result = await h.run("");
		expect(result.kind).toBe("success");
		expect(result.text).toContain("Usage:");
		expect(result.text).toContain("# Continual Harness State");
	}));

	it("rejects unknown subcommands with the usage text", withDir(async (h) => {
		const result = await h.run("frobnicate");
		expect(result.kind).toBe("error");
		expect(result.text).toContain("unknown subcommand: frobnicate");
		expect(result.text).toContain("Usage:");
	}));

	it("lists both stores via the global scope argument", withDir(async (h) => {
		const local = await h.run("list");
		expect(local.kind).toBe("success");
		const global = await h.run("list global");
		expect(global.kind).toBe("success");
		expect(global.text).toContain("# Continual Harness State");
	}));
});

describe("executeEvolveCommand — history / rollback", () => {
	it("reports an empty history before any refinement", withDir(async (h) => {
		const result = await h.run("history");
		expect(result.kind).toBe("success");
		expect(result.text).toContain("No prior refinement history.");
	}));

	it("shows applied refinements and rolls back by id, tolerating <id> placeholders", withDir(async (h) => {
		const { refinementId } = await seedMemory(h);
		const localHistory = await h.run("history");
		expect(localHistory.kind).toBe("success");
		expect(localHistory.text).toContain("seed");

		const globalHistory = await h.run("history global"); // scope prefix must be tolerated
		expect(globalHistory.kind).toBe("success");
		expect(globalHistory.text).toContain("No prior refinement history.");

		const rollbackMissing = await h.run(`rollback <${refinementId}>`, "session-other");
		expect(rollbackMissing.kind).toBe("error"); // other session has no such refinement

		const rollback = await h.run(`rollback <${refinementId}>`);
		expect(rollback.kind).toBe("success");
		expect(rollback.text).toContain(`rollback of ${refinementId}`);
	}));

	it("requires a refinement id", withDir(async (h) => {
		const result = await h.run("rollback");
		expect(result.kind).toBe("error");
		expect(result.text).toContain("rollback requires a refinement id");
	}));
});

describe("executeEvolveCommand — archive / unarchive", () => {
	it("hides and restores an entry through its metadata key", withDir(async (h) => {
		const { entryId: id } = await seedMemory(h);

		const missing = await h.run("archive <nope>");
		expect(missing.kind).toBe("error");
		expect(missing.text).toContain("entry nope not found");

		const archive = await h.run(`archive ${id}`);
		expect(archive.kind).toBe("success");
		const entry = h.engine.load("local", "session-cmd").entries.memory[id];
		expect(entry?.metadata[ARCHIVED_AT_KEY]).toBeTruthy();

		const unarchive = await h.run(`unarchive ${id}`);
		expect(unarchive.kind).toBe("success");
		expect(h.engine.load("local", "session-cmd").entries.memory[id]?.metadata[ARCHIVED_AT_KEY]).toBeUndefined();
	}));

	it("requires an entry id for both directions", withDir(async (h) => {
		for (const input of ["archive", "unarchive"]) {
			const result = await h.run(input);
			expect(result.kind).toBe("error");
			expect(result.text).toContain(`${input} requires an entry id`);
		}
	}));
});

describe("executeEvolveCommand — failures", () => {
	it("aggregates failed gate records from reviews.jsonl", withDir(async (h) => {
		const result0 = await h.run("failures");
		expect(result0.kind).toBe("success");

		mkdirSync(join(h.dir, "evolve"), { recursive: true });
		writeFileSync(
			join(h.dir, "evolve", "reviews.jsonl"),
			`${JSON.stringify({
				timestamp: "2026-08-22T01:00:00.000Z",
				sessionId: "session-x",
				reason: "turn_interval",
				turnsSinceLastReview: 2,
				outcome: "failed",
				rationale: "gate error: review gate produced no text",
			})}\n`,
			"utf8",
		);
		const result = await h.run("failures");
		expect(result.kind).toBe("success");
		expect(result.text).toContain("recent 10:");
		expect(result.text).toContain("review-gate:turn_interval");
		expect(result.text).toContain("review gate produced no text");
	}));
});

describe("executeEvolveCommand — log", () => {
	it("reports a missing plugin log", withDir(async (h) => {
		const result = await h.run("log");
		expect(result.kind).toBe("success");
		expect(result.text).toContain("(no plugin log yet");
	}));

	it("tails lines and applies the session filter", withDir(async (h) => {
		mkdirSync(join(h.dir, "evolve"), { recursive: true });
		writeFileSync(
			join(h.dir, "evolve", "plugin.log"),
			[
				JSON.stringify({ ts: "2026-08-22T00:00:01Z", type: "info", name: "gate", message: "first session-aaa11111" }),
				JSON.stringify({ ts: "2026-08-22T00:00:02Z", type: "info", name: "gate", message: "second session-bbb22222" }),
				JSON.stringify({ ts: "2026-08-22T00:00:03Z", type: "warn", name: "gate", message: "third session-aaa11111" }),
			].join("\n") + "\n",
			"utf8",
		);
		const all = await h.run("log");
		expect(all.kind).toBe("success");
		expect(all.text).toContain("(3 lines, showing last 3)");

		const tailOne = await h.run("log 1");
		expect(tailOne.kind).toBe("success");
		expect(tailOne.text).toContain("showing last 1)");
		expect(tailOne.text).toContain("third session-aaa11111");

		const filtered = await h.run("log session session-aaa11111");
		expect(filtered.kind).toBe("success");
		expect(filtered.text).toContain("2 for session session-aaa11111");
		expect(filtered.text).not.toContain("second session-bbb22222");
	}));

	it("rejects non-positive tails and empty session filters", withDir(async (h) => {
		const badTail = await h.run("log abc");
		expect(badTail.kind).toBe("error");
		expect(badTail.text).toContain('must be a positive integer, got "abc"');

		const zeroTail = await h.run("log 0");
		expect(zeroTail.kind).toBe("error");

		const missingSession = await h.run("log session");
		expect(missingSession.kind).toBe("error");
		expect(missingSession.text).toContain("log session requires a session id");
	}));
});

describe("executeEvolveCommand — export / import", () => {
	it("requires paths on both directions", withDir(async (h) => {
		expect((await h.run("export")).text).toContain("export requires an output path");
		expect((await h.run("import")).kind).toBe("error");
	}));

	it("exports a store and imports it back into another session", withDir(async (h) => {
		await seedMemory(h);

		const target = join(h.dir, "export.json");

		const exportResult = await h.run(`export ${target}`);
		expect(exportResult.kind).toBe("success");
		expect(exportResult.text).toContain("exported local store (1 entries, 1 refinements)");
		expect(existsSync(target)).toBe(true);

		const imported = await h.run(`import ${target}`, "session-restored");
		expect(imported.kind).toBe("success");
		expect(imported.text).toContain("imported local store from");
		const restored = h.engine.load("local", "session-restored").entries.memory;
		expect(Object.values(restored)[0]?.title).toBe("seed entry");
	}));

	it("rejects malformed payloads and corrupt JSON", withDir(async (h) => {
		const badShape = join(h.dir, "bad-shape.json");
		writeFileSync(badShape, JSON.stringify({ version: 1 }), "utf8");
		const shapeResult = await h.run(`import ${badShape}`);
		expect(shapeResult.kind).toBe("error");
		expect(shapeResult.text).toContain("invalid export file shape");

		const corrupt = join(h.dir, "corrupt.json");
		writeFileSync(corrupt, "{oops", "utf8");
		const corruptResult = await h.run(`import ${corrupt}`);
		expect(corruptResult.kind).toBe("error");
	}));
});

describe("executeEvolveCommand — plan", () => {
	it("contains planner failures as error results instead of throwing", withDir(async (h) => {
		const result = await h.run("plan write it down");
		expect(result.kind).toBe("error");
		expect(result.text.length).toBeGreaterThan(0);
	}));
});
