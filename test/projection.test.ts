/**
 * Tests for the readable Markdown projection: index + per-fact files with
 * frontmatter, updates, archive flags, delete sweeps, and the engine hook
 * (projection appears only when a memory edit lands, rollback included).
 */
import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createEvolutionEngine } from "../src/service.js";
import { hasMemoryProjection, materializeMemoryProjection, memoryFactFilename, readMemoryFact } from "../src/projection.js";
import { emptyHarnessState, MEMORY_TYPE_KEY } from "../src/types.js";
import { storePaths } from "../src/store.js";

function userMemory(title: string, content: string) {
	return { action: "create" as const, kind: "memory" as const, title, content, metadata: { [MEMORY_TYPE_KEY]: "user" } };
}

describe("materializeMemoryProjection", () => {
	it("writes an index and one frontmatter fact file per entry", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-proj-"));
		try {
			const engine = createEvolutionEngine(dir);
			const result = engine.apply("global", undefined, {
				summary: "seed",
				rationale: "test",
				expectedOutcome: "test",
				edits: [userMemory("dark theme", "user prefers dark theme")],
			}, { scope: "global" });
			const id = result.appliedEdits.find((e) => e.applied)?.id ?? "";
			const stateDir = join(dir, "evolve", "global");
			expect(hasMemoryProjection(stateDir)).toBe(true);
			const index = readFileSync(join(stateDir, "MEMORY.md"), "utf8");
			expect(index).toContain("dark theme");
			expect(index).toContain(`global:${id}`);
			const fact = readMemoryFact(join(stateDir, "memory"), memoryFactFilename(id));
			expect(fact).toContain("memoryType: user");
			expect(fact).toContain("user prefers dark theme");
			expect(fact).toContain(`version: 1`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("updates facts, flags archives, and sweeps deleted ids", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-proj-"));
		try {
			const engine = createEvolutionEngine(dir);
			const created = engine.apply("local", "s", {
				summary: "seed",
				rationale: "test",
				expectedOutcome: "test",
				edits: [userMemory("alpha one", "first fact"), userMemory("beta two", "second fact")],
			}, { scope: "local" });
			const ids = created.appliedEdits.filter((e) => e.applied).map((e) => e.id);
			const stateDir = join(dir, "evolve", "local", "s");
			// Archive the first entry: its file stays, flagged.
			const first = engine.load("local", "s").entries.memory[ids[0]!]!;
			engine.apply("local", "s", {
				summary: "archive",
				rationale: "test",
				expectedOutcome: "test",
				edits: [{ action: "update", kind: "memory", id: ids[0], title: first.title, content: first.content, metadata: { ...first.metadata, archivedAt: new Date().toISOString() } }],
			}, { scope: "local" });
			expect(readMemoryFact(join(stateDir, "memory"), memoryFactFilename(ids[0]!))).toContain("archived: true");
			expect(readFileSync(join(stateDir, "MEMORY.md"), "utf8")).toContain("archived");
			// Delete the second entry: its file is swept.
			engine.apply("local", "s", {
				summary: "delete",
				rationale: "test",
				expectedOutcome: "test",
				edits: [{ action: "delete", kind: "memory", id: ids[1] }],
			}, { scope: "local" });
			expect(existsSync(join(stateDir, "memory", memoryFactFilename(ids[1]!)))).toBe(false);
			expect(readFileSync(join(stateDir, "MEMORY.md"), "utf8")).not.toContain("beta two");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not project when no memory edit lands", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-proj-"));
		try {
			const engine = createEvolutionEngine(dir);
			engine.apply("global", undefined, {
				summary: "seed",
				rationale: "test",
				expectedOutcome: "test",
				edits: [{ action: "create", kind: "prompt", title: "note one", content: "prompt body" }],
			}, { scope: "global" });
			expect(hasMemoryProjection(join(dir, "evolve", "global"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("re-materializes rollback state through the same apply path", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-proj-"));
		try {
			const engine = createEvolutionEngine(dir);
			const created = engine.apply("local", "s", {
				summary: "seed",
				rationale: "test",
				expectedOutcome: "test",
				edits: [userMemory("gamma three", "third fact")],
			}, { scope: "local" });
			const stateDir = join(dir, "evolve", "local", "s");
			expect(readFileSync(join(stateDir, "MEMORY.md"), "utf8")).toContain("gamma three");
			engine.rollback("local", "s", created.id);
			expect(readFileSync(join(stateDir, "MEMORY.md"), "utf8")).not.toContain("gamma three");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("maps colon ids to safe filenames and round-trips content", () => {
		expect(memoryFactFilename("local:legacy_fact")).toBe("local_legacy_fact.md");
		const dir = mkdtempSync(join(tmpdir(), "evolve-proj-"));
		try {
			const state = emptyHarnessState();
			const paths = storePaths(dir, "global", undefined);
			materializeMemoryProjection(paths.stateDir, state);
			expect(hasMemoryProjection(paths.stateDir)).toBe(true);
			expect(readFileSync(join(paths.stateDir, "MEMORY.md"), "utf8")).toContain("(no memory entries yet)");
			// A stray file from an older layout is swept on the next run.
			writeFileSync(join(paths.stateDir, "memory", "stray.md"), "stale", "utf8");
			materializeMemoryProjection(paths.stateDir, state);
			expect(existsSync(join(paths.stateDir, "memory", "stray.md"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("suffixes fact filenames when colon-mapping collides", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-proj-"));
		try {
			const state = emptyHarnessState();
			const now = new Date().toISOString();
			for (const id of ["a:b", "a_b"]) {
				state.entries.memory[id] = {
					id, kind: "memory", title: `fact ${id}`, content: `body ${id}`,
					path: "", scope: "global", reference: {}, arguments: {},
					metadata: { [MEMORY_TYPE_KEY]: "user" },
					source: "evolve", created_at: now, updated_at: now, version: 1,
				};
			}
			const paths = storePaths(dir, "global", undefined);
			materializeMemoryProjection(paths.stateDir, state);
			// Both map to a_b.md — the second takes the ~2 suffix.
			expect(existsSync(join(paths.stateDir, "memory", "a_b.md"))).toBe(true);
			expect(existsSync(join(paths.stateDir, "memory", "a_b~2.md"))).toBe(true);
			const index = readFileSync(join(paths.stateDir, "MEMORY.md"), "utf8");
			expect(index).toContain("memory/a_b.md");
			expect(index).toContain("memory/a_b~2.md");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("swallows an unsweepable stale entry (EISDIR) without breaking apply", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-proj-"));
		try {
			const state = emptyHarnessState();
			const paths = storePaths(dir, "global", undefined);
			materializeMemoryProjection(paths.stateDir, state);
			// A stale *directory* ending in .md lists in the sweep but
			// unlinkSync fails on it (EISDIR) — the catch must swallow it.
			mkdirSync(join(paths.stateDir, "memory", "stale.md"));
			materializeMemoryProjection(paths.stateDir, state);
			expect(existsSync(join(paths.stateDir, "memory", "stale.md"))).toBe(true);
			expect(existsSync(join(paths.stateDir, "MEMORY.md"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("treats an unreadable facts dir as empty (EACCES) and still writes the index", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolve-proj-"));
		try {
			const state = emptyHarnessState();
			const paths = storePaths(dir, "global", undefined);
			materializeMemoryProjection(paths.stateDir, state);
			// mkdirSync(recursive) tolerates the existing dir; readdirSync
			// then throws EACCES — the catch falls back to existing=[].
			chmodSync(join(paths.stateDir, "memory"), 0o000);
			try {
				materializeMemoryProjection(paths.stateDir, state);
			} finally {
				chmodSync(join(paths.stateDir, "memory"), 0o755);
			}
			expect(readFileSync(join(paths.stateDir, "MEMORY.md"), "utf8")).toContain("(no memory entries yet)");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
