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
import { registerEvolveTools, scopeOf } from "../src/tool.js";
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
	return harness.byName("evolve_add").execute({ kind: "memory", title, content: "run lint before committing" }, agentExec).then((r) => r.text);
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
				.execute({ kind: "memory", title: "anon", content: "c" }, {});
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
			const result = await gated.byName("evolve_add").execute({ kind: "memory", title: "g", content: "c", global: true }, agentExec);
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
				gated.byName("evolve_add").execute({ kind: "memory", title: "g", content: "c", global: true }, agentExec),
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
				.execute({ kind: "memory", id: "old_title", title: "old title", content: "new body" }, agentExec);
			expect(result.text).toMatch(/- update memory:old_title \(v2\)/);
			expect(harness.engine.load("local", "session-tool").entries.memory["old_title"]?.title).toBe("old title");
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
