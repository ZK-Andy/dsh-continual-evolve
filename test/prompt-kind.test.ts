import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountCardRoutes, type CardResponse } from "../src/card-routes.js";
import { CARD_API_PROMPT_FILE_PATH, CARD_API_PROMPTS_PATH } from "../src/prompt-routes.js";
import { registerEvolveTools, type ToolDefinition } from "../src/evolve-tools.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

let store: MemoryStore;
let tools: Map<string, ToolDefinition>;
let workspace = "";
let dbPath = "";

beforeEach(async () => {
	dbPath = join(mkdtempSync(join(tmpdir(), "evolve-prompt-db-")), "memory.db");
	store = await openMemoryStore(dbPath);
	workspace = mkdtempSync(join(tmpdir(), "evolve-prompt-ws-"));
	tools = new Map();
	registerEvolveTools(
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
	return value.text;
}

const FIELDS = { title: "Review checklist", description: "things to check before landing", body: "1. tests green\n2. docs synced" };

describe("migration", () => {
	it("creates the prompts tables on a fresh file", () => {
		const db = new DatabaseSync(dbPath);
		try {
			const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as { name: string }[]).map(
				(row) => row.name,
			);
			for (const name of ["prompts", "prompts_fts", "prompt_log", "prompt_usage"]) {
				expect(names).toContain(name);
			}
		} finally {
			db.close();
		}
	});
});

describe("store CRUD", () => {
	it("creates, reads, searches, updates, and deletes", () => {
		const [created] = store.applyPromptProposals({ workspaceId: workspace, trigger: "explicit", sessionId: "s1" }, [
			{ action: "create", id: "checklist", ...FIELDS },
		]);
		expect(created?.ok).toBe(true);
		expect(store.getPrompt(workspace, "checklist")?.body).toBe(FIELDS.body);
		expect(store.listPrompts(workspace).map((r) => r.id)).toEqual(["checklist"]);
		expect(store.listAllPrompts(workspace).map((r) => r.id)).toEqual(["checklist"]);
		expect(store.searchPrompts(workspace, "checklist", 10).map((r) => r.id)).toEqual(["checklist"]);
		expect(store.listPromptWorkspaces().some((w) => w.workspaceId === workspace)).toBe(true);
		const [updated] = store.applyPromptProposals({ workspaceId: workspace, trigger: "explicit" }, [
			{ action: "update", id: "checklist", body: "v2 body" },
		]);
		expect(updated?.ok).toBe(true);
		expect(store.getPrompt(workspace, "checklist")?.body).toBe("v2 body");
		const [deleted] = store.applyPromptProposals({ workspaceId: workspace, trigger: "explicit" }, [{ action: "delete", id: "checklist" }]);
		expect(deleted?.ok).toBe(true);
		expect(store.getPrompt(workspace, "checklist")).toBeUndefined();
	});

	it("derives the id from the title when omitted", () => {
		const [outcome] = store.applyPromptProposals({ workspaceId: workspace, trigger: "explicit" }, [
			{ action: "create", ...FIELDS },
		]);
		expect(outcome?.ok).toBe(true);
		expect(outcome?.id).toBe("review-checklist");
	});
});

describe("write gates", () => {
	it("rejects missing fields, malformed ids, and unknown actions", () => {
		const ctx = { workspaceId: workspace, trigger: "explicit" as const };
		expect(store.applyPromptProposals(ctx, [{ action: "create", title: "t" }])[0]?.ok).toBe(false);
		expect(store.applyPromptProposals(ctx, [{ action: "create", id: "BAD ID", ...FIELDS }])[0]?.reason).toContain("malformed id");
		expect(
			store.applyPromptProposals(ctx, [{ action: "move-to-global", id: "x" } as never])[0]?.reason,
		).toContain("unknown action");
		expect(store.applyPromptProposals(ctx, [{ action: "update", id: "ghost", body: "b" }])[0]?.reason).toContain("no prompt");
		expect(store.applyPromptProposals(ctx, [{ action: "delete", id: "ghost" }])[0]?.reason).toContain("no prompt");
	});

	it("rejects duplicates by id and by body, and screens secrets", () => {
		const ctx = { workspaceId: workspace, trigger: "explicit" as const };
		expect(store.applyPromptProposals(ctx, [{ action: "create", id: "a", ...FIELDS }])[0]?.ok).toBe(true);
		expect(store.applyPromptProposals(ctx, [{ action: "create", id: "a", ...FIELDS }])[0]?.reason).toContain("already exists");
		expect(store.applyPromptProposals(ctx, [{ action: "create", id: "b", ...FIELDS }])[0]?.reason).toContain("identical prompt");
		expect(
			store.applyPromptProposals(ctx, [{ action: "create", id: "c", ...FIELDS, body: "key ghp_12345678901234567890" }])[0]?.reason,
		).toContain("secrets must never be sedimented");
	});
});

describe("ledger, usage, recency, patrol", () => {
	it("ledgers batches to prompt_log and prunes them", () => {
		store.applyPromptProposals({ workspaceId: workspace, trigger: "explicit" }, [{ action: "create", id: "a", ...FIELDS }]);
		const pruned = store.pruneLedger(new Date(Date.now() + 1000).toISOString());
		expect(pruned).toBeGreaterThanOrEqual(1);
	});

	it("marks a prompt-only workspace most recently active", () => {
		store.applyPromptProposals({ workspaceId: workspace, trigger: "explicit" }, [{ action: "create", id: "a", ...FIELDS }]);
		expect(store.mostRecentlyActiveWorkspace()).toBe(workspace);
	});

	it("quarantines secret-bearing prompts on patrol", () => {
		// Land the row past the gate (the gate would refuse the secret), then patrol.
		const db = new DatabaseSync(dbPath);
		try {
			const now = new Date().toISOString();
			db.prepare(
				"INSERT INTO prompts (workspace_id, id, title, description, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
			).run(workspace, "leaky", "t", "d", "token ghp_12345678901234567890", now, now);
		} finally {
			db.close();
		}
		const result = store.patrol();
		expect(result.promptQuarantined.map((row) => row.id)).toContain("leaky");
		expect(store.getPrompt(workspace, "leaky")?.status).toBe("quarantined");
		expect(store.listAllPrompts(workspace).some((row) => row.id === "leaky" && row.status === "quarantined")).toBe(true);
	});
});

describe("evolve tools", () => {
	it("writes and reads prompts by kind", async () => {
		expect(await run("evolve_write", { kind: "prompt", action: "create", id: "checklist", ...FIELDS })).toContain(
			"已写入提示词补充 `checklist`",
		);
		expect(await run("evolve_read", { kind: "prompt", id: "checklist" })).toContain("1. tests green");
		expect(await run("evolve_read", { kind: "prompt", query: "checklist" })).toContain("id: checklist");
		expect(await run("evolve_write", { kind: "prompt", action: "delete", id: "checklist" })).toContain("已删除提示词补充");
	});

	it("rejects move-to-global and bad input in prompt wording", async () => {
		expect(await run("evolve_write", { kind: "prompt", action: "move-to-global", id: "x" })).toContain("仅支持技能");
		expect(await run("evolve_write", { kind: "prompt", action: "create", id: "bad", title: "t" })).toContain("未落盘");
		expect(await run("evolve_read", { kind: "prompt", id: "ghost" })).toContain("没有找到");
		expect(await run("evolve_write", { kind: "prompt", action: "create", id: "x", ...FIELDS }, { agent: {} })).toContain(
			"无法写入提示词补充",
		);
	});

	it("hearts a body served by id", async () => {
		await run("evolve_write", { kind: "prompt", action: "create", id: "checklist", ...FIELDS });
		expect(store.getPromptUse(workspace, "checklist")).toBeUndefined();
		await run("evolve_read", { kind: "prompt", id: "checklist" });
		expect(store.getPromptUse(workspace, "checklist")).toMatchObject({ useCount: 1 });
	});
});

describe("card", () => {
	function get(path: string): { status: number; body: unknown } {
		const routes = new Map<string, (req: unknown, res: CardResponse) => void>();
		const dispose = mountCardRoutes({ register: (route: { path: string; handler: (req: unknown, res: CardResponse) => void }) => {
			routes.set(route.path, route.handler);
			return () => routes.delete(route.path);
		} }, store);
		try {
			expect([...routes.keys()]).toContain(CARD_API_PROMPTS_PATH);
			expect([...routes.keys()]).toContain(CARD_API_PROMPT_FILE_PATH);
			let status = 0;
			let text = "";
			const routePath = path.split("?")[0] ?? path;
			routes.get(routePath)?.({ method: "GET", url: path }, {
				writeHead: (code: number) => {
					status = code;
				},
				end: (payload?: string) => {
					text = payload ?? "";
				},
			});
			return { status, body: text.length > 0 ? (JSON.parse(text) as unknown) : null };
		} finally {
			dispose();
		}
	}

	it("lists a prompts-only workspace and serves its snapshot and body", async () => {
		await run("evolve_write", { kind: "prompt", action: "create", id: "checklist", ...FIELDS });
		const listed = get(`/dsh-continual-evolve/api/v1/workspaces`);
		expect(listed.status).toBe(200);
		expect(JSON.stringify(listed.body)).toContain(workspace);
		const snapshot = get(`${CARD_API_PROMPTS_PATH}?root=${encodeURIComponent(workspace)}`);
		expect(snapshot.status).toBe(200);
		expect(JSON.stringify(snapshot.body)).toContain("checklist");
		const file = get(`${CARD_API_PROMPT_FILE_PATH}?root=${encodeURIComponent(workspace)}&id=checklist`);
		expect(file.status).toBe(200);
		expect(JSON.stringify(file.body)).toContain("1. tests green");
		expect(get(`${CARD_API_PROMPTS_PATH}?root=${encodeURIComponent("/nonexistent-root")}`).status).toBe(404);
	});
});
