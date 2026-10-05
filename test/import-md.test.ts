import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importWorkspaceMd } from "../src/import-md.js";
import { slugifyId } from "../src/memory-rules.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

let workspace = "";
let store: MemoryStore;

beforeEach(async () => {
	workspace = mkdtempSync(join(tmpdir(), "evolve-import-"));
	store = await openMemoryStore(join(mkdtempSync(join(tmpdir(), "evolve-import-db-")), "memory.db"));
});

afterEach(() => {
	store.close();
});

function memoryDir(): string {
	return join(workspace, ".evolve", "memory");
}

function writeMemory(file: string, content: string): void {
	mkdirSync(memoryDir(), { recursive: true });
	writeFileSync(join(memoryDir(), file), content, "utf8");
}

describe("importWorkspaceMd", () => {
	it("imports records losslessly and renames the directory aside", () => {
		writeMemory(
			"fedorа-env.md".replace("а", "a"),
			["---", "name: fedora-env", "description: 用户在 Fedora 工作", "metadata:", "  type: user", "---", "", "日常跑 dotnet-desktop。"].join("\n"),
		);
		writeMemory(
			"no-mock-db.md",
			["---", "name: no-mock-db", "description: 别 mock 数据库", "metadata:", "  type: feedback", "---", "", "规则：别 mock。", "**Why:** 线上挂过。", "**How to apply:** 集成测试。"].join("\n"),
		);
		writeMemory("MEMORY.md", "# 记忆索引\n");

		const result = importWorkspaceMd(store, workspace);
		expect(result.imported).toBe(2);
		expect(result.skipped).toBe(0);
		expect(result.errors).toEqual([]);
		expect(result.archiveDir).toMatch(/memory-imported-\d{4}-\d{2}-\d{2}$/);

		const imported = store.list(workspace);
		expect(imported.map((r) => r.id).sort()).toEqual(["fedora-env", "no-mock-db"]);
		expect(imported.find((r) => r.id === "fedora-env")?.type).toBe("user");
		expect(imported.find((r) => r.id === "no-mock-db")?.body).toContain("**Why:** 线上挂过。");
		// The index file is not imported as a memory.
		expect(store.get(workspace, "memory")).toBeUndefined();
		// Original bytes survive in the renamed directory.
		expect(readFileSync(join(result.archiveDir!, "no-mock-db.md"), "utf8")).toContain("别 mock 数据库");
	});

	it("is idempotent via the state flag", () => {
		writeMemory("a.md", ["---", "name: a", "description: d", "type: reference", "---", "", "b"].join("\n"));
		expect(importWorkspaceMd(store, workspace).imported).toBe(1);
		// Even with the directory back (failed rename), the flag short-circuits.
		writeMemory("a.md", ["---", "name: a", "description: d", "type: reference", "---", "", "b"].join("\n"));
		expect(importWorkspaceMd(store, workspace).imported).toBe(0);
		expect(store.list(workspace)).toHaveLength(1);
	});

	it("does not double-import over an existing record (crash after apply, flag unset)", () => {
		store.applyProposals({ workspaceId: workspace, trigger: "explicit" }, [
			{ action: "create", id: "a", type: "reference", title: "a", description: "d", body: "b" },
		]);
		writeMemory("a.md", ["---", "name: a", "description: d", "type: reference", "---", "", "b"].join("\n"));
		expect(importWorkspaceMd(store, workspace).imported).toBe(0);
		expect(store.list(workspace)).toHaveLength(1);
	});

	it("does nothing for a workspace without an MD store", () => {
		const result = importWorkspaceMd(store, workspace);
		expect(result.imported).toBe(0);
		expect(result.archiveDir).toBeNull();
		expect(store.state(workspace, "md-imported")).toBeDefined();
	});

	it("treats a non-directory .evolve/memory as absent", () => {
		mkdirSync(join(workspace, ".evolve"), { recursive: true });
		writeFileSync(join(workspace, ".evolve", "memory"), "not a directory", "utf8");
		const result = importWorkspaceMd(store, workspace);
		expect(result.imported).toBe(0);
		expect(result.archiveDir).toBeNull();
		expect(store.state(workspace, "md-imported")).toBeDefined();
	});

	it("picks an unused archive name when today's name is taken", () => {
		mkdirSync(memoryDir(), { recursive: true });
		writeFileSync(join(memoryDir(), "a.md"), ["---", "name: a", "description: d", "type: reference", "---", "", "b"].join("\n"));
		const taken = join(workspace, ".evolve", `memory-imported-${new Date().toISOString().slice(0, 10)}`);
		writeFileSync(taken, "a stale file occupying the name", "utf8");
		const result = importWorkspaceMd(store, workspace);
		expect(result.imported).toBe(1);
		expect(result.archiveDir).toBe(`${taken}-2`);
	});

	it("synthesizes missing frontmatter instead of dropping the file", () => {
		writeMemory("bare note.md", "# 裸记忆\n\n没有 frontmatter 的正文。\n");
		writeMemory("中文标识.md", ["---", "name: 中文标识", "description: d", "type: 非法类型", "---", "", "body text"].join("\n"));
		const result = importWorkspaceMd(store, workspace);
		expect(result.imported).toBe(2);
		const imported = store.list(workspace);
		// Unknown type maps to reference; missing description synthesized from
		// the first heading line.
		expect(imported.find((r) => r.type === "reference")?.id).toBe(slugifyId("中文标识"));
		expect(imported.find((r) => r.id === "bare-note")?.description).toBe("裸记忆");
	});

	it("skips files a hard gate rejects and reports why", () => {
		writeMemory("leak.md", ["---", "name: leak", "description: d", "type: reference", "---", "", "token ghp_0123456789abcdefghijklmnopqrstuv"].join("\n"));
		const result = importWorkspaceMd(store, workspace);
		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(1);
		expect(result.errors[0]).toContain("leak.md");
		// The file still exists in the archive for manual salvage.
		expect(readFileSync(join(result.archiveDir!, "leak.md"), "utf8")).toContain("ghp_");
	});
});
