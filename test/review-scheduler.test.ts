import { describe, expect, it, vi } from "vitest";
import { compareReviewCursors, createReviewScheduler, type ReviewSchedulerStatus } from "../src/review-scheduler.js";

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

	it("contains an execute throw without advancing the cursor", async () => {
		let calls = 0;
		const scheduler = createReviewScheduler<Item>(
			async () => {
				calls += 1;
				throw new Error("extract offline");
			},
			(snapshot) => snapshot.cursor,
		);
		scheduler.schedule({ cursor: "seq:1" });
		await scheduler.drain();
		expect(calls).toBe(1);
		expect(scheduler.getCursor()).toBeUndefined();
		expect(scheduler.hasPendingWork()).toBe(false);
	});

	it("skips a stale snapshot below the cursor", async () => {
		const started: string[] = [];
		const scheduler = createReviewScheduler<Item>(
			async ({ snapshot }) => {
				started.push(snapshot.cursor);
				return "success";
			},
			(snapshot) => snapshot.cursor,
		);
		scheduler.schedule({ cursor: "seq:5" });
		await scheduler.drain();
		scheduler.schedule({ cursor: "seq:3" });
		await scheduler.drain();
		expect(started).toEqual(["seq:5"]);
		expect(scheduler.getCursor()).toBe("seq:5");
	});

	it("ignores schedules after shutdown and tolerates a second shutdown", async () => {
		const started: string[] = [];
		const scheduler = createReviewScheduler<Item>(
			async ({ snapshot }) => {
				started.push(snapshot.cursor);
				return "success";
			},
			(snapshot) => snapshot.cursor,
		);
		scheduler.shutdown();
		scheduler.shutdown();
		scheduler.schedule({ cursor: "seq:1" });
		await scheduler.drain();
		expect(started).toEqual([]);
		expect(scheduler.hasPendingWork()).toBe(false);
	});

	it("bounds pending acquisitions under a burst and runs the highest", async () => {
		const started: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const scheduler = createReviewScheduler<Item>(
			async ({ snapshot }) => {
				started.push(snapshot.cursor);
				if (snapshot.cursor === "seq:0") {
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
				}
				return "success";
			},
			(snapshot) => snapshot.cursor,
		);
		scheduler.schedule({ cursor: "seq:0" });
		await vi.waitFor(() => expect(started).toEqual(["seq:0"]));
		for (let n = 1; n <= 18; n += 1) scheduler.schedule({ cursor: `seq:${n}` });
		releaseFirst?.();
		await scheduler.drain();
		expect(started).toEqual(["seq:0", "seq:18"]);
		expect(scheduler.getCursor()).toBe("seq:18");
	});

	it("prunes rejected pending acquisitions and runs the highest survivor", async () => {
		const started: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const scheduler = createReviewScheduler<Item>(
			async ({ snapshot }) => {
				started.push(snapshot.cursor);
				if (snapshot.cursor === "seq:0") {
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
				}
				return "success";
			},
			(snapshot) => snapshot.cursor,
		);
		scheduler.schedule({ cursor: "seq:0" });
		await vi.waitFor(() => expect(started).toEqual(["seq:0"]));
		scheduler.schedule(Promise.reject(new Error("capture lost")));
		scheduler.schedule({ cursor: "seq:2" });
		releaseFirst?.();
		await scheduler.drain();
		expect(started).toEqual(["seq:0", "seq:2"]);
		expect(scheduler.getCursor()).toBe("seq:2");
	});

	it("replaces the best candidate when a later pending boundary is higher", async () => {
		const started: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const scheduler = createReviewScheduler<Item>(
			async ({ snapshot }) => {
				started.push(snapshot.cursor);
				if (snapshot.cursor === "seq:0") {
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
				}
				return "success";
			},
			(snapshot) => snapshot.cursor,
		);
		scheduler.schedule({ cursor: "seq:0" });
		await vi.waitFor(() => expect(started).toEqual(["seq:0"]));
		scheduler.schedule({ cursor: "seq:2" });
		scheduler.schedule({ cursor: "seq:5" });
		releaseFirst?.();
		await scheduler.drain();
		expect(started).toEqual(["seq:0", "seq:5"]);
		expect(scheduler.getCursor()).toBe("seq:5");
	});

	it("waits for an unsettled acquisition instead of dropping it", async () => {
		const started: string[] = [];
		let releaseFirst: (() => void) | undefined;
		let resolvePending: ((item: Item) => void) | undefined;
		const scheduler = createReviewScheduler<Item>(
			async ({ snapshot }) => {
				started.push(snapshot.cursor);
				if (snapshot.cursor === "seq:0") {
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
				}
				return "success";
			},
			(snapshot) => snapshot.cursor,
		);
		scheduler.schedule({ cursor: "seq:0" });
		await vi.waitFor(() => expect(started).toEqual(["seq:0"]));
		const pending = new Promise<Item>((resolve) => {
			resolvePending = resolve;
		});
		scheduler.schedule(pending);
		releaseFirst?.();
		await new Promise((resolve) => setTimeout(resolve, 20));
		resolvePending?.({ cursor: "seq:9" });
		await scheduler.drain();
		expect(started).toEqual(["seq:0", "seq:9"]);
		expect(scheduler.getCursor()).toBe("seq:9");
	});

	it("aborts a first acquisition still waiting on shutdown", async () => {
		const scheduler = createReviewScheduler<Item>(
			async () => "success" as ReviewSchedulerStatus,
			(snapshot) => snapshot.cursor,
		);
		scheduler.schedule(new Promise<Item>(() => {}));
		await new Promise((resolve) => setTimeout(resolve, 10));
		scheduler.shutdown();
		await scheduler.drain();
		expect(scheduler.getCursor()).toBeUndefined();
		expect(scheduler.hasPendingWork()).toBe(false);
	});

	it("wakes a pending waiter on shutdown and drops everything", async () => {
		const started: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const scheduler = createReviewScheduler<Item>(
			async ({ snapshot }) => {
				started.push(snapshot.cursor);
				if (snapshot.cursor === "seq:0") {
					await new Promise<void>((resolve) => {
						releaseFirst = resolve;
					});
				}
				return "success";
			},
			(snapshot) => snapshot.cursor,
		);
		scheduler.schedule({ cursor: "seq:0" });
		await vi.waitFor(() => expect(started).toEqual(["seq:0"]));
		scheduler.schedule(new Promise<Item>(() => {}));
		releaseFirst?.();
		await new Promise((resolve) => setTimeout(resolve, 20));
		scheduler.shutdown();
		await scheduler.drain();
		expect(started).toEqual(["seq:0"]);
		// The completed first snapshot keeps its cursor; the unsettled
		// pending acquisition is dropped, never executed.
		expect(scheduler.getCursor()).toBe("seq:0");
		expect(scheduler.hasPendingWork()).toBe(false);
	});
});

describe("compareReviewCursors", () => {
	it("orders identical cursors as zero", () => {
		expect(compareReviewCursors("seq:3", "seq:3")).toBe(0);
		expect(compareReviewCursors("anything", "anything")).toBe(0);
	});

	it("orders seq cursors numerically", () => {
		expect(compareReviewCursors("seq:2", "seq:10")).toBeLessThan(0);
		expect(compareReviewCursors("seq:10", "seq:2")).toBeGreaterThan(0);
	});

	it("orders index cursors numerically", () => {
		expect(compareReviewCursors("index:1", "index:2")).toBeLessThan(0);
		expect(compareReviewCursors("index:2", "index:1")).toBeGreaterThan(0);
	});

	it("returns undefined across families and for non-cursor strings", () => {
		expect(compareReviewCursors("seq:1", "index:1")).toBeUndefined();
		expect(compareReviewCursors("one", "three")).toBeUndefined();
		expect(compareReviewCursors("seq:1", "three")).toBeUndefined();
	});
});
