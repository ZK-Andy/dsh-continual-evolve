import { describe, expect, it } from "vitest";
import { errorText, runIdOf } from "../src/services/extraction-item.js";
import type { ExtractionTarget } from "../src/services/extraction.js";

const target: ExtractionTarget = {
	workspaceId: "ws",
	sessionId: "sess-1",
	internalAgent: false,
	provider: "deepseek",
	model: "deepseek-chat",
};

describe("runIdOf", () => {
	it("pins the boundary seq when present", () => {
		expect(runIdOf({ target, boundarySeq: 42 })).toBe("extract:sess-1:42");
	});

	it("falls back to tail when the run has no boundary yet", () => {
		expect(runIdOf({ target, boundarySeq: undefined })).toBe("extract:sess-1:tail");
	});
});

describe("errorText", () => {
	it("keeps an Error's message and stack", () => {
		const result = errorText(new Error("boom"));
		expect(result.message).toBe("boom");
		expect(result.detail.startsWith("boom\n")).toBe(true);
		expect(result.detail).toContain("at ");
	});

	it("falls back to String(error) for an empty-message Error", () => {
		const result = errorText(new Error(""));
		expect(result.message).toBe("Error");
	});

	it("formats a non-Error throw from its string form", () => {
		const result = errorText("plain-string");
		expect(result.message).toBe("plain-string");
		expect(result.detail).toBe("plain-string\nplain-string");
	});

	it("falls back to the message when the stack is missing", () => {
		const thrown = new Error("no-stack");
		delete thrown.stack;
		const result = errorText(thrown);
		expect(result.message).toBe("no-stack");
		expect(result.detail).toBe("no-stack\nno-stack");
	});

	it("truncates the detail to the ledger budget", () => {
		const result = errorText(new Error("x".repeat(3000)));
		expect(result.detail.length).toBeLessThanOrEqual(2048);
		expect(result.message).toBe("x".repeat(3000));
	});
});
