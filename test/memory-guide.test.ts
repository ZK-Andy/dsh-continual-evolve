import { describe, expect, it } from "vitest";
import { MEMORY_GUIDE_RULES, memoryGuideIntro } from "../src/memory-guide.js";

describe("memoryGuideIntro", () => {
	it("hands out the central store path, the workspace partition, and the read/write split", () => {
		const intro = memoryGuideIntro("/home/u/.dsh/evolve/memory.db", "/ws", true);
		expect(intro).toContain("`/home/u/.dsh/evolve/memory.db`");
		expect(intro).toContain("当前工作区：`/ws`");
		expect(intro).toContain("memory_read");
		expect(intro).toContain("memory_write");
		expect(intro).toContain("feedback");
	});

	it("names the extraction pipeline as the owner of automatic sedimentation", () => {
		const intro = memoryGuideIntro("/db", "/ws", true);
		expect(intro).toContain("专职提取流程");
		expect(intro).not.toContain("MEMORY.md");
		expect(intro).not.toContain("文件读写工具");
	});

	it("degrades to tell-the-user phrasing when the tools are not available", () => {
		const intro = memoryGuideIntro("/db", "/ws", false);
		expect(intro).not.toContain("memory_write");
		expect(intro).toContain("告诉用户");
	});
});

describe("MEMORY_GUIDE_RULES", () => {
	it("keeps the ADR boundary and the absolute-date rule", () => {
		expect(MEMORY_GUIDE_RULES).toContain("换一个仓库还有用的信息才进记忆");
		expect(MEMORY_GUIDE_RULES).toContain("ADR");
		expect(MEMORY_GUIDE_RULES).toContain("2026-10-08");
	});

	it("never teaches direct store writes (the code is the sole writer)", () => {
		expect(MEMORY_GUIDE_RULES).not.toContain("文件");
		expect(MEMORY_GUIDE_RULES).not.toContain("MEMORY.md");
	});
});
