import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSkillTools } from "../src/skill-tools.js";
import type { ToolDefinition } from "../src/memory-tools.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

let store: MemoryStore;
let tools: Map<string, ToolDefinition>;
let workspace = "";
let savedDshHome: string | undefined;

beforeEach(async () => {
	store = await openMemoryStore(join(mkdtempSync(join(tmpdir(), "evolve-skill-tools-db-")), "memory.db"));
	workspace = mkdtempSync(join(tmpdir(), "evolve-skill-tools-ws-"));
	savedDshHome = process.env.DSH_HOME;
	process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "evolve-skill-tools-home-"));
	tools = new Map();
	registerSkillTools(
		{
			register(definition: unknown) {
				const tool = definition as ToolDefinition;
				tools.set(tool.name, tool);
				return () => tools.delete(tool.name);
			},
		},
		store,
	);
});

afterEach(() => {
	if (savedDshHome === undefined) {
		delete process.env.DSH_HOME;
	} else {
		process.env.DSH_HOME = savedDshHome;
	}
	store.close();
});

function agentExec(): { agent: unknown } {
	return { agent: { id: "sess-1", session: { header: { cwd: workspace } } } };
}

async function run(name: string, args: Record<string, unknown>, context: { agent: unknown } = agentExec()): Promise<string> {
	const tool = tools.get(name)!;
	const value = await tool.execute(args, context as never);
	expect(tool.output.render(args, { text: value.text })).toEqual([{ type: "text", text: value.text }]);
	return value.text;
}

const FIELDS = { title: "Deploy checklist", description: "pre-release steps", body: "1. build\n2. verify" };

describe("registration shape", () => {
	it("registers exactly the two skill tools with API-safe schemas", () => {
		expect([...tools.keys()].sort()).toEqual(["skill_read", "skill_write"]);
		for (const tool of tools.values()) {
			expect(tool.parameters.type).toBe("object");
			expect(tool.parameters.additionalProperties).toBe(false);
			expect(tool.output.schema).toBeDefined();
			expect(typeof tool.output.render).toBe("function");
		}
		expect(tools.get("skill_write")?.parameters.required).toEqual(["action"]);
		expect(tools.get("skill_read")?.parameters.required).toBeUndefined();
	});

	it("returns a disposer that can remove the tools", () => {
		let registered = 0;
		let disposed = 0;
		const remove = registerSkillTools(
			{
				register() {
					registered += 1;
					return () => {
						disposed += 1;
					};
				},
			},
			store,
		);
		expect(registered).toBe(2);
		remove();
		expect(disposed).toBe(2);
	});
});

describe("skill_write", () => {
	it("creates in the project and reports the id", async () => {
		const text = await run("skill_write", { action: "create", id: "deploy", ...FIELDS });
		expect(text).toContain("已写入技能 `deploy`");
		expect(store.getSkill(workspace, "deploy")?.title).toBe(FIELDS.title);
	});

	it("refuses without a workspace and surfaces gate reasons", async () => {
		expect(await run("skill_write", { action: "create", id: "x", ...FIELDS }, { agent: {} })).toMatch("没有可用的工作区路径");
		expect(await run("skill_write", { action: "create", id: "deploy", ...FIELDS, body: "key ghp_12345678901234567890" })).toMatch("写入被门禁拒绝");
	});

	it("updates, deletes, and moves to global with distinct confirmations", async () => {
		await run("skill_write", { action: "create", id: "deploy", ...FIELDS });
		expect(await run("skill_write", { action: "update", id: "deploy", body: "v2 body" })).toContain("已更新技能 `deploy`");
		expect(await run("skill_write", { action: "move-to-global", id: "deploy" })).toContain("手动搬到全局");
		expect(store.getSkill("", "deploy")?.body).toBe("v2 body");
		expect(await run("skill_write", { action: "delete", id: "deploy", scope: "global" })).toContain("已删除技能 `deploy`");
		expect(store.getSkill("", "deploy")).toBeUndefined();
	});
});

describe("skill_read", () => {
	it("reads by id from the project first, then global", async () => {
		await run("skill_write", { action: "create", id: "deploy", ...FIELDS });
		const project = await run("skill_read", { id: "deploy" });
		expect(project).toContain("Deploy checklist");
		expect(project).toContain("本项目");
		await run("skill_write", { action: "move-to-global", id: "deploy" });
		const global = await run("skill_read", { id: "deploy" });
		expect(global).toContain("Deploy checklist");
		expect(global).toContain("全局");
	});

	it("searches and lists across both scopes", async () => {
		await run("skill_write", { action: "create", id: "deploy", ...FIELDS });
		await run("skill_write", { action: "create", id: "other", title: "Other", description: "other steps", body: "other body here" });
		await run("skill_write", { action: "move-to-global", id: "other" });
		expect(await run("skill_read", { query: "pre-release" })).toContain("Deploy checklist");
		const list = await run("skill_read", {});
		expect(list).toContain("Deploy checklist");
		expect(list).toContain("全局");
		expect(await run("skill_read", { id: "ghost" })).toMatch("没有找到");
		expect(await run("skill_read", { query: "nothing-here-zzz" })).toMatch("没有匹配");
	});

	it("clamps limits and survives agents without a session id", async () => {
		await run("skill_write", { action: "create", id: "deploy", ...FIELDS });
		expect(await run("skill_read", { query: "pre-release", limit: 100 })).toContain("Deploy checklist");
		expect(await run("skill_read", { query: "pre-release", limit: "many" })).toContain("Deploy checklist");
		const noId = { agent: { session: { header: { cwd: workspace } } } };
		expect(await run("skill_write", { action: "create", id: "plain", ...FIELDS, body: "plain body" }, noId)).toContain("已写入技能 `plain`");
		expect(await run("skill_read", {}, { agent: {} })).toMatch("没有可用的工作区路径");
	});

	it("renders an empty result when the tool returns no text", async () => {
		const tool = tools.get("skill_read")!;
		expect(tool.output.render({}, {})).toEqual([{ type: "text", text: "" }]);
	});

	it("resolves legacy same-id rows with project shadowing global", async () => {
		const raw = new DatabaseSync(store.path);
		try {
			for (const partition of [workspace, ""]) {
				raw.prepare(
					"INSERT INTO skills (workspace_id, id, title, description, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
				).run(partition, "legacy", partition === "" ? "Global legacy" : "Project legacy", "legacy hook", "legacy body", "2026-10-11T00:00:00.000Z", "2026-10-11T00:00:00.000Z");
			}
		} finally {
			raw.close();
		}
		expect(await run("skill_read", { id: "legacy" })).toContain("Project legacy");
		expect(await run("skill_read", { query: "legacy" })).toContain("Project legacy");
		expect(await run("skill_read", { query: "legacy" })).not.toContain("Global legacy");
		expect(await run("skill_read", {})).toContain("Project legacy");
	});

	it("skips the global search once the project fills the limit", async () => {
		for (const id of ["one", "two", "three", "four"]) {
			await run("skill_write", { action: "create", id, title: `Title ${id}`, description: "shared hook", body: `shared body ${id}` });
		}
		const text = await run("skill_read", { query: "shared" });
		expect(text).toContain("Title four");
		expect(text).toContain("Title three");
		expect(text).not.toContain("Title one");
		expect(text).not.toContain("全局");
	});

	it("caps the merged listing at the limit, project first", async () => {
		await run("skill_write", { action: "create", id: "a", title: "A", description: "hook a", body: "body a" });
		await run("skill_write", { action: "create", id: "b", title: "B", description: "hook b", body: "body b" });
		await run("skill_write", { action: "create", id: "c", title: "C", description: "hook c", body: "body c" });
		await run("skill_write", { action: "move-to-global", id: "c" });
		await run("skill_write", { action: "create", id: "d", title: "D", description: "hook d", body: "body d" });
		await run("skill_write", { action: "move-to-global", id: "d" });
		const text = await run("skill_read", {});
		expect(text).toContain("# A");
		expect(text).toContain("# B");
		expect(text).toContain("# D");
		expect(text).not.toContain("# C");
	});
});
