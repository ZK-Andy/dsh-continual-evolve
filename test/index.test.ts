import { describe, expect, it } from "vitest";
import { automaticEvolutionWired } from "../src/index.js";

describe("automatic evolution wiring policy", () => {
	it("keeps automatic listeners disconnected unless explicitly opted in", () => {
		expect(automaticEvolutionWired({})).toBe(false);
		expect(automaticEvolutionWired({ autoReview: false })).toBe(false);
	});

	it("registers the Memory Agent listener only for an explicit true opt-in", () => {
		expect(automaticEvolutionWired({ autoReview: true })).toBe(true);
	});
});
