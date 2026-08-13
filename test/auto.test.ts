/**
 * Tests for the gate turn counter: completed turns are counted from
 * running → idle transitions only.
 */
import { describe, expect, it } from "vitest";
import { advanceGateState, type GateState } from "../src/auto.js";

function fresh(): GateState {
	return { turns: 0, lastReviewAt: 0, running: false };
}

describe("advanceGateState", () => {
	it("counts one turn per running → idle transition", () => {
		const state = fresh();
		expect(advanceGateState(state, "running")).toBe(false);
		expect(advanceGateState(state, "idle")).toBe(true);
		expect(state.turns).toBe(1);
		expect(advanceGateState(state, "running")).toBe(false);
		expect(advanceGateState(state, "idle")).toBe(true);
		expect(state.turns).toBe(2);
	});

	it("ignores duplicate idle emissions without an intervening running", () => {
		const state = fresh();
		advanceGateState(state, "running");
		expect(advanceGateState(state, "idle")).toBe(true);
		expect(advanceGateState(state, "idle")).toBe(false);
		expect(state.turns).toBe(1);
	});

	it("ignores initial idle before any running", () => {
		const state = fresh();
		expect(advanceGateState(state, "idle")).toBe(false);
		expect(state.turns).toBe(0);
	});

	it("ignores unknown statuses", () => {
		const state = fresh();
		expect(advanceGateState(state, "bogus")).toBe(false);
		expect(state.turns).toBe(0);
	});
});
