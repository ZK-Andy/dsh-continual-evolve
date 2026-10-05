import { describe, expect, it } from "vitest";
import {
	feedbackWhyHowMissing,
	fieldGateReasons,
	isValidMemoryId,
	MEMORY_BODY_LIMIT,
	MEMORY_DESCRIPTION_LIMIT,
	MEMORY_TITLE_LIMIT,
	secretLeakReason,
	slugifyId,
} from "../src/memory-rules.js";

describe("isValidMemoryId", () => {
	it("accepts kebab slugs", () => {
		expect(isValidMemoryId("dsh-config")).toBe(true);
		expect(isValidMemoryId("a")).toBe(true);
		expect(isValidMemoryId("m-1a2b3c4d")).toBe(true);
	});

	it("rejects non-kebab shapes and overlong ids", () => {
		expect(isValidMemoryId("")).toBe(false);
		expect(isValidMemoryId("Fedora-Env")).toBe(false);
		expect(isValidMemoryId("-lead")).toBe(false);
		expect(isValidMemoryId("trail-")).toBe(false);
		expect(isValidMemoryId("dou--ble")).toBe(false);
		expect(isValidMemoryId("有中文")).toBe(false);
		expect(isValidMemoryId("a".repeat(81))).toBe(false);
	});
});

describe("slugifyId", () => {
	it("slugifies ascii titles", () => {
		expect(slugifyId("DSH Config Locations!")).toBe("dsh-config-locations");
	});

	it("falls back to a hash for CJK-only titles", () => {
		const id = slugifyId("配置位置");
		expect(id).toMatch(/^m-[0-9a-f]{8}$/);
		// Deterministic for the same title, distinct across titles.
		expect(slugifyId("配置位置")).toBe(id);
		expect(slugifyId("另一条")).not.toBe(id);
	});

	it("caps the slug at 80 characters", () => {
		expect(slugifyId("ab ".repeat(60)).length).toBeLessThanOrEqual(80);
	});
});

describe("feedbackWhyHowMissing", () => {
	it("accepts bold and plain spellings", () => {
		expect(feedbackWhyHowMissing("规则\n**Why:** 因为\n**How to apply:** 这样")).toBe("");
		expect(feedbackWhyHowMissing("规则\nWhy: 因为\nHow to apply: 这样")).toBe("");
	});

	it("names the missing lines", () => {
		expect(feedbackWhyHowMissing("只有 Why: 有")).toBe("How to apply:");
		expect(feedbackWhyHowMissing("只有 **How to apply:** 有")).toBe("Why:");
		expect(feedbackWhyHowMissing("两个都没有")).toBe("Why:、How to apply:");
	});
});

describe("secretLeakReason", () => {
	it("flags realistic credentials", () => {
		expect(secretLeakReason("key = sk-ant-api03-abcdefghijklmnop")).toBeDefined();
		expect(secretLeakReason("token ghp_0123456789abcdefghijklmnopqrstuv")).toBeDefined();
		expect(secretLeakReason("AKIAIOSFODNN7EXAMPLE")).toBeDefined();
		expect(secretLeakReason("apiKey: '0123456789abcdefghij'")).toBeDefined();
		expect(secretLeakReason("-----BEGIN RSA PRIVATE KEY-----")).toBeDefined();
		expect(secretLeakReason("as_sk_0123456789")).toBeDefined();
	});

	it("passes placeholders and prose", () => {
		expect(secretLeakReason("YOUR_API_KEY_HERE")).toBeUndefined();
		expect(secretLeakReason("API_KEY= 设置在 ~/.dsh/.env")).toBeUndefined();
		expect(secretLeakReason("用 Exa 搜索，定价 $7/1k")).toBeUndefined();
	});
});

describe("fieldGateReasons", () => {
	const ok = { type: "user" as const, title: "t", description: "d", body: "b" };

	it("passes a well-formed record", () => {
		expect(fieldGateReasons(ok)).toEqual([]);
	});

	it("blocks empty and oversized fields", () => {
		expect(fieldGateReasons({ ...ok, title: "" }).some((r) => r.includes("title"))).toBe(true);
		expect(fieldGateReasons({ ...ok, title: "x".repeat(MEMORY_TITLE_LIMIT + 1) }).some((r) => r.includes("title"))).toBe(true);
		expect(fieldGateReasons({ ...ok, description: "" }).some((r) => r.includes("description"))).toBe(true);
		expect(fieldGateReasons({ ...ok, description: "d".repeat(MEMORY_DESCRIPTION_LIMIT + 1) }).some((r) => r.includes("description"))).toBe(true);
		expect(fieldGateReasons({ ...ok, body: "" }).some((r) => r.includes("body"))).toBe(true);
		expect(fieldGateReasons({ ...ok, body: "b".repeat(MEMORY_BODY_LIMIT + 1) }).some((r) => r.includes("cap"))).toBe(true);
	});

	it("blocks unknown types and incomplete feedback bodies", () => {
		expect(fieldGateReasons({ ...ok, type: "project" as never }).some((r) => r.includes("type"))).toBe(true);
		expect(fieldGateReasons({ ...ok, type: "feedback" }).some((r) => r.includes("feedback"))).toBe(true);
		expect(
			fieldGateReasons({ ...ok, type: "feedback", body: "规则\n**Why:** 因\n**How to apply:** 用" }),
		).toEqual([]);
	});

	it("blocks secrets in any field", () => {
		expect(fieldGateReasons({ ...ok, body: "ghp_0123456789abcdefghijklmnopqrstuv" }).some((r) => r.includes("GitHub token"))).toBe(true);
	});
});
