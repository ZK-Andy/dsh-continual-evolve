/**
 * Serial latest-boundary scheduler for automatic memory+review snapshots.
 *
 * One runner exists per session. A burst is coalesced by durable cursor rather
 * than promise arrival: once multiple pending captures settle, the highest
 * comparable boundary runs first. A cursor advances only after success/no-op;
 * errors, aborts, and stale boundaries leave it unchanged.
 */

/** Compare two scheduler cursors; undefined means the cursor families differ. */
export function compareReviewCursors(left: string, right: string): number | undefined {
	if (left === right) return 0;
	const leftMatch = /^(seq|index):(\d+)$/.exec(left);
	const rightMatch = /^(seq|index):(\d+)$/.exec(right);
	if (!leftMatch || !rightMatch || leftMatch[1] !== rightMatch[1]) return undefined;
	return Number(leftMatch[2]) - Number(rightMatch[2]);
}

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
	/** Whether a run or a pending acquisition exists. */
	hasPendingWork(): boolean;
	/** Submit a snapshot (or an async acquisition) without blocking the caller. */
	schedule(snapshot: TSnapshot | Promise<TSnapshot>): void;
	/** Abort the owner signal, drop pending work, and make later schedules no-ops. */
	shutdown(): void;
}

type SnapshotAcquisition<TSnapshot> =
	| { readonly status: "acquired"; readonly snapshot: TSnapshot }
	| { readonly status: "error" };

interface PendingEntry<TSnapshot> {
	promise: Promise<SnapshotAcquisition<TSnapshot>>;
	result?: SnapshotAcquisition<TSnapshot>;
}

/** Bound unresolved acquisitions; actual auto capture is serialized per session. */
const MAX_PENDING_ACQUISITIONS = 16;

/**
 * Create a scheduler with ZCode-compatible serial/coalescing semantics.
 *
 * @param execute - one serial extraction/review operation
 * @param cursorOf - extracts the durable boundary from a snapshot
 */
export function createReviewScheduler<TSnapshot>(
	execute: (input: ReviewSchedulerExecution<TSnapshot>) => Promise<ReviewSchedulerStatus>,
	cursorOf: (snapshot: TSnapshot) => string | undefined,
): ReviewScheduler<TSnapshot> {
	let cursor: string | undefined;
	let running: Promise<void> | undefined;
	let shuttingDown = false;
	let wakePending: (() => void) | undefined;
	const pending: Array<PendingEntry<TSnapshot>> = [];
	const shutdownController = new AbortController();
	const signal = shutdownController.signal;

	const trackPending = (acquisition: Promise<SnapshotAcquisition<TSnapshot>>): void => {
		const entry = {} as PendingEntry<TSnapshot>;
		entry.promise = acquisition.then((result) => {
			entry.result = result;
			wakePending?.();
			return result;
		});
		pending.push(entry);
		while (pending.length > MAX_PENDING_ACQUISITIONS) pending.shift();
	};

	const takeHighestPending = async (): Promise<SnapshotAcquisition<TSnapshot> | undefined> => {
		while (!signal.aborted) {
			for (let index = pending.length - 1; index >= 0; index -= 1) {
				if (pending[index]?.result?.status === "error") pending.splice(index, 1);
			}
			if (pending.length === 0) return undefined;
			const settled = pending.filter((entry) => entry.result !== undefined);
			if (settled.length > 0) {
				let bestIndex = -1;
				let bestCursor: string | undefined;
				for (let index = 0; index < settled.length; index += 1) {
					const entry = settled[index];
					if (!entry || entry.result?.status !== "acquired") continue;
					const candidate = cursorOf(entry.result.snapshot);
					const order = bestCursor === undefined || candidate === undefined
						? 1
						: compareReviewCursors(candidate, bestCursor);
					if (bestIndex < 0 || order === undefined || order > 0) {
						bestIndex = pending.indexOf(entry);
						bestCursor = candidate;
					}
				}
				// bestIndex is always set here: the error purge above leaves only
				// acquired snapshots in `settled` (SnapshotAcquisition has exactly
				// two variants), so the first settled entry takes the slot.
				const chosen = pending[bestIndex];
				pending.splice(bestIndex, 1);
				for (let index = pending.length - 1; index >= 0; index -= 1) {
					if (pending[index]?.result !== undefined) pending.splice(index, 1);
				}
				return chosen?.result;
			}
			await new Promise<void>((resolve) => {
				const cleanup = (): void => signal.removeEventListener("abort", onAbort);
				const onAbort = (): void => {
					cleanup();
					resolve();
				};
				wakePending = () => {
					cleanup();
					wakePending = undefined;
					resolve();
				};
				signal.addEventListener("abort", onAbort, { once: true });
			});
		}
		return undefined;
	};

	const processSnapshot = async (snapshot: TSnapshot): Promise<void> => {
		if (shuttingDown || signal.aborted) return;
		const nextCursor = cursorOf(snapshot);
		if (cursor !== undefined && nextCursor !== undefined) {
			const order = compareReviewCursors(nextCursor, cursor);
			if (order !== undefined && order <= 0) return;
		}
		let status: ReviewSchedulerStatus;
		try {
			status = await execute({ snapshot, signal });
		} catch {
			return;
		}
		if (!shuttingDown && (status === "success" || status === "no-op") && nextCursor !== undefined) {
			const order = cursor === undefined ? 1 : compareReviewCursors(nextCursor, cursor);
			if (order === undefined || order > 0) cursor = nextCursor;
		}
	};

	const run = async (first: Promise<SnapshotAcquisition<TSnapshot>>): Promise<void> => {
		try {
			let acquisition = await waitForSnapshotAcquisitionOrShutdown(first, signal);
			while (acquisition.status !== "shutdown" && !shuttingDown) {
				if (acquisition.status === "acquired") await processSnapshot(acquisition.snapshot);
				const next = await takeHighestPending();
				if (!next) break;
				acquisition = next;
			}
		} finally {
			if (shuttingDown) {
				pending.length = 0;
				wakePending?.();
				wakePending = undefined;
			}
			running = undefined;
		}
	};

	return {
		async drain() {
			while (running) await running;
		},
		getCursor() {
			return cursor;
		},
		hasPendingWork() {
			return running !== undefined || pending.length > 0;
		},
		schedule(snapshot) {
			if (shuttingDown) return;
			const acquisition = acquireSnapshot(snapshot);
			if (running) trackPending(acquisition);
			else running = run(acquisition);
		},
		shutdown() {
			if (shuttingDown) return;
			shuttingDown = true;
			pending.length = 0;
			shutdownController.abort();
			wakePending?.();
			wakePending = undefined;
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
