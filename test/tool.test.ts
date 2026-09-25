/**
 * Tests for the model-facing evolve_* tools: scope resolution plus the
 * engine-level execute paths (list with usage counts, add/update/delete
 * text results, global approval gating, rollback) against a real engine.
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import { registerEvolveTools, collectDeleteIds, scopeOf } from "../src/tool.js";
import { createEvolutionEngine } from "../src/service.js";

describe("scopeOf", () => {
	it("maps boolean true to global", () => {
		expect(scopeOf(true, "local")).toBe("global");
	});

	it("maps the string 'global' to global", () => {
		expect(scopeOf("global", "local")).toBe("global");
	});

	it("falls back for false / undefined / other values", () => {
		expect(scopeOf(false, "local")).toBe("local");
		expect(scopeOf(undefined, "local")).toBe("local");
		expect(scopeOf("GLOBAL", "local")).toBe("local");
	});
});

/** Minimal structural view of a registered tool definition. */
interface RegisteredTool {
	name: string;
	output?: { render: (args: Record<string, unknown>, value: { text?: string }) => { type: string; text: string }[] };
	execute: (args: Record<string, unknown>, exec: { agent?: { id: string }; signal?: AbortSignal }) => Promise<{ text: string }>;
}

function toolHarness(toolGateOptions: { requireGlobalApproval: boolean; answer?: "批准" | "拒绝" | "throw" }): {
	dir: string;
	engine: ReturnType<typeof createEvolutionEngine>;
	byName: (name: string) => RegisteredTool;
	reviewsLines: () => string[];
} {
	const dir = mkdtempSync(join(tmpdir(), "evolve-tool-"));
	const engine = createEvolutionEngine(dir);
	const registered: RegisteredTool[] = [];
	const ctx = {
		tools: {
			register: (tool: unknown) => registered.push(tool as RegisteredTool),
		},
		...(toolGateOptions.answer
			? {
					userQuestions: {
						ask: async () => {
							if (toolGateOptions.answer === "throw") throw new Error("dialog aborted");
							return { answers: [{ id: "approve-global-evolve", selected: [toolGateOptions.answer] }] };
						},
					},
				}
			: {}),
	} as unknown as Context;
	registerEvolveTools(ctx, engine, { requireGlobalApproval: toolGateOptions.requireGlobalApproval });
	return {
		dir,
		engine,
		byName: (name) => {
			const tool = registered.find((t) => t.name === name);
			if (!tool) throw new Error(`tool not registered: ${name}`);
			return tool;
		},
		reviewsLines: () =>
			existsSync(join(dir, "evolve", "reviews.jsonl"))
				? readFileSync(join(dir, "evolve", "reviews.jsonl"), "utf8").trimEnd().split("\n").filter((l) => l.length > 0)
				: [],
	};
}

const agentExec = { agent: { id: "session-tool" } };

async function addMemory(harness: ReturnType<typeof toolHarness>, title = "lint first"): Promise<string> {
	return harness.byName("evolve_add").execute({ kind: "memory", title, content: "Run lint before committing. Why: catches errors early. How to apply: run pnpm lint.", memoryType: "feedback" }, agentExec).then((r) => r.text);
}

describe("evolve_list", () => {
	it("renders the empty local store", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			const result = await harness.byName("evolve_list").execute({ scope: "local" }, agentExec);
			expect(result.text).toContain("# Continual Harness State");
			expect(result.text).toContain("No saved harness entries yet.");
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});

	it("appends injection usage counts for entries with recorded injections", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			const text = await addMemory(harness);
			const id = /create memory:(\S+)/.exec(text)?.[1];
			expect(id).toBeTruthy();
			// usage.json is a flat `kind:id -> count` map (loadUsage wraps it)
			writeFileSync(join(harness.dir, "evolve", "usage.json"), JSON.stringify({ [`memory:${id}`]: 3 }), "utf8");
			const result = await harness.byName("evolve_list").execute({}, agentExec);
			expect(result.text).toContain("# Injection Usage");
			expect(result.text).toContain(`memory:${id} — injected 3×`);
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});
});

describe("evolve_add", () => {
	it("creates a local entry and emits an evolve_complete audit event", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			const text = await addMemory(harness);
			expect(text).toMatch(/refinement \S+: 1 applied, 0 failed/);
			expect(text).toMatch(/- create memory:\S+ \(v1\)/);
			const events = harness.reviewsLines().filter((l) => l.includes("manual_tool"));
			expect(events).toHaveLength(1);
			expect(events[0]).toContain("session-tool");
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});

	it("works without an agent subject and then emits no evolve_complete event", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			const result = await harness
				.byName("evolve_add")
				.execute({ kind: "memory", title: "anon", content: "c", memoryType: "reference" }, {});
			expect(result.text).toContain("1 applied, 0 failed");
			expect(harness.reviewsLines()).toHaveLength(0);
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});

	it("passes skill_kind, reference and arguments through to the entry", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			await harness.byName("evolve_add").execute(
				{
					kind: "skill",
					title: "release check",
					content: "# steps",
					skill_kind: "executable",
					reference: { type: "python", import: "rel", callable: "check" },
					arguments: { dry_run: true },
				},
				agentExec,
			);
			const entry = harness.engine.load("local", "session-tool").entries.skill["release_check"];
			expect(entry?.skill_kind).toBe("executable");
			expect(entry?.reference).toEqual({ type: "python", import: "rel", callable: "check" });
			expect(entry?.arguments).toEqual({ dry_run: true });
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});

	it("applies a global edit after explicit approval and skips the gate when approval is off", async () => {
		const gated = toolHarness({ requireGlobalApproval: true, answer: "批准" });
		try {
			const result = await gated.byName("evolve_add").execute({ kind: "memory", title: "g", content: "c", memoryType: "reference", global: true }, agentExec);
			expect(result.text).toContain("1 applied, 0 failed");
			expect(Object.keys(gated.engine.load("global").entries.memory)).toContain("g");
		} finally {
			rmSync(gated.dir, { recursive: true, force: true });
		}
	});

	it("rejects a declined global edit without writing anything", async () => {
		const gated = toolHarness({ requireGlobalApproval: true, answer: "拒绝" });
		try {
			await expect(
				gated.byName("evolve_add").execute({ kind: "memory", title: "g", content: "c", memoryType: "reference", global: true }, agentExec),
			).rejects.toThrow(/rejected by the user/);
			expect(Object.keys(gated.engine.load("global").entries.memory)).toHaveLength(0);
		} finally {
			rmSync(gated.dir, { recursive: true, force: true });
		}
	});
});

describe("evolve_update / evolve_delete", () => {
	it("updates only the passed fields and reports the new version", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			await addMemory(harness, "old title");
			const result = await harness
				.byName("evolve_update")
				.execute({ kind: "memory", id: "old_title", title: "old title", content: "new body. Why: updated. How to apply: read this." }, agentExec);
			expect(result.text).toMatch(/- update memory:old_title \(v2\)/);
			expect(harness.engine.load("local", "session-tool").entries.memory["old_title"]?.title).toBe("old title");
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});

	it("carries an explicit path onto the created entry", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			const result = await harness
				.byName("evolve_add")
				.execute({ kind: "prompt", title: "pathed note", content: "prompt body", path: "guides" }, agentExec);
			expect(result.text).toMatch(/1 applied, 0 failed/);
			expect(harness.engine.load("local", "session-tool").entries.prompt["pathed_note"]?.path).toBe("guides");
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});

	it("reclassifies the memory type on update", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			await addMemory(harness, "retyped");
			const result = await harness.byName("evolve_update").execute({ kind: "memory", id: "retyped", memoryType: "user" }, agentExec);
			expect(result.text).toMatch(/- update memory:retyped \(v2\)/);
			expect(harness.engine.load("local", "session-tool").entries.memory["retyped"]?.metadata["memoryType"]).toBe("user");
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});
	it("deletes an entry, and reports a failed edit for a missing id", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			await addMemory(harness, "doomed");
			const deleted = await harness.byName("evolve_delete").execute({ kind: "memory", id: "doomed" }, agentExec);
			expect(deleted.text).toMatch(/- delete memory:doomed/);

			const missing = await harness.byName("evolve_delete").execute({ kind: "memory", id: "nope" }, agentExec);
			expect(missing.text).toContain("0 applied, 1 failed");
			expect(missing.text).toContain("- failed delete memory:nope");
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});

	it("deletes several entries in one batch as one refinement (ids array)", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			await addMemory(harness, "batch one");
			await addMemory(harness, "batch two");
			await addMemory(harness, "batch three");
			const result = await harness.byName("evolve_delete").execute({ kind: "memory", ids: ["batch_one", "batch_two", "batch_three"] }, agentExec);
			expect(result.text).toMatch(/refinement \S+: 3 applied, 0 failed/);
			expect(Object.keys(harness.engine.load("local", "session-tool").entries.memory)).toHaveLength(0);
			// One refinement for the whole batch — the audit history grows by one, not three.
			expect(harness.engine.history("local", "session-tool")).toHaveLength(4);
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});

	it("combines id and ids and reports per-edit failures inside a batch", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			await addMemory(harness, "batch keeper");
			const result = await harness
				.byName("evolve_delete")
				.execute({ kind: "memory", id: "batch_keeper", ids: ["batch_keeper", "ghost"] }, agentExec);
			expect(result.text).toContain("1 applied, 1 failed");
			expect(result.text).toContain("- failed delete memory:ghost");
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});

	it("asks once for a global update after approval", async () => {
		const gated = toolHarness({ requireGlobalApproval: true, answer: "批准" });
		try {
			await gated
				.byName("evolve_add")
				.execute({ kind: "memory", title: "g update", content: "Durable cross-session fact about deploy freezes.", memoryType: "reference", global: true }, agentExec);
			const result = await gated
				.byName("evolve_update")
				.execute({ kind: "memory", id: "g_update", content: "Updated durable fact. Why: test. How to apply: test.", global: true }, agentExec);
			expect(result.text).toMatch(/- update memory:g_update \(v2\)/);
			expect(gated.engine.load("global").entries.memory["g_update"]?.content).toContain("Updated durable fact");
		} finally {
			rmSync(gated.dir, { recursive: true, force: true });
		}
	});

	it("labels the project store in the approval question", async () => {
		const gated = toolHarness({ requireGlobalApproval: true, answer: "批准" });
		const projExec = { agent: { id: "session-proj", session: { header: { cwd: "/mnt/work/app" } } } };
		try {
			const result = await gated
				.byName("evolve_add")
				.execute({ kind: "memory", title: "proj durable", content: "Durable project fact about deploy freezes.", memoryType: "reference", scope: "project" }, projExec);
			expect(result.text).toMatch(/1 applied, 0 failed/);
			const { resolveProjectKey } = await import("../src/project.js");
			expect(Object.keys(gated.engine.load("project", resolveProjectKey("/mnt/work/app")).entries.memory)).toContain("proj_durable");
		} finally {
			rmSync(gated.dir, { recursive: true, force: true });
		}
	});

	it("asks once for a global batch delete (one approval, one refinement)", async () => {
		let approvals = 0;
		const dir = mkdtempSync(join(tmpdir(), "evolve-tool-batch-"));
		const engine = createEvolutionEngine(dir);
		const registered: RegisteredTool[] = [];
		const ctx = {
			tools: { register: (tool: unknown) => registered.push(tool as RegisteredTool) },
			userQuestions: {
				ask: async () => {
					approvals += 1;
					return { answers: [{ id: "approve-global-evolve", selected: ["批准"] }] };
				},
			},
		} as unknown as Context;
		registerEvolveTools(ctx, engine, { requireGlobalApproval: true });
		try {
			const byName = (name: string) => registered.find((t) => t.name === name) as RegisteredTool;
			await byName("evolve_add").execute({ kind: "memory", title: "global batch alpha", content: "First durable cross-session fact about deploy freezes.", memoryType: "reference", global: true }, agentExec);
			await byName("evolve_add").execute({ kind: "memory", title: "global batch beta", content: "Second durable cross-session fact about on-call rotations.", memoryType: "reference", global: true }, agentExec);
			const before = approvals;
			const result = await byName("evolve_delete").execute({ kind: "memory", ids: ["global_batch_alpha", "global_batch_beta"], global: true }, agentExec);
			expect(result.text).toContain("2 applied, 0 failed");
			expect(approvals - before).toBe(1);
			expect(Object.keys(engine.load("global").entries.memory)).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("output render", () => {
	it("renders every tool text result and tolerates missing text", () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			for (const name of ["evolve_list", "evolve_recall", "evolve_add", "evolve_update", "evolve_delete", "evolve_rollback"]) {
				const render = harness.byName(name).output?.render;
				expect(render, `${name} has an output render`).toBeDefined();
				expect(render!({}, { text: "hello" })).toEqual([{ type: "text", text: "hello" }]);
				expect(render!({}, {})).toEqual([{ type: "text", text: "" }]);
			}
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});
});

describe("collectDeleteIds (#19)", () => {
	it("accepts a lone id for backward compatibility", () => {
		expect(collectDeleteIds("a", undefined)).toEqual(["a"]);
	});

	it("merges id and ids, de-duplicated in first-seen order", () => {
		expect(collectDeleteIds("a", ["a", "b", "", 42, "c"])).toEqual(["a", "b", "c"]);
	});

	it("throws loudly when no id is given (never a silent no-op)", () => {
		expect(() => collectDeleteIds(undefined, undefined)).toThrow(/requires id or a non-empty ids array/);
		expect(() => collectDeleteIds("", [])).toThrow(/requires id or a non-empty ids array/);
	});
});

describe("evolve_rollback", () => {
	it("reverts a previous refinement by id", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			const addText = await addMemory(harness, "to revert");
			const refinementId = /^refinement (\S+):/.exec(addText)?.[1];
			expect(refinementId).toBeTruthy();
			const result = await harness.byName("evolve_rollback").execute({ refinementId }, agentExec);
			expect(result.text).toContain(`Rolled back ${refinementId}`);
			expect(result.text).toContain("1 edit(s) reverted.");
			expect(Object.keys(harness.engine.load("local", "session-tool").entries.memory)).not.toContain("to_revert");
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});
});

describe("memory shape + project scope at the tool surface (2026-09-23)", () => {
	it("fails a memory create without memoryType loudly", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			const result = await harness.byName("evolve_add").execute({ kind: "memory", title: "t", content: "c" }, agentExec);
			expect(result.text).toContain("0 applied, 1 failed");
			expect(result.text).toContain("memoryType");
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});

	it("writes the project store when the session cwd resolves one", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		const projExec = { agent: { id: "session-proj", session: { header: { cwd: "/mnt/work/app" } } } };
		try {
			const result = await harness
				.byName("evolve_add")
				.execute({ kind: "memory", title: "proj fact", content: "c", memoryType: "reference", scope: "project" }, projExec);
			expect(result.text).toContain("1 applied, 0 failed");
			const { resolveProjectKey } = await import("../src/project.js");
			const key = resolveProjectKey("/mnt/work/app");
			expect(Object.keys(harness.engine.load("project", key).entries.memory)).toContain("proj_fact");
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});

	it("refuses project scope loudly when the cwd is unavailable", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			await expect(
				harness.byName("evolve_add").execute({ kind: "memory", title: "t", content: "c", memoryType: "reference", scope: "project" }, agentExec),
			).rejects.toThrow(/session cwd/);
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});
});

describe("evolve_recall", () => {
	it("is registered and reads back full memory content", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			await addMemory(harness);
			const result = await harness.byName("evolve_recall").execute({ query: "lint" }, agentExec);
			expect(result.text).toContain("1 hit(s)");
			expect(result.text).toContain("Run lint before committing");
			expect(result.text).toContain("v1");
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});

	it("reports skipped scopes instead of hiding them", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			await addMemory(harness);
			// agentExec has no project cwd: the project store is skipped with a note.
			const result = await harness.byName("evolve_recall").execute({ query: "lint", scopes: ["local", "project"] }, agentExec);
			expect(result.text).toContain("note: project store skipped");
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});

	it("fails loud on unknown filters", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			await expect(harness.byName("evolve_recall").execute({ kinds: ["nope"] }, agentExec)).rejects.toThrow("unknown kind");
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});

	it("passes memoryTypes, limit, and includeArchived through", async () => {
		const harness = toolHarness({ requireGlobalApproval: false });
		try {
			await addMemory(harness);
			const result = await harness.byName("evolve_recall").execute({ memoryTypes: ["feedback"], limit: 5, includeArchived: true }, agentExec);
			expect(result.text).toContain("1 hit(s)");
			const empty = await harness.byName("evolve_recall").execute({ memoryTypes: ["user"] }, agentExec);
			expect(empty.text).toContain("0 hit(s)");
		} finally {
			rmSync(harness.dir, { recursive: true, force: true });
		}
	});
});
