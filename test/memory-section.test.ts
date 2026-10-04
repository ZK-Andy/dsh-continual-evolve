import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createFrozenMemorySection,
	cwdOf,
	fitIndex,
	memoryDirFor,
	memorySectionText,
	readMemoryIndex,
} from "../src/memory-section.js";

let workspace = "";

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "evolve-memory-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

function agentAt(cwd: string, id: string = "agent-1"): unknown {
	return { id, session: { header: { cwd } } };
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
		const resolved = cwdOf({ session: { header: { cwd: workspace } } });
		expect(resolved).toBe(workspace);
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
	it("places the store at <workspace>/.evolve/memory", () => {
		expect(memoryDirFor(workspace)).toBe(join(workspace, ".evolve", "memory"));
	});
});

describe("readMemoryIndex", () => {
	it("bootstraps the store with a starter index on first use", () => {
		const dir = memoryDirFor(workspace);
		expect(readMemoryIndex(dir)).toContain("# 记忆索引");
		expect(readFileSyncStarter(dir)).toContain("- [标题](文件名.md)");
	});

	it("reads an existing index and tolerates a missing one", () => {
		const dir = memoryDirFor(workspace);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "MEMORY.md"), "- [a](a.md) — hook\n", "utf8");
		expect(readMemoryIndex(dir)).toBe("- [a](a.md) — hook");
		expect(readMemoryIndex(join(workspace, ".evolve", "absent"), false)).toBe("");
	});
});

// Direct fs read helper keeping the assertion honest about what bootstrap wrote.
function readFileSyncStarter(dir: string): string {
	return readFileSync(join(dir, "MEMORY.md"), "utf8");
}

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
	it("renders nothing for an agent without a workspace", () => {
		expect(memorySectionText(undefined)).toBe("");
		expect(memorySectionText({ session: { header: {} } })).toBe("");
	});

	it("injects the index, hands out the absolute path, and wraps the guide", () => {
		const dir = memoryDirFor(workspace);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "MEMORY.md"), "- [hook](hook.md) — 用户偏好\n", "utf8");
		const text = memorySectionText(agentAt(workspace));
		expect(text).toContain("# 持久记忆");
		expect(text).toContain(`${dir}/`);
		expect(text).toContain("<memories>\n- [hook](hook.md) — 用户偏好\n</memories>");
		expect(text).toContain("## 何时写入记忆");
		expect(text).toContain("## 如何维护");
	});

	it("shows the empty marker when the index is missing or blank", () => {
		expect(memorySectionText(agentAt(workspace), { bootstrap: false })).toContain("（暂无记忆）");
		const dir = memoryDirFor(workspace);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "MEMORY.md"), "   \n", "utf8");
		expect(memorySectionText(agentAt(workspace))).toContain("（暂无记忆）");
	});

	it("appends a truncation note when the index exceeds the budget", () => {
		const dir = memoryDirFor(workspace);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "MEMORY.md"), "aaa\nbbb\nccc\n", "utf8");
		const text = memorySectionText(agentAt(workspace), { maxChars: 5, guide: false });
		expect(text).toContain("aaa");
		expect(text).not.toContain("ccc");
		expect(text).toContain("已截断");
	});

	it("renders the read-the-directory note when nothing fits", () => {
		const dir = memoryDirFor(workspace);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "MEMORY.md"), "one-single-very-long-line\n", "utf8");
		const text = memorySectionText(agentAt(workspace), { maxChars: 5, guide: false });
		expect(text).not.toContain("<memories>");
		expect(text).toContain("一行都放不下");
	});

	it("with the guide off renders only the block, and nothing when empty", () => {
		const dir = memoryDirFor(workspace);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "MEMORY.md"), "- [x](x.md) — hook\n", "utf8");
		const bare = memorySectionText(agentAt(workspace), { guide: false });
		expect(bare).toBe("<memories>\n- [x](x.md) — hook\n</memories>");
		expect(memorySectionText(agentAt(join(workspace, "absent-workspace")), { guide: false, bootstrap: false })).toBe("");
	});

	it("skips bootstrap when asked, leaving no store behind", () => {
		memorySectionText(agentAt(workspace), { bootstrap: false });
		expect(existsSync(memoryDirFor(workspace))).toBe(false);
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
