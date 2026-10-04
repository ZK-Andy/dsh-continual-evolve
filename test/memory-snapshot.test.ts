import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	memorySnapshot,
	parseMemoryFrontmatter,
	parseMemoryIndexRows,
} from "../src/memory-snapshot.js";

let workspace = "";

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "evolve-snapshot-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

function memoryDir(): string {
	return join(workspace, ".evolve", "memory");
}

function writeFile(relativePath: string, content: string): void {
	mkdirSync(join(memoryDir(), relativePath, ".."), { recursive: true });
	writeFileSync(join(memoryDir(), relativePath), content, "utf8");
}

describe("parseMemoryIndexRows", () => {
	it("parses index rows; comments, headings, and non-md links are ignored", () => {
		const index = [
			"# 记忆索引",
			"<!-- 一行一条 -->",
			"",
			"- [DSH 配置位置](dsh-config.md) — 安装版配置在 ~/.dsh",
			"  - [嵌套行](nested.md) — 缩进行经 trim 后同样合法（md 索引本就允许）",
			"- [看板](https://example.com) — 非 md 链接忽略",
			"- 纯文本行忽略",
		].join("\n");
		const rows = parseMemoryIndexRows(index);
		expect(rows).toEqual([
			{ title: "DSH 配置位置", file: "dsh-config.md" },
			{ title: "嵌套行", file: "nested.md" },
		]);
	});
});

describe("parseMemoryFrontmatter", () => {
	it("reads name/description/type and strips quotes", () => {
		const text = `---\nname: "dsh-config"\ndescription: '配置位置'\ntype: reference\n---\n\n正文`;
		expect(parseMemoryFrontmatter(text)).toEqual({
			name: "dsh-config",
			description: "配置位置",
			type: "reference",
		});
	});

	it("returns empty fields for body-only or unterminated frontmatter", () => {
		expect(parseMemoryFrontmatter("只有正文")).toEqual({ name: "", description: "", type: "" });
		expect(parseMemoryFrontmatter("---\nname: x\n没有收尾")).toEqual({
			name: "",
			description: "",
			type: "",
		});
	});
});

describe("memorySnapshot", () => {
	it("reports a missing store as absent without bootstrap", () => {
		const snapshot = memorySnapshot(workspace);
		expect(snapshot.exists).toBe(false);
		expect(snapshot.fileCount).toBe(0);
		expect(snapshot.readError).toBeNull();
		expect(snapshot.memoryDir).toBe(join(workspace, ".evolve", "memory"));
	});

	it("projects a populated store: counts, frontmatter, no drift", () => {
		writeFile(
			"MEMORY.md",
			"# 记忆索引\n\n- [配置](dsh-config.md) — 安装版配置位置\n- [偏好](user-pref.md) — 用户偏好\n",
		);
		writeFile("dsh-config.md", "---\nname: dsh-config\ndescription: 配置位置\ntype: reference\n---\n正文");
		writeFile("user-pref.md", "---\nname: user-pref\ndescription: 用户偏好\ntype: user\n---\n正文");
		const snapshot = memorySnapshot(workspace);
		expect(snapshot.exists).toBe(true);
		expect(snapshot.fileCount).toBe(2);
		expect(snapshot.indexEntryCount).toBe(2);
		expect(snapshot.files).toEqual([
			{ file: "dsh-config.md", name: "dsh-config", description: "配置位置", type: "reference" },
			{ file: "user-pref.md", name: "user-pref", description: "用户偏好", type: "user" },
		]);
		expect(snapshot.missingFiles).toEqual([]);
		expect(snapshot.unindexedFiles).toEqual([]);
	});

	it("reports drift in both directions: missing files and unindexed files", () => {
		writeFile("MEMORY.md", "- [失联](gone.md) — 索引引用但文件已删\n");
		writeFile("orphan.md", "没有索引行的文件");
		const snapshot = memorySnapshot(workspace);
		expect(snapshot.missingFiles).toEqual(["gone.md"]);
		expect(snapshot.unindexedFiles).toEqual(["orphan.md"]);
	});

	it("degrades a read failure to readError instead of throwing", () => {
		// MEMORY.md as a directory: existsSync passes, readFileSync throws.
		mkdirSync(join(memoryDir(), "MEMORY.md"), { recursive: true });
		const snapshot = memorySnapshot(workspace);
		expect(snapshot.exists).toBe(true);
		expect(snapshot.readError).not.toBeNull();
		expect(snapshot.fileCount).toBe(0);
	});
});
