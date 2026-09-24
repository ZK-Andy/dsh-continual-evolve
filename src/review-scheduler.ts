/**
 * Serial latest-pending scheduler for automatic review snapshots.
 *
 * This is the DSH equivalent of ZCode's memory extraction scheduler: one
 * runner per session, at most one running snapshot, and one replaceable
 * pending snapshot while the runner is busy. A cursor advances only after a
 * successful or no-op execution; errors and aborts leave it untouched so the
 * next snapshot retries the same durable boundary.
 */

/** Terminal state of one scheduled snapshot. */
export type ReviewSchedulerStatus = "success" | "no-op" | "error" | "aborted";

/** A scheduler execution receives the exact snapshot and its owner signal. */
export interface ReviewSchedulerExecution<TSnapshot> {
	readonly snapshot: TSnapshot;
	readonly signal: AbortSignal;
}

/** Public scheduler surface used by the auto-review driver and tests. */
export interface ReviewScheduler<TSnapshot> {
	/** Wait until the current run and all coalesced pending work settle. */
	drain(): Promise<void>;
	/** Last successfully processed or skipped snapshot boundary. */
	getCursor(): string | undefined;
	/** Whether a run or a replaceable pending snapshot exists. */
	hasPendingWork(): boolean;
	/** Submit a snapshot (or an async acquisition) without blocking the caller. */
	schedule(snapshot: TSnapshot | Promise<TSnapshot>): void;
	/** Abort the owner signal, drop pending work, and make later schedules no-ops. */
	shutdown(): void;
}

type SnapshotAcquisition<TSnapshot> =
	| { readonly status: "acquired"; readonly snapshot: TSnapshot }
	| { readonly status: "error" };

/**
 * Create a scheduler with ZCode-compatible coalescing and cursor semantics.
 *
 * @param execute - one serial extraction/review operation
 * @param cursorOf - extracts the durable boundary from a snapshot
 */
export function createReviewScheduler<TSnapshot>(
	execute: (input: ReviewSchedulerExecution<TSnapshot>) => Promise<ReviewSchedulerStatus>,
	cursorOf: (snapshot: TSnapshot) => string | undefined,
): ReviewScheduler<TSnapshot> {
	let cursor: string | undefined;
	let latestPending: Promise<SnapshotAcquisition<TSnapshot>> | undefined;
	let running: Promise<void> | undefined;
	let shuttingDown = false;
	const shutdownController = new AbortController();

	const processSnapshot = async (snapshot: TSnapshot): Promise<void> => {
		if (shuttingDown || shutdownController.signal.aborted) return;
		let status: ReviewSchedulerStatus;
		try {
			status = await execute({ snapshot, signal: shutdownController.signal });
		} catch {
			// A failed acquisition/extraction is deliberately contained. The
			// cursor remains unchanged and the next snapshot retries it.
			return;
		}
		if (!shuttingDown && (status === "success" || status === "no-op")) {
			cursor = cursorOf(snapshot);
		}
	};

	const run = async (first: Promise<SnapshotAcquisition<TSnapshot>>): Promise<void> => {
		try {
			let current: Promise<SnapshotAcquisition<TSnapshot>> | undefined = first;
			while (current && !shuttingDown) {
				const acquisition = await waitForSnapshotAcquisitionOrShutdown(current, shutdownController.signal);
				if (acquisition.status === "shutdown" || shuttingDown) break;
				if (acquisition.status === "acquired") {
					await processSnapshot(acquisition.snapshot);
				}
				current = shuttingDown ? undefined : latestPending;
				latestPending = undefined;
			}
		} finally {
			if (shuttingDown) latestPending = undefined;
			running = undefined;
		}
	};

	return {
		async drain() {
			while (running) {
				await running;
			}
		},
		getCursor() {
			return cursor;
		},
		hasPendingWork() {
			return running !== undefined || latestPending !== undefined;
		},
		schedule(snapshot) {
			if (shuttingDown) return;
			const acquisition = acquireSnapshot(snapshot);
			if (running) {
				// Replace, never queue: a burst of turns contributes one latest
				// boundary and the next extraction consumes all intervening rows.
				latestPending = acquisition;
				return;
			}
			running = run(acquisition);
		},
		shutdown() {
			if (shuttingDown) return;
			shuttingDown = true;
			latestPending = undefined;
			shutdownController.abort();
		},
	};
}

function acquireSnapshot<TSnapshot>(snapshot: TSnapshot | Promise<TSnapshot>): Promise<SnapshotAcquisition<TSnapshot>> {
	return Promise.resolve(snapshot).then(
		(value) => ({ status: "acquired", snapshot: value }),
		() => ({ status: "error" }),
	);
}

type SnapshotAcquisitionWait<TSnapshot> = SnapshotAcquisition<TSnapshot> | { readonly status: "shutdown" };

function waitForSnapshotAcquisitionOrShutdown<TSnapshot>(
	acquisition: Promise<SnapshotAcquisition<TSnapshot>>,
	signal: AbortSignal,
): Promise<SnapshotAcquisitionWait<TSnapshot>> {
	if (signal.aborted) return Promise.resolve({ status: "shutdown" });
	return new Promise((resolve) => {
		const cleanup = (): void => signal.removeEventListener("abort", onAbort);
		const onAbort = (): void => {
			cleanup();
			resolve({ status: "shutdown" });
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void acquisition.then((result) => {
			cleanup();
			resolve(result);
		});
	});
}
