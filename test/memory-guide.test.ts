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
		expect(MEMORY_GUIDE_RULES).toContain("type: user | feedback | reference");
		expect(MEMORY_GUIDE_RULES).toContain("## 何时写入记忆");
		expect(MEMORY_GUIDE_RULES).toContain("<type name=\"feedback\">");
		expect(MEMORY_GUIDE_RULES).toContain("**Why:**");
		expect(MEMORY_GUIDE_RULES).toContain("## 如何维护");
		expect(MEMORY_GUIDE_RULES).toContain("MEMORY.md");
		expect(MEMORY_GUIDE_RULES).toContain("[[名字]]");
	});

	it("keeps the same-turn write rule and never frames memory as an incidental side-task", () => {
		expect(MEMORY_GUIDE_RULES).toContain("当轮就写，不留到会话后期");
		expect(memoryGuideIntro("/ws/.evolve/memory")).not.toContain("顺手");
	});

	it("redirects decisions and trade-offs to the repo ADR route (project type retired)", () => {
		expect(MEMORY_GUIDE_RULES).toContain("换一个仓库还有用的信息才进记忆");
		expect(MEMORY_GUIDE_RULES).toContain("ADR");
		expect(MEMORY_GUIDE_RULES).not.toContain("<type name=\"project\">");
		expect(MEMORY_GUIDE_RULES).not.toContain("project | reference");
	});

	it("keeps the re-derivability filter and absolute-date rule", () => {
		expect(MEMORY_GUIDE_RULES).toContain("重新推导出来的事实不存");
		expect(MEMORY_GUIDE_RULES).toContain("2026-10-08");
	});

	it("teaches read-time verification: fix or delete a memory that disagrees with reality", () => {
		expect(MEMORY_GUIDE_RULES).toContain("引用记忆前若发现与现实不符");
		expect(MEMORY_GUIDE_RULES).toContain("当场修正或删除");
		expect(MEMORY_GUIDE_RULES).toContain("退役不留给用户");
	});
});
