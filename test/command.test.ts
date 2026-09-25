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
import { saveHarnessState } from "../src/state.js";
import { storePaths } from "../src/store.js";
import { emptyHarnessState, ARCHIVED_AT_KEY, type HarnessEntry } from "../src/types.js";
import { TOKEN_USAGE_LEDGER_VERSION, appendTokenUsage } from "../src/token-usage.js";

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
function commandHarness(
	runtimeOverride: Partial<Parameters<typeof registerEvolveCommand>[3]> = {},
	extra: {
		requireGlobalApproval?: boolean;
		llm?: Context["llm"];
		userQuestions?: { ask: (request: unknown) => Promise<unknown> };
	} = {},
): {
	dir: string;
	engine: ReturnType<typeof createEvolutionEngine>;
	run: (rawInput: string, sessionId?: string, agent?: CommandInvocation["agent"]) => Promise<CommandResult>;
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
		get: () => undefined,
		...(extra.llm ? { llm: extra.llm } : {}),
		...(extra.userQuestions ? { userQuestions: extra.userQuestions } : {}),
	} as unknown as Context;
	registerEvolveCommand(
		ctx,
		engine,
		{ requireGlobalApproval: extra.requireGlobalApproval ?? false },
		{ rubricKey: Buffer.alloc(32, 7), autoRollbackOnReject: true, ...runtimeOverride },
	);
	if (!handler) throw new Error("evolve command was not registered");
	return {
		dir,
		engine,
		run: (rawInput: string, sessionId = "session-cmd", agent?: CommandInvocation["agent"]) =>
			handler({ rawInput, agent: agent ?? { id: sessionId }, signal: undefined } as never),
	};
}

/** Test body wrapper: builds the harness and always cleans the temp dir up. */
function withDir(
	fn: (harness: ReturnType<typeof commandHarness>) => Promise<void>,
	runtimeOverride: Partial<Parameters<typeof registerEvolveCommand>[3]> = {},
	extra: Parameters<typeof commandHarness>[1] = {},
): () => Promise<void> {
	return async () => {
		const harness = commandHarness(runtimeOverride, extra);
		try {
			await fn(harness);
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	};
}


/** Seed one GLOBAL entry and return its id (for demote tests). */
function seedGlobal(harness: ReturnType<typeof commandHarness>): string {
	const result = harness.engine.apply("global", undefined, {
		summary: "seed global",
		rationale: "test",
		expectedOutcome: "one global memory",
		edits: [{ action: "create", kind: "memory", title: "global noise", content: "cross-project noise entry", metadata: { memoryType: "reference" } }],
	}, { scope: "global" });
	const applied = result.appliedEdits.find((e) => e.applied);
	if (!applied?.id) throw new Error("global seed failed");
	return applied.id;
}

async function seedMemory(harness: ReturnType<typeof commandHarness>): Promise<{ entryId: string; refinementId: string }> {
	const result = harness.engine.apply("local", "session-cmd", {
		summary: "seed",
		rationale: "test seed",
		expectedOutcome: "one memory exists",
		edits: [{ action: "create", kind: "memory", title: "seed entry", content: "body", metadata: { memoryType: "reference" } }],
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

describe("executeEvolveCommand — demote (2026-08-22)", () => {
	it("archives a global entry in place and reports the restore path", withDir(async (h) => {
		const id = seedGlobal(h);
		const demoted = await h.run(`demote ${id}`);
		expect(demoted.kind).toBe("success");
		expect(demoted.text).toContain(`demoted memory:${id} from the global store`);
		const entry = h.engine.load("global").entries.memory[id];
		expect(entry?.metadata[ARCHIVED_AT_KEY]).toBeTruthy(); // data kept
	}));

	it("falls back to the local store when global lacks the id", withDir(async (h) => {
		await seedMemory(h);
		const demoted = await h.run("demote seed_entry");
		expect(demoted.kind).toBe("success");
		expect(demoted.text).toContain("from the local store");
	}));

	it("errors when the id exists nowhere", withDir(async (h) => {
		const missing = await h.run("demote nope");
		expect(missing.kind).toBe("error");
		expect(missing.text).toContain("not found in the global, project, or local store");
	}));
});

describe("executeEvolveCommand — pause / resume / status (#21 P2)", () => {
	it("pauses and resumes the gate, idempotently", withDir(async (h) => {
		const paused = await h.run("pause");
		expect(paused.kind).toBe("success");
		expect(paused.text).toContain("paused");
		const again = await h.run("pause");
		expect(again.text).toContain("already paused");
		const status = await h.run("status");
		expect(status.kind).toBe("success");
		expect(status.text).toContain("PAUSED");
		const resumed = await h.run("resume");
		expect(resumed.text).toContain("resumed");
		const running = await h.run("status");
		expect(running.text).toContain("running");
		expect(running.text).not.toContain("PAUSED");
	}));

	it("status reports store counts and the unknown patch flag under test wiring", withDir(async (h) => {
		await seedMemory(h);
		const status = await h.run("status");
		expect(status.kind).toBe("success");
		expect(status.text).toContain("config default unknown");
		expect(status.text).toContain("Memory Agent-only listener registered");
		expect(status.text).toContain("runtime Memory Agent off");
		expect(status.text).toContain("local(session-cmd) 1 entries");
		expect(status.text).toContain("retention:");
		expect(status.text).toContain("token usage");
	}));

	// Regression (v0.7.5): the listener used to be registered only when
	// `autoReview === true`, so a default install with no profile config got
	// "wiring is disabled by project policy" and `/evolve resume` could not
	// turn the Memory Agent on. The listener is always registered now.
	it("resumes the Memory Agent on a default install where autoReview is false", withDir(async (h) => {
		const resumed = await h.run("resume");
		expect(resumed.kind).toBe("success");
		expect(resumed.text).toContain("resumed");
		expect(resumed.text).not.toContain("disabled");
		const status = await h.run("status");
		expect(status.text).toContain("Memory Agent running");
		expect(status.text).toContain("config default off");
	}, { autoReview: false }));
});

describe("executeEvolveCommand — usage (#21 P0)", () => {
	it("reports injection counts with stale entries flagged", withDir(async (h) => {
		const { entryId } = await seedMemory(h);
		const globalId = seedGlobal(h);
		const { recordInjection } = await import("../src/usage.js");
		recordInjection(h.dir, [`memory:${entryId}`], "session-past");
		recordInjection(h.dir, [`memory:${entryId}`], "session-past"); // same session: no double count
		recordInjection(h.dir, [`memory:${entryId}`], "session-other");
		const result = await h.run("usage");
		expect(result.kind).toBe("success");
		expect(result.text).toContain(`memory:${entryId} — 2×`);
		expect(result.text).toContain("(last in session-other)");
		expect(result.text).toContain("never injected (1):");
		expect(result.text).toContain(`memory:${globalId}`);
	}));

	it("reports retained direct-call token totals and explicit scope limits", withDir(async (h) => {
		const target = { baseDir: h.dir, sessionId: "session-cmd", retain: h.engine.retention.tokenUsage };
		appendTokenUsage(target, {
			version: TOKEN_USAGE_LEDGER_VERSION,
			timestamp: "2026-09-24T00:00:00.000Z",
			sessionId: "session-cmd",
			phase: "review",
			provider: "p",
			model: "m",
			outcome: "success",
			usageStatus: "reported",
			usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 10 },
			totalSource: "provider",
		});
		appendTokenUsage(target, {
			version: TOKEN_USAGE_LEDGER_VERSION,
			timestamp: "2026-09-24T00:00:01.000Z",
			sessionId: "session-cmd",
			phase: "planner",
			provider: "p",
			model: "m",
			outcome: "error",
			usageStatus: "missing",
			totalSource: "unavailable",
		});
		const result = await h.run("usage");
		expect(result.kind).toBe("success");
		expect(result.text).toContain("direct LLM token usage: 2 valid calls (1 reported usage, 1 missing)");
		expect(result.text).toContain("exact total:    10 (reported calls only)");
		expect(result.text).toContain(`window: last ${h.engine.retention.tokenUsage} call(s), not a lifetime total`);
		expect(result.text).toContain("host benchmark subagents");
	}));

	it("reports an empty ledger before anything was injected", withDir(async (h) => {
		const result = await h.run("usage");
		expect(result.kind).toBe("success");
		expect(result.text).toContain("0 of 0 stored entries");
		expect(result.text).toContain("(none yet");
	}));
});

describe("executeEvolveCommand — recall / remember / forget", () => {
	it("recalls a memory by query with full content", withDir(async (h) => {
		await seedMemory(h);
		const result = await h.run("recall seed entry");
		expect(result.kind).toBe("success");
		expect(result.text).toContain("1 hit(s)");
		expect(result.text).toContain("seed entry");
	}));

	it("remember persists one typed memory immediately", withDir(async (h) => {
		const result = await h.run("remember user 偏好深色主题");
		expect(result.kind).toBe("success");
		expect(result.text).toContain("1 applied");
		const recalled = await h.run("recall 深色");
		expect(recalled.text).toContain("偏好深色主题");
	}));

	it("remember rejects a missing type and empty text", withDir(async (h) => {
		const noType = await h.run("remember 偏好深色主题");
		expect(noType.kind).toBe("error");
		expect(noType.text).toContain("requires a memory type");
		const noText = await h.run("remember user");
		expect(noText.kind).toBe("error");
		expect(noText.text).toContain("requires the memory text");
	}));

	it("remember surfaces engine validation for feedback without Why/How", withDir(async (h) => {
		// Engine validation failures land per-edit (0 applied), not as a
		// command error — same contract as /evolve plan.
		const result = await h.run("remember feedback 纯事实无依据");
		expect(result.kind).toBe("success");
		expect(result.text).toContain("0 applied, 1 failed");
		expect(result.text).toContain("Why and a How");
	}));

	it("forget archives the single match and stays restorable", withDir(async (h) => {
		const { entryId } = await seedMemory(h);
		const result = await h.run("forget seed entry");
		expect(result.kind).toBe("success");
		expect(result.text).toContain("forgot");
		const unarchive = await h.run(`unarchive ${entryId}`);
		expect(unarchive.kind).toBe("success");
	}));

	it("forget lists candidates instead of archiving an ambiguous query", withDir(async (h) => {
		// Pure-Chinese titles take hashed ids since the 2026-09-25 slug
		// fix, so both memories land instead of colliding on "memory".
		await h.run("remember user 深色主题偏好一");
		await h.run("remember user 深色主题偏好二");
		const result = await h.run("forget 深色");
		expect(result.kind).toBe("success");
		expect(result.text).toContain("matches 2 memories");
		// Nothing was archived: both are still recallable.
		const recalled = await h.run("recall 深色");
		expect(recalled.text).toContain("2 hit(s)");
	}));

	it("forget reports no match instead of failing silently", withDir(async (h) => {
		const result = await h.run("forget 不存在的记忆主题xyz");
		expect(result.kind).toBe("error");
		expect(result.text).toContain("no memory matches");
	}));

	it("forget requires a query", withDir(async (h) => {
		const result = await h.run("forget");
		expect(result.kind).toBe("error");
		expect(result.text).toContain("forget requires a query");
	}));
});

describe("executeEvolveCommand — project scope", () => {
	const cwdAgent = { id: "session-cmd", session: { header: { cwd: "/mnt/work/app" } } } as never;

	it("lists the project store for an agent with a session cwd", withDir(async (h) => {
		const listed = await h.run("list project", "session-cmd", cwdAgent);
		expect(listed.kind).toBe("success");
	}));

	it("fails loudly for project scope without a session cwd", withDir(async (h) => {
		const result = await h.run("list project");
		expect(result.kind).toBe("error");
		expect(result.text).toContain("project scope needs the session cwd");
	}));

	it("remembers directly into the project store", withDir(async (h) => {
		const result = await h.run("remember user project 偏好深色主题项目级", "session-cmd", cwdAgent);
		expect(result.kind).toBe("success");
		expect(result.text).toContain("1 applied");
	}));

	it("asks approval before remembering into the global store", withDir(async (h) => {
		const result = await h.run("remember user global 偏好深色主题跨会话");
		expect(result.kind).toBe("success");
		expect(result.text).toContain("1 applied");
		const recalled = await h.run("recall 深色", "session-cmd", { id: "other-session" } as never);
		expect(recalled.text).toContain("偏好深色主题跨会话");
	}, {}, { requireGlobalApproval: true, userQuestions: { ask: async () => ({ answers: [{ id: "approve-global-evolve", selected: ["批准"] }] }) } }));
});

describe("executeEvolveCommand — consolidate", () => {
	it("reports a clean store with nothing to do", withDir(async (h) => {
		const result = await h.run("consolidate");
		expect(result.kind).toBe("success");
		expect(result.text).toContain("already consolidated");
	}));

	function seedStaleGlobal(h: ReturnType<typeof commandHarness>, title: string): string {
		const applied = h.engine.apply("global", undefined, {
			summary: "seed stale",
			rationale: "test",
			expectedOutcome: "stale candidate",
			edits: [{ action: "create", kind: "memory", title, content: `${title}的完整正文内容足够长可以沉淀`, metadata: { memoryType: "reference" } }],
		}, { scope: "global" }).appliedEdits.find((e) => e.applied);
		if (!applied?.id) throw new Error("seed failed");
		const state = h.engine.load("global", undefined);
		state.entries.memory[applied.id]!.updated_at = "2025-01-01T00:00:00.000Z";
		saveHarnessState(storePaths(h.dir, "global", undefined).stateDir, state);
		return applied.id;
	}

	it("reports and applies stale zero-use entries in one batch", withDir(async (h) => {
		const id = seedStaleGlobal(h, "stale entry one");
		const report = await h.run("consolidate");
		expect(report.kind).toBe("success");
		expect(report.text).toContain("consolidation plan");
		expect(report.text).toContain(id);
		const applied = await h.run("consolidate apply");
		expect(applied.kind).toBe("success");
		expect(applied.text).toContain("applied:");
		expect(h.engine.load("global", undefined).entries.memory[id]?.metadata[ARCHIVED_AT_KEY]).toBeTruthy();
	}));

	it("merges conflict-pair content into the survivor with merge", withDir(async (h) => {
		// Seed through the store directly: the write-time conflict guard
		// would block the near-duplicate create via engine.apply.
		const { CONFLICT_HINT_KEY } = await import("../src/types.js");
		const state = emptyHarnessState();
		const survivor = { id: "survivor", kind: "memory", title: "survivor fact", content: "Survivor durable content about builds.", path: "general", scope: "global", reference: {}, arguments: {}, metadata: { memoryType: "reference" }, source: "evolve", created_at: "2026-09-25T00:00:00.000Z", updated_at: "2026-09-25T00:00:00.000Z", version: 1 };
		const dup = { ...survivor, id: "dup", title: "survivor fact restated", content: "Survivor durable content about builds restated.", metadata: { memoryType: "reference", [CONFLICT_HINT_KEY]: "memory:survivor:0.85" } };
		state.entries.memory["survivor"] = survivor as never;
		state.entries.memory["dup"] = dup as never;
		saveHarnessState(storePaths(h.dir, "global", undefined).stateDir, state);
		const report = await h.run("consolidate merge");
		expect(report.kind).toBe("success");
		expect(report.text).toContain("并入");
		const applied = await h.run("consolidate apply merge");
		expect(applied.kind).toBe("success");
		const survivorEntry = h.engine.load("global", undefined).entries.memory[survivor.id];
		expect(survivorEntry?.content).toContain("Merged from");
		expect(h.engine.load("global", undefined).entries.memory[dup.id]?.metadata[ARCHIVED_AT_KEY]).toBeTruthy();
	}));
});

describe("executeEvolveCommand — subcommand passthroughs", () => {
	it("routes wrapup / goal / mount / unmount / benchmark", withDir(async (h) => {
		const wrapup = await h.run("wrapup");
		expect(wrapup.kind).toBe("success");
		expect(wrapup.text).toContain("nothing to wrap up");

		const goal = await h.run("goal");
		expect(goal.kind).toBe("error");
		expect(goal.text).toContain("goals service");

		const mountUsage = await h.run("mount");
		expect(mountUsage.kind).toBe("error");
		expect(mountUsage.text).toContain("mount requires");

		const mountList = await h.run("mount list");
		expect(mountList.kind).toBe("success");

		const unmountUsage = await h.run("unmount");
		expect(unmountUsage.kind).toBe("error");
		expect(unmountUsage.text).toContain("unmount requires");

		const benchmark = await h.run("benchmark");
		expect(benchmark.kind).toBe("success");
	}));
});

describe("executeEvolveCommand — project-aware status / usage / log", () => {
	const cwdAgent = { id: "session-cmd", session: { header: { cwd: "/mnt/work/app" } } } as never;

	it("shows the project store line in status for an agent with a cwd", withDir(async (h) => {
		const status = await h.run("status", "session-cmd", cwdAgent);
		expect(status.kind).toBe("success");
		expect(status.text).toContain("project");
	}));

	it("reports usage for an agent with a cwd", withDir(async (h) => {
		const usage = await h.run("usage", "session-cmd", cwdAgent);
		expect(usage.kind).toBe("success");
		expect(usage.text).toContain("injected entries");
	}));

	it("folds long injected and stale lists behind counters", withDir(async (h) => {
		const { saveUsage } = await import("../src/usage.js");
		const ids: string[] = [];
		for (let i = 0; i < 37; i += 1) {
			const applied = h.engine.apply("local", "session-cmd", {
				summary: `seed ${i}`,
				rationale: "test",
				expectedOutcome: "usage entry",
				edits: [{ action: "create", kind: "memory", title: `usage entry ${i}`, content: "durable content body", metadata: { memoryType: "reference" } }],
			}, { scope: "local" }).appliedEdits.find((e) => e.applied);
			if (!applied?.id) throw new Error("seed failed");
			ids.push(applied.id);
		}
		const counts: Record<string, number> = {};
		for (const id of ids.slice(0, 16)) counts[`memory:${id}`] = 2;
		saveUsage(h.dir, { counts, lastSession: {} });
		const usage = await h.run("usage");
		expect(usage.kind).toBe("success");
		expect(usage.text).toContain("… and 1 more");
	}));

	it("names an empty plugin log file explicitly", withDir(async (h) => {
		const { pluginLogFilePath } = await import("../src/logfile.js");
		const logPath = pluginLogFilePath(h.dir);
		mkdirSync(join(logPath, ".."), { recursive: true });
		writeFileSync(logPath, "", "utf8");
		const result = await h.run("log");
		expect(result.kind).toBe("success");
		expect(result.text).toContain("empty plugin log");
	}));

	it("rejects a non-numeric log tail loudly", withDir(async (h) => {
		const result = await h.run("log tail abc");
		expect(result.kind).toBe("error");
		expect(result.text).toContain("positive integer");
	}));

	it("reports resume as a no-op when the agent is already running", withDir(async (h) => {
		const first = await h.run("resume");
		expect(first.kind).toBe("success");
		const second = await h.run("resume");
		expect(second.kind).toBe("success");
		expect(second.text).toContain("already running");
	}));

	it("tolerates non-object kinds in an import file", withDir(async (h) => {
		const payload = {
			version: 1,
			schema: 1,
			entries: { prompt: "not-an-object", memory: {}, skill: {}, subagent: {} },
			refinements: [],
			history: [],
		};
		const path = join(h.dir, "import-bad.json");
		writeFileSync(path, JSON.stringify(payload), "utf8");
		const result = await h.run(`import ${path}`);
		expect(result.kind).toBe("success");
		expect(result.text).toContain("imported local store");
	}));

	it("asks approval before planning into the global store", withDir(async (h) => {
		const result = await h.run("plan global durable rule", "session-cmd", {
			id: "session-cmd",
			options: { provider: "test-provider", model: "test-model" },
		} as never);
		expect(result.kind, result.text).toBe("success");
		expect(result.text).toContain("1 applied");
		expect(Object.keys(h.engine.load("global", undefined).entries.prompt)).toHaveLength(1);
	}, {}, {
		requireGlobalApproval: true,
		userQuestions: { ask: async () => ({ answers: [{ id: "approve-global-evolve", selected: ["批准"] }] }) },
		llm: {
			stream: async function* () {
				const text = JSON.stringify({
					summary: "global prompt",
					rationale: "durable",
					expectedOutcome: "saved",
					edits: [{ action: "create", kind: "prompt", title: "Global rule", content: "Always confirm.", blastRadius: "general", reason: "r" }],
				});
				yield { type: "block-start", index: 0, blockType: "text" };
				yield { type: "text-delta", index: 0, text };
				yield { type: "block-end", index: 0, block: { type: "text", text } };
				yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
				yield { type: "finish", reason: { kind: "stop" } };
			},
		} as never,
	}));
});
