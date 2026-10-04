import { describe, expect, it } from "vitest";
import { MEMORY_GUIDE_RULES, memoryGuideIntro } from "../src/memory-guide.js";

describe("memoryGuideIntro", () => {
	it("hands out the absolute store path and the native file tools stance", () => {
		const intro = memoryGuideIntro("/ws/.evolve/memory");
		expect(intro).toContain("`/ws/.evolve/memory/`");
		expect(intro).toContain("MEMORY.md");
		expect(intro).toContain("文件读写工具");
		expect(intro).not.toContain("evolve_add");
		expect(intro).not.toContain("evolve_recall");
	});
});

describe("MEMORY_GUIDE_RULES", () => {
	it("teaches the file format, the when-to-save filter, and index maintenance", () => {
		expect(MEMORY_GUIDE_RULES).toContain("name: <短横线小写标识>");
		expect(MEMORY_GUIDE_RULES).toContain("type: user | feedback | project | reference");
		expect(MEMORY_GUIDE_RULES).toContain("## 何时写入记忆");
		expect(MEMORY_GUIDE_RULES).toContain("<type name=\"feedback\">");
		expect(MEMORY_GUIDE_RULES).toContain("**Why:**");
		expect(MEMORY_GUIDE_RULES).toContain("## 如何维护");
		expect(MEMORY_GUIDE_RULES).toContain("MEMORY.md");
		expect(MEMORY_GUIDE_RULES).toContain("[[名字]]");
	});

	it("keeps the re-derivability filter and absolute-date rule", () => {
		expect(MEMORY_GUIDE_RULES).toContain("重新推导出来的事实不存");
		expect(MEMORY_GUIDE_RULES).toContain("2026-10-08");
	});
});
