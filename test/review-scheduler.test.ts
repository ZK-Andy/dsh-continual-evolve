import { describe, expect, it, vi } from "vitest";
import { createReviewScheduler, type ReviewSchedulerStatus } from "../src/review-scheduler.js";

interface Item {
	readonly cursor: string;
}

describe("createReviewScheduler", () => {
	it("runs serially and keeps only the latest pending snapshot", async () => {
		const started: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const scheduler = createReviewScheduler<Item>(
			async ({ snapshot }) => {
				started.push(snapshot.cursor);
				if (snapshot.cursor === "one") {
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
				}
				return "success";
			},
			(snapshot) => snapshot.cursor,
		);

		scheduler.schedule({ cursor: "one" });
		await vi.waitFor(() => expect(started).toEqual(["one"]));
		scheduler.schedule({ cursor: "two" });
		scheduler.schedule({ cursor: "three" });
		expect(scheduler.hasPendingWork()).toBe(true);
		releaseFirst?.();
		await scheduler.drain();

		expect(started).toEqual(["one", "three"]);
		expect(scheduler.getCursor()).toBe("three");
		expect(scheduler.hasPendingWork()).toBe(false);
	});

	it("selects the highest pending boundary when acquisitions settle out of order", async () => {
		const started: string[] = [];
		let releaseFirst: (() => void) | undefined;
		let resolveThird: ((item: Item) => void) | undefined;
		let resolveSecond: ((item: Item) => void) | undefined;
		const scheduler = createReviewScheduler<Item>(
			async ({ snapshot }) => {
				started.push(snapshot.cursor);
				if (snapshot.cursor === "seq:1") {
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
				}
				return "success";
			},
			(snapshot) => snapshot.cursor,
		);

		scheduler.schedule({ cursor: "seq:1" });
		await vi.waitFor(() => expect(started).toEqual(["seq:1"]));
		const third = new Promise<Item>((resolve) => {
			resolveThird = resolve;
		});
		const second = new Promise<Item>((resolve) => {
			resolveSecond = resolve;
		});
		scheduler.schedule(third);
		scheduler.schedule(second);
		resolveThird?.({ cursor: "seq:3" });
		await Promise.resolve();
		resolveSecond?.({ cursor: "seq:2" });
		releaseFirst?.();
		await scheduler.drain();

		expect(started).toEqual(["seq:1", "seq:3"]);
		expect(scheduler.getCursor()).toBe("seq:3");
	});

	it("does not advance the cursor after an error and retries a later snapshot", async () => {
		let attempt = 0;
		const scheduler = createReviewScheduler<Item>(
			async () => {
				attempt += 1;
				return attempt === 1 ? "error" : "success";
			},
			(snapshot) => snapshot.cursor,
		);

		scheduler.schedule({ cursor: "failed-boundary" });
		await scheduler.drain();
		expect(scheduler.getCursor()).toBeUndefined();

		scheduler.schedule({ cursor: "retry-boundary" });
		await scheduler.drain();
		expect(scheduler.getCursor()).toBe("retry-boundary");
	});

	it("aborts an in-flight execution on shutdown and drops pending work", async () => {
		let started = false;
		let observedAbort = false;
		const scheduler = createReviewScheduler<Item>(
			async ({ signal }) => {
				started = true;
				await new Promise<void>((resolve) => {
					signal.addEventListener("abort", () => {
						observedAbort = true;
						resolve();
					}, { once: true });
				});
				return signal.aborted ? "aborted" : "success";
			},
			(snapshot) => snapshot.cursor,
		);

		scheduler.schedule({ cursor: "running" });
		await vi.waitFor(() => expect(started).toBe(true));
		scheduler.schedule({ cursor: "pending" });
		scheduler.shutdown();
		await scheduler.drain();

		expect(observedAbort).toBe(true);
		expect(scheduler.getCursor()).toBeUndefined();
		expect(scheduler.hasPendingWork()).toBe(false);
	});

	it("contains rejected snapshot acquisition without rejecting the caller", async () => {
		const scheduler = createReviewScheduler<Item>(
			async () => "success" as ReviewSchedulerStatus,
			(snapshot) => snapshot.cursor,
		);
		scheduler.schedule(Promise.reject(new Error("read failed")));
		await expect(scheduler.drain()).resolves.toBeUndefined();
		expect(scheduler.getCursor()).toBeUndefined();
	});
});
