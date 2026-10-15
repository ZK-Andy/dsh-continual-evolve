import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerEvolveTools, executeEvolveRead, executeEvolveWrite, type ToolDefinition } from "../src/surfaces/evolve-tools.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

let store: MemoryStore;
let tools: Map<string, ToolDefinition>;
let workspace = "";
let savedDshHome: string | undefined;

beforeEach(async () => {
	store = await openMemoryStore(join(mkdtempSync(join(tmpdir(), "evolve-p3-db-")), "memory.db"));
	workspace = mkdtempSync(join(tmpdir(), "evolve-p3-ws-"));
	savedDshHome = process.env.DSH_HOME;
	process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "evolve-p3-home-"));
	tools = new Map();
	const service = {
		register(definition: unknown) {
			const tool = definition as ToolDefinition;
			tools.set(tool.name, tool);
			return () => tools.delete(tool.name);
		},
	};
	registerEvolveTools(service, store);
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
	const tool = tools.get(name);
	expect(tool, `tool ${name} registered`).toBeDefined();
	const value = await tool!.execute(args, context as never);
	expect(tool!.output.render(args, { text: value.text })).toEqual([{ type: "text", text: value.text }]);
	return value.text;
}

describe("registration shape", () => {
	it("registers the two unified tools with API-safe schemas", () => {
		for (const name of ["evolve_write", "evolve_read"]) {
			expect(tools.has(name)).toBe(true);
		}
		for (const name of ["evolve_write", "evolve_read"]) {
			const tool = tools.get(name)!;
			expect(tool.parameters.type).toBe("object");
			expect(tool.parameters.additionalProperties).toBe(false);
			expect(tool.output.schema).toBeDefined();
			expect(typeof tool.output.render).toBe("function");
		}
		expect(tools.get("evolve_write")?.parameters.required).toEqual(["kind", "action"]);
		expect(tools.get("evolve_read")?.parameters.required).toEqual(["kind"]);
	});

	it("registers exactly the two unified tools", () => {
		expect([...tools.keys()].sort()).toEqual(["evolve_read", "evolve_write"]);
	});

	it("returns a disposer that removes exactly the two unified tools", () => {
		let registered = 0;
		let disposed = 0;
		const remove = registerEvolveTools(
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

describe("evolve_write / evolve_read over memories", () => {
	it("creates, reads, and searches memories by kind", async () => {
		const text = await run("evolve_write", {
			kind: "memory",
			action: "create",
			id: "uni-mem",
			type: "user",
			title: "环境",
			description: "钩子文本",
			body: "完整正文在这里",
		});
		expect(text).toContain("已写入记忆 `uni-mem`");
		expect(store.get(workspace, "uni-mem")?.body).toBe("完整正文在这里");
		expect(await run("evolve_read", { kind: "memory", id: "uni-mem" })).toContain("完整正文在这里");
		expect(await run("evolve_read", { kind: "memory", query: "完整正文" })).toContain("id: uni-mem");
		expect(await run("evolve_read", { kind: "memory", id: "ghost" })).toContain("没有找到");
	});

	it("surfaces memory gate rejections", async () => {
		const text = await run("evolve_write", {
			kind: "memory",
			action: "create",
			type: "feedback",
			title: "缺两行",
			description: "d",
			body: "没有 Why 和 How",
		});
		expect(text).toContain("写入被门禁拒绝");
		expect(text).toContain("How to apply:");
	});

	it("rejects move-to-global for memories", async () => {
		expect(await run("evolve_write", { kind: "memory", action: "move-to-global", id: "uni-mem" })).toContain(
			"move-to-global 仅支持技能",
		);
	});
});

describe("evolve_write / evolve_read over skills", () => {
	const FIELDS = { title: "Deploy checklist", description: "pre-release steps", body: "1. build\n2. verify" };

	it("creates, moves to global, and reads skills by kind", async () => {
		expect(await run("evolve_write", { kind: "skill", action: "create", id: "deploy", ...FIELDS })).toContain(
			"已写入技能 `deploy`",
		);
		expect(await run("evolve_read", { kind: "skill", id: "deploy" })).toContain("本项目");
		expect(await run("evolve_write", { kind: "skill", action: "move-to-global", id: "deploy" })).toContain("手动搬到全局");
		expect(await run("evolve_read", { kind: "skill", id: "deploy" })).toContain("全局");
		expect(await run("evolve_read", { kind: "skill", query: "Deploy" })).toContain("deploy");
	});

	it("updates and deletes in the project scope", async () => {
		await run("evolve_write", { kind: "skill", action: "create", id: "deploy", ...FIELDS });
		expect(await run("evolve_write", { kind: "skill", action: "update", id: "deploy", body: "v2 body" })).toContain(
			"已更新技能 `deploy`",
		);
		expect(await run("evolve_write", { kind: "skill", action: "delete", id: "deploy" })).toContain("已删除技能 `deploy`");
		expect(store.getSkill(workspace, "deploy")).toBeUndefined();
	});
});

describe("kind dispatch", () => {
	it("rejects unknown kinds", async () => {
		// Tool面先拦一层（kind-aware 用法提示），核心执行器另有守卫：
		expect(await run("evolve_write", { kind: "thread", action: "create" })).toContain("kind 必须是");
		expect(await run("evolve_read", { kind: "thread" })).toContain("kind 必须是");
		expect(executeEvolveWrite(store, workspace, "sess-1", { kind: "thread", action: "create" })).toContain("不支持的 kind");
		expect(executeEvolveRead(store, workspace, { kind: "thread" })).toContain("不支持的 kind");
	});

	it("answers without a workspace in kind-aware wording", async () => {
		const noWs = { agent: {} };
		expect(await run("evolve_write", { kind: "memory", action: "create" }, noWs)).toContain("无法写入记忆");
		expect(await run("evolve_write", { kind: "skill", action: "create" }, noWs)).toContain("无法写入技能");
		expect(await run("evolve_read", { kind: "memory" }, noWs)).toContain("无法读取记忆");
		expect(await run("evolve_read", { kind: "skill" }, noWs)).toContain("无法读取技能");
		expect(await run("evolve_write", { kind: "prompt", action: "create" }, noWs)).toContain("无法写入提示词补充");
		expect(await run("evolve_read", { kind: "prompt" }, noWs)).toContain("无法读取提示词补充");
		expect(await run("evolve_write", { kind: "thread", action: "create" }, noWs)).toContain("kind 必须是");
	});
});
