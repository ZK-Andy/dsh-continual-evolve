/**
 * Tests for the `/evolve mount` / `/evolve unmount` subcommand handlers
 * (mount-command.ts): lookup across local/global stores, ledger listing,
 * error surfaces, and angle-bracket id tolerance.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createEvolutionEngine } from "../src/service.js";
import { executeMountCommand, executeUnmountCommand } from "../src/mount-command.js";

function tmpBase(): string {
	const base = join(process.cwd(), "test/.tmp");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "/"));
}

function agentOf(id: string): Agent {
	return { id, options: {} } as unknown as Agent;
}

function invocationOf(agent: Agent) {
	return { agent, signal: undefined } as never;
}

describe("executeMountCommand", () => {
	it("lists an empty ledger", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const result = await executeMountCommand({ get: () => undefined } as never, engine, invocationOf(agentOf("session-x")), ["list"]);
			expect(result.kind).toBe("success");
			expect(result.text).toBe("(no hot-mounted plugins — /evolve mount <skillId>)");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("lists mounted plugins from the ledger", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			engine.apply("local", "session-x", {
				summary: "create a skill",
				rationale: "test",
				expectedOutcome: "skill exists",
				edits: [{ action: "create", kind: "skill", id: "code_reviewer", title: "Code reviewer", content: "x", reference: { type: "python", import: "m", callable: "r" }, arguments: {} }],
			});
			const first = await executeMountCommand({ get: () => undefined } as never, engine, invocationOf(agentOf("session-x")), ["code_reviewer"]);
			expect(first.kind).toBe("success");
			const result = await executeMountCommand({ get: () => undefined } as never, engine, invocationOf(agentOf("session-x")), ["list"]);
			expect(result.kind).toBe("success");
			expect(result.text).toContain("code_reviewer");
			expect(result.text).toContain("v1");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("rejects a missing skill id with usage", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const result = await executeMountCommand({ get: () => undefined } as never, engine, invocationOf(agentOf("session-x")), []);
			expect(result.kind).toBe("error");
			expect(result.text).toContain("mount requires a skill entry id");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("reports a skill id that exists in neither store", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const result = await executeMountCommand({ get: () => undefined } as never, engine, invocationOf(agentOf("session-x")), ["ghost"]);
			expect(result.kind).toBe("error");
			expect(result.text).toContain("skill entry ghost not found");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("finds a local skill entry across kinds and mounts it", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			engine.apply("local", "session-x", {
				summary: "create a skill",
				rationale: "test",
				expectedOutcome: "skill exists",
				edits: [{ action: "create", kind: "skill", id: "linter", title: "Linter", content: "x", reference: { type: "python", import: "m", callable: "r" }, arguments: {} }],
			});
			const result = await executeMountCommand({ get: () => undefined } as never, engine, invocationOf(agentOf("session-x")), ["linter"]);
			expect(result.kind).toBe("success");
			expect(result.text).toContain("mounted linter as evolve-mount-linter (v1)");
			expect(result.text).toContain("skill_linter");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("finds a global skill entry", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			engine.apply("global", undefined, {
				summary: "create a global skill",
				rationale: "test",
				expectedOutcome: "skill exists",
				edits: [{ action: "create", kind: "skill", id: "global_tool", title: "Global tool", content: "x", reference: { type: "python", import: "m", callable: "r" }, arguments: {} }],
			});
			const result = await executeMountCommand({ get: () => undefined } as never, engine, invocationOf(agentOf("session-x")), ["global_tool"]);
			expect(result.kind).toBe("success");
			expect(result.text).toContain("mounted global_tool");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("tolerates angle-bracket pasted ids", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			engine.apply("local", "session-x", {
				summary: "create a skill",
				rationale: "test",
				expectedOutcome: "skill exists",
				edits: [{ action: "create", kind: "skill", id: "demo", title: "Demo", content: "x", reference: { type: "python", import: "m", callable: "r" }, arguments: {} }],
			});
			const result = await executeMountCommand({ get: () => undefined } as never, engine, invocationOf(agentOf("session-x")), ["<demo>"]);
			expect(result.kind).toBe("success");
			expect(result.text).toContain("mounted demo");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("surfaces mount failures (guidance skills cannot mount)", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			engine.apply("local", "session-x", {
				summary: "create a guidance skill",
				rationale: "test",
				expectedOutcome: "skill exists",
				edits: [{ action: "create", kind: "skill", id: "guide", title: "Guide", content: "x", skill_kind: "guidance", reference: {}, arguments: {} }],
			});
			const result = await executeMountCommand({ get: () => undefined } as never, engine, invocationOf(agentOf("session-x")), ["guide"]);
			expect(result.kind).toBe("error");
			expect(result.text).toMatch(/guidance skills cannot be mounted/);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("executeUnmountCommand", () => {
	it("requires a mount id", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const result = await executeUnmountCommand({ get: () => undefined } as never, engine, []);
			expect(result.kind).toBe("error");
			expect(result.text).toContain("unmount requires a mount id");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("reports an unknown mount id", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const result = await executeUnmountCommand({ get: () => undefined } as never, engine, ["ghost"]);
			expect(result.kind).toBe("error");
			expect(result.text).toBe("no mount found for ghost");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("unmounts a previously mounted plugin", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			engine.apply("local", "session-x", {
				summary: "create a skill",
				rationale: "test",
				expectedOutcome: "skill exists",
				edits: [{ action: "create", kind: "skill", id: "temp_tool", title: "Temp tool", content: "x", reference: { type: "python", import: "m", callable: "r" }, arguments: {} }],
			});
			const mounted = await executeMountCommand({ get: () => undefined } as never, engine, invocationOf(agentOf("session-x")), ["temp_tool"]);
			expect(mounted.kind).toBe("success");
			const result = await executeUnmountCommand({ get: () => undefined } as never, engine, ["temp_tool"]);
			expect(result.kind).toBe("success");
			expect(result.text).toContain("unmounted temp_tool");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("tolerates angle brackets on unmount ids", async () => {
		const base = tmpBase();
		try {
			const engine = createEvolutionEngine(base);
			const result = await executeUnmountCommand({ get: () => undefined } as never, engine, ["<ghost>"]);
			expect(result.kind).toBe("error");
			expect(result.text).toBe("no mount found for ghost");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});