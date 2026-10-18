import { describe, expect, it } from "vitest";
import { screenExtractionBatch } from "../src/services/extraction-screen.js";
import type { MemoryProposal } from "../src/services/memory-rules.js";
import type { MemoryStore } from "../src/store-types.js";

const body = "任何发版之前都必须确认 CI 全绿，本地绿不算数。";

function storeWith(rows: { id: string; body: string }[]): MemoryStore {
	return {
		list: () =>
			rows.map((row) => ({
				id: row.id,
				title: row.id,
				description: "钩子",
				body: row.body,
				notWhen: "",
			})),
	} as unknown as MemoryStore;
}

const create = (value: string): MemoryProposal => ({ action: "create", body: value });

describe("screenExtractionBatch", () => {
	it("keeps proposals that carry new content", () => {
		const result = screenExtractionBatch(storeWith([{ id: "rule-a", body }]), "/w", [create("另一条完全不同的规则内容，长度足够。")]);
		expect(result.kept).toHaveLength(1);
		expect(result.skipReason).toBeUndefined();
	});

	it("drops duplicates and names the reason when nothing survives", () => {
		const result = screenExtractionBatch(storeWith([{ id: "rule-a", body }]), "/w", [create(body)]);
		expect(result.kept).toHaveLength(0);
		expect(result.skipReason).toBe("pre-screen: duplicate×1");
	});

	it("names the fallback reason when the batch was empty", () => {
		const result = screenExtractionBatch(storeWith([]), "/w", []);
		expect(result.skipReason).toBe("pre-screen: no proposals");
	});

	it("splits a mixed batch and keeps the survivors", () => {
		const result = screenExtractionBatch(storeWith([{ id: "rule-a", body }]), "/w", [create(body), create("新的内容，够长。")]);
		expect(result.kept).toHaveLength(1);
		expect(result.skipReason).toBeUndefined();
	});
});
