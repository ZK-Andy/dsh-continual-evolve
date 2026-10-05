import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerMemoryTools, type ToolDefinition } from "../src/memory-tools.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

let store: MemoryStore;
let tools: Map<string, ToolDefinition>;
let workspace = "";

beforeEach(async () => {
	store = await openMemoryStore(join(mkdtempSync(join(tmpdir(), "evolve-tools-db-")), "memory.db"));
	workspace = mkdtempSync(join(tmpdir(), "evolve-tools-ws-"));
	tools = new Map();
	registerMemoryTools(
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

describe("registration shape", () => {
	it("registers exactly the two memory tools with API-safe schemas", () => {
		expect([...tools.keys()].sort()).toEqual(["memory_read", "memory_write"]);
		for (const tool of tools.values()) {
			// The raw-register path forwards `parameters` to the API verbatim:
			// standard JSON Schema only (docs/FAQ.md #2).
			expect(tool.parameters.type).toBe("object");
			expect(tool.parameters.additionalProperties).toBe(false);
			expect(tool.output.schema).toBeDefined();
			expect(typeof tool.output.render).toBe("function");
		}
		expect(tools.get("memory_write")?.parameters.required).toEqual(["action"]);
		expect(tools.get("memory_read")?.parameters.required).toBeUndefined();
	});

	it("returns a disposer that can remove the tools", () => {
		let registered = 0;
		let disposed = 0;
		const remove = registerMemoryTools(
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

describe("memory_write", () => {
	it("creates through the gates and records provenance", async () => {
		const text = await run("memory_write", {
			action: "create",
			type: "user",
			title: "Fedora 环境",
			description: "用户的操作系统",
			body: "Fedora 44",
		});
		const id = /已写入记忆 `(.+?)`/.exec(text)?.[1] ?? "";
		expect(id).toBe("fedora"); // ascii prefix slugifies; CJK tail is stripped
		const record = store.get(workspace, id);
		expect(record?.sourceSession).toBe("sess-1");
		expect(record?.sourceRun).toBe("explicit");
	});

	it("creates with a given id and answers with it", async () => {
		const text = await run("memory_write", {
			action: "create",
			id: "exa-pricing",
			type: "reference",
			title: "Exa 定价",
			description: "价格指针",
			body: "$7/1k",
		});
		expect(text).toContain("已写入记忆 `exa-pricing`");
	});

	it("update patches fields, delete removes", async () => {
		await run("memory_write", {
			action: "create",
			id: "env",
			type: "user",
			title: "环境",
			description: "d",
			body: "v1",
		});
		expect(await run("memory_write", { action: "update", id: "env", body: "v2" })).toContain("已更新记忆 `env`");
		expect(store.get(workspace, "env")?.body).toBe("v2");
		expect(await run("memory_write", { action: "delete", id: "env" })).toContain("已删除记忆 `env`");
		expect(store.get(workspace, "env")).toBeUndefined();
	});

	it("surfaces gate rejections instead of failing silently", async () => {
		const text = await run("memory_write", {
			action: "create",
			type: "feedback",
			title: "缺两行",
			description: "d",
			body: "没有 Why 和 How",
		});
		expect(text).toContain("写入被门禁拒绝");
		expect(text).toContain("How to apply:");
		expect(store.list(workspace)).toEqual([]);
	});

	it("answers with an error when the session has no workspace", async () => {
		const text = await run("memory_write", { action: "create", type: "user", title: "t", description: "d", body: "b" }, {
			agent: { id: "s" },
		});
		expect(text).toContain("没有可用的工作区路径");
	});
});

describe("memory_read", () => {
	it("returns the full body for an id and a miss message otherwise", async () => {
		await run("memory_write", {
			action: "create",
			id: "env",
			type: "user",
			title: "环境",
			description: "钩子文本",
			body: "完整正文在这里",
		});
		const hit = await run("memory_read", { id: "env" });
		expect(hit).toContain("id: env");
		expect(hit).toContain("完整正文在这里");
		expect(await run("memory_read", { id: "ghost" })).toContain("没有找到");
	});

	it("searches by keyword and lists recent memories without arguments", async () => {
		for (const [id, body] of [["a", "苹果相关内容"], ["b", "香蕉相关内容"], ["c", "苹果也出现在这里"]] as const) {
			await run("memory_write", {
				action: "create",
				id,
				type: "user",
				title: id,
				description: `${id} 的钩子`,
				body,
			});
		}
		const hits = await run("memory_read", { query: "苹果" });
		expect(hits).toContain("id: a");
		expect(hits).toContain("id: c");
		expect(hits).not.toContain("id: b");
		// Multi-keyword queries AND-combine (2-char tokens go through LIKE).
		const andHits = await run("memory_read", { query: "苹果 这里" });
		expect(andHits).toContain("id: c");
		expect(andHits).not.toContain("id: a");
		const listed = await run("memory_read", {});
		expect(listed).toContain("id: a");
		expect(await run("memory_read", { query: "苹果", limit: 1 }).then((text) => text.split("---").length)).toBe(1);
		expect(await run("memory_read", { query: "不存在的东西" })).toContain("没有匹配");
	});

	it("answers with an error when the session has no workspace", async () => {
		expect(await run("memory_read", {}, { agent: {} })).toContain("没有可用的工作区路径");
	});
});
