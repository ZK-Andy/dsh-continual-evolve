import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSection, createFrozenMemorySection, memoryDirFor } from "../src/surfaces/memory-section.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

let workspace = "";
let store: MemoryStore;

beforeEach(async () => {
	workspace = mkdtempSync(join(tmpdir(), "evolve-memory-"));
	store = await openMemoryStore(join(mkdtempSync(join(tmpdir(), "evolve-memory-db-")), "memory.db"));
});

afterEach(() => {
	store.close();
});

function agentAt(cwd: string, id: string = "agent-1"): unknown {
	return { id, session: { header: { cwd } } };
}

function seed(id: string, type: "user" | "feedback" | "reference", title: string): boolean {
	return store
		.applyProposals({ workspaceId: workspace, trigger: "explicit" }, [
			{
				action: "create",
				id,
				type,
				title,
				description: `${title} 的钩子`,
				body:
					type === "feedback"
						? `${title} 的规则\n**Why:** 有理由\n**How to apply:** 有场景`
						: `${title} 的正文`,
			},
		])[0]?.ok === true;
}

describe("memoryDirFor", () => {
	it("remains the legacy MD-era location (migration path)", () => {
		expect(memoryDirFor(workspace)).toBe(join(workspace, ".evolve", "memory"));
	});
});

describe("memorySectionText", () => {
	it("puts global rows first and marks a probation row", async () => {
		store.applyProposals({ workspaceId: "", trigger: "explicit" }, [
			{ action: "create", id: "g-l0", type: "user", title: "全局偏好", description: "钩子", body: "正文" },
		]);
		store.applyProposals({ workspaceId: workspace, trigger: "explicit" }, [
			{ action: "create", id: "p-l1", type: "user", title: "项目事实", description: "钩子", body: "正文" },
			{ action: "create", id: "p-l2", type: "user", title: "另一条项目事实", description: "钩子", body: "正文" },
		]);
		// Promote one project row: it moves into L0 on probation, so the next
		// render must place it in the global block with the trial marker.
		expect(store.promoteMemory(workspace, "p-l1").ok).toBe(true);
		const text = buildSection(agentAt(workspace), { store, maxTokens: 6000 }).text;
		expect(text.indexOf("g-l0")).toBeLessThan(text.indexOf("p-l2"));
		expect(text.indexOf("p-l1")).toBeLessThan(text.indexOf("p-l2"));
		expect(text).toContain("（试用中）");
		expect(text.match(/- \[p-l1\]/g)?.length).toBe(1);
	});

	it("renders nothing without a workspace or a store", async () => {
		expect(buildSection(undefined, { store, maxTokens: 6000 }).text).toBe("");
		expect(buildSection({ session: { header: {} } }, { store, maxTokens: 6000 }).text).toBe("");
		expect(buildSection(agentAt(workspace), { store: undefined, maxTokens: 6000 }).text).toBe("");
	});

	it("injects the store query as the index, with the central-library framing", () => {
		expect(seed("fedora-env", "user", "Fedora 环境")).toBe(true);
		const text = buildSection(agentAt(workspace), { store, maxTokens: 6000 }).text;
		expect(text).toContain("# 持久记忆");
		expect(text).toContain(store.path);
		expect(text).toContain(`<memories>\n- [fedora-env] Fedora 环境 — Fedora 环境 的钩子\n</memories>`);
		expect(text).toContain("evolve_read");
		expect(text).toContain("evolve_write");
	});

	it("clips a long description and leaves the type to the block ordering", () => {
		expect(
			store.applyProposals({ workspaceId: workspace, trigger: "explicit" }, [
				{
					action: "create",
					id: "long-hook",
					type: "user",
					title: "短标题",
					description: "这是一条很长很长的描述，长到会把索引行撑成一条小作文，必须被截断",
					body: "正文",
				},
			])[0]?.ok,
		).toBe(true);
		const text = buildSection(agentAt(workspace), { store, maxTokens: 6000, guide: false }).text;
		expect(text).toContain("- [long-hook] 短标题 — 这是一条很长很长的描述，长到会把索引行撑…");
		expect(text).not.toContain("（user）");
		expect(text).not.toContain("小作文");
	});

	it("orders the index feedback > user > reference and shows hooks, not bodies", () => {
		seed("zzz-reference", "reference", "参照");
		seed("aaa-user", "user", "画像");
		seed("mmm-feedback", "feedback", "规矩");
		const text = buildSection(agentAt(workspace), { store, maxTokens: 6000, guide: false }).text;
		const lines = text.split("\n").filter((line) => line.startsWith("- ["));
		expect(lines.map((line) => line.slice(3, line.indexOf("]")))).toEqual(["mmm-feedback", "aaa-user", "zzz-reference"]);
		expect(text).not.toContain("的正文");
		expect(text).not.toContain("Why:");
	});

	it("shows the empty marker when the workspace has no memories", () => {
		const text = buildSection(agentAt(workspace), { store, maxTokens: 6000 }).text;
		expect(text).toContain("（暂无记忆）");
		expect(buildSection(agentAt(workspace), { store, maxTokens: 6000, guide: false }).text).toBe("");
	});

	it("renders nothing for another workspace's partition", () => {
		seed("fedora-env", "user", "Fedora 环境");
		const other = join(workspace, "other");
		expect(buildSection(agentAt(other), { store, maxTokens: 6000, guide: false }).text).toBe("");
	});

	it("keeps an over-budget row discoverable as an id-only line", () => {
		seed("a", "user", "甲");
		seed("b", "user", "乙");
		seed("c", "user", "丙");
		const section = buildSection(agentAt(workspace), { store, maxTokens: 16, guide: false });
		// Full lines stop fitting; the tail degrades to ids instead of vanishing.
		expect(section.fullCount).toBeGreaterThan(0);
		expect(section.idOnlyCount).toBeGreaterThan(0);
		expect(section.fullCount + section.idOnlyCount).toBe(2);
		expect(section.text).toMatch(/^- \[[abc]\]$/m);
	});

	it("renders the search hint when not even one id fits", () => {
		seed("one-long-row", "user", "一行超长的索引行");
		const section = buildSection(agentAt(workspace), { store, maxTokens: 1, guide: false });
		expect(section.text).not.toContain("<memories>");
		expect(section.text).toContain("一条都放不下");
	});

	it("survives a store that throws on read", () => {
		const hostile = new Proxy({}, {
			get(_target, prop) {
				if (prop === "list") {
					throw new Error("boom");
				}
				if (prop === "path") {
					return "/db";
				}
				return undefined;
			},
		}) as unknown as MemoryStore;
		expect(buildSection(agentAt(workspace), { store: hostile, maxTokens: 6000 }).text).toBe("");
	});

	it("swaps to the no-tools phrasing when tool registration failed", () => {
		seed("fedora-env", "user", "Fedora 环境");
		const text = buildSection(agentAt(workspace), { store, maxTokens: 6000, toolsAvailable: false }).text;
		expect(text).not.toContain("evolve_write");
		expect(text).toContain("告诉用户");
	});
});

describe("createFrozenMemorySection", () => {
	it("reuses one build per agent id and rebuilds for others", () => {
		const frozen = createFrozenMemorySection();
		let builds = 0;
		const build = () => `text-${++builds}`;
		expect(frozen.textFor({ id: "a" }, build)).toBe("text-1");
		expect(frozen.textFor({ id: "a" }, build)).toBe("text-1");
		expect(frozen.textFor({ id: "b" }, build)).toBe("text-2");
		expect(frozen.size()).toBe(2);
		frozen.clear();
		expect(frozen.size()).toBe(0);
	});

	it("evicts the oldest session beyond the limit", () => {
		const frozen = createFrozenMemorySection(1);
		const build = () => "text";
		frozen.textFor({ id: "a" }, build);
		frozen.textFor({ id: "b" }, build);
		expect(frozen.size()).toBe(1);
	});

	it("rebuilds on every call for an agent without an id", () => {
		const frozen = createFrozenMemorySection();
		let builds = 0;
		expect(frozen.textFor({}, () => `t${++builds}`)).toBe("t1");
		expect(frozen.textFor({}, () => `t${++builds}`)).toBe("t2");
	});
});
