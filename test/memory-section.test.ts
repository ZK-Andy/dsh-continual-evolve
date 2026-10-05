import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createFrozenMemorySection,
	cwdOf,
	fitIndex,
	memoryDirFor,
	memorySectionText,
} from "../src/memory-section.js";
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

describe("cwdOf", () => {
	it("returns undefined for a missing, cwd-less, or blank agent", () => {
		expect(cwdOf(undefined)).toBeUndefined();
		expect(cwdOf({})).toBeUndefined();
		expect(cwdOf({ session: { header: {} } })).toBeUndefined();
		expect(cwdOf({ session: { header: { cwd: "   " } } })).toBeUndefined();
	});

	it("returns undefined for a relative cwd and resolves an absolute one", () => {
		expect(cwdOf({ session: { header: { cwd: "relative/path" } } })).toBeUndefined();
		expect(cwdOf({ session: { header: { cwd: workspace } } })).toBe(workspace);
	});

	it("falls back to header.meta.cwd", () => {
		const agent = { session: { header: { meta: { cwd: workspace } } } };
		expect(cwdOf(agent)).toBe(workspace);
	});

	it("survives a throwing agent shape", () => {
		const hostile = {};
		Object.defineProperty(hostile, "session", {
			get() {
				throw new Error("boom");
			},
		});
		expect(cwdOf(hostile)).toBeUndefined();
	});
});

describe("memoryDirFor", () => {
	it("remains the legacy MD-era location (migration path)", () => {
		expect(memoryDirFor(workspace)).toBe(join(workspace, ".evolve", "memory"));
	});
});

describe("fitIndex", () => {
	it("returns the index untouched when it fits", () => {
		expect(fitIndex("abc", 10)).toEqual({ text: "abc", dropped: 0 });
	});

	it("truncates at the last line boundary and reports the drop", () => {
		const index = "line-one\nline-two\nline-three";
		const fit = fitIndex(index, 20);
		expect(fit.text).toBe("line-one\nline-two");
		expect(fit.dropped).toBe(index.length - fit.text.length);
	});

	it("never leaves a partial row: a single over-budget line drops whole", () => {
		expect(fitIndex("abcdef", 4)).toEqual({ text: "", dropped: 6 });
		const empty = fitIndex("abcdef", 0);
		expect(empty.text).toBe("");
		expect(empty.dropped).toBe(6);
	});
});

describe("memorySectionText", () => {
	it("renders nothing without a workspace or a store", async () => {
		expect(memorySectionText(undefined, { store })).toBe("");
		expect(memorySectionText({ session: { header: {} } }, { store })).toBe("");
		expect(memorySectionText(agentAt(workspace), { store: undefined })).toBe("");
	});

	it("injects the store query as the index, with the central-library framing", () => {
		expect(seed("fedora-env", "user", "Fedora 环境")).toBe(true);
		const text = memorySectionText(agentAt(workspace), { store });
		expect(text).toContain("# 持久记忆");
		expect(text).toContain(store.path);
		expect(text).toContain(`<memories>\n- [fedora-env] Fedora 环境 — Fedora 环境 的钩子（user）\n</memories>`);
		expect(text).toContain("memory_read");
		expect(text).toContain("memory_write");
	});

	it("orders the index feedback > user > reference and shows hooks, not bodies", () => {
		seed("zzz-reference", "reference", "参照");
		seed("aaa-user", "user", "画像");
		seed("mmm-feedback", "feedback", "规矩");
		const text = memorySectionText(agentAt(workspace), { store, guide: false });
		const lines = text.split("\n").filter((line) => line.startsWith("- ["));
		expect(lines.map((line) => line.slice(3, line.indexOf("]")))).toEqual(["mmm-feedback", "aaa-user", "zzz-reference"]);
		expect(text).not.toContain("的正文");
		expect(text).not.toContain("Why:");
	});

	it("shows the empty marker when the workspace has no memories", () => {
		const text = memorySectionText(agentAt(workspace), { store });
		expect(text).toContain("（暂无记忆）");
		expect(memorySectionText(agentAt(workspace), { store, guide: false })).toBe("");
	});

	it("renders nothing for another workspace's partition", () => {
		seed("fedora-env", "user", "Fedora 环境");
		const other = join(workspace, "other");
		expect(memorySectionText(agentAt(other), { store, guide: false })).toBe("");
	});

	it("appends a memory_read hint when the index exceeds the budget", () => {
		seed("a", "user", "甲");
		seed("b", "user", "乙");
		seed("c", "user", "丙");
		const text = memorySectionText(agentAt(workspace), { store, maxChars: 40, guide: false });
		expect(text).toContain("已截断");
		expect(text).toContain("memory_read");
		const shown = text.split("\n").filter((line) => line.startsWith("- ["));
		expect(shown.length).toBeLessThan(3);
	});

	it("renders the search hint when nothing fits", () => {
		seed("one-long-row", "user", "一行超长的索引行");
		const text = memorySectionText(agentAt(workspace), { store, maxChars: 5, guide: false });
		expect(text).not.toContain("<memories>");
		expect(text).toContain("一行都放不下");
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
		expect(memorySectionText(agentAt(workspace), { store: hostile })).toBe("");
	});

	it("swaps to the no-tools phrasing when tool registration failed", () => {
		seed("fedora-env", "user", "Fedora 环境");
		const text = memorySectionText(agentAt(workspace), { store, toolsAvailable: false });
		expect(text).not.toContain("memory_write");
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
