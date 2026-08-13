/**
 * Tests for the bounded-concurrency pool used by the evaluation matrix.
 */
import { describe, expect, it } from "vitest";
import { mapPool } from "../src/pool.js";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("mapPool", () => {
	it("maps all items and preserves order", async () => {
		const out = await mapPool([1, 2, 3, 4], 2, async (n) => n * 10);
		expect(out).toEqual([10, 20, 30, 40]);
	});

	it("never exceeds the concurrency limit", async () => {
		let inFlight = 0;
		let peak = 0;
		await mapPool([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await delay(5);
			inFlight -= 1;
			return peak;
		});
		expect(peak).toBe(3);
	});

	it("handles empty input", async () => {
		expect(await mapPool([], 4, async (n: number) => n)).toEqual([]);
	});

	it("propagates worker errors", async () => {
		await expect(mapPool([1, 2], 2, async () => {
			throw new Error("boom");
		})).rejects.toThrow("boom");
	});
});
