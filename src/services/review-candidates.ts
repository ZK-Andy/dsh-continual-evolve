/**
 * The review queue: which stored items deserve a close look next.
 *
 * Rebuilt from the store on every drain (no cursor of its own). The decision
 * table lives here and nowhere else (ADR
 * `2026-10-17-review-and-tiering-batch-rollout`): brand-new items first, then
 * whatever a linkage event put back in front of review, then a small sample of
 * what the calendar alone would have dragged in. The calendar is a backstop,
 * never the engine — a settled item earns a longer exemption instead of a
 * fresh review every `staleDays`.
 *
 * One row whose last verdict never produced an item decision is still queued:
 * "reviewed but nothing happened" is not progress.
 */
import type { MemoryStore } from "../store.js";
import type { CandidateSource, ReviewCandidate } from "./review.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Sampling is a fifth of the batch: events keep the rest, and one is the floor. */
const SAMPLE_FRACTION = 5;

/** The queue's options: the clock (tests), the calendar window, and the bound. */
export interface CandidateQueueOptions {
	/** Clock override for tests. */
	now?: number | undefined;
	/** Days without a verdict before an item is *eligible* to be sampled. */
	staleDays?: number | undefined;
	/** Queue bound (the scheduler asks for twice the batch). */
	limit?: number | undefined;
	/** The run's batch size; the sampling quota is a fifth of it. */
	batchSize?: number | undefined;
}

/**
 * Days of exemption a keep streak buys: none under two keeps, double at two,
 * quadruple at four (the ADR's 30→60→120 with 30 as the base window).
 * @param keeps - Consecutive keeps since the last reset.
 * @returns The multiplier applied to `staleDays`.
 */
export function exemptionFactor(keeps: number): number {
	if (keeps >= 4) {
		return 4;
	}
	return keeps >= 2 ? 2 : 1;
}

/** One candidate with the age that ranks it inside the sampling tier. */
interface Sampled {
	candidate: ReviewCandidate;
	age: number;
}

/** The three tiers, kept apart until the queue is assembled. */
interface Tiers {
	fresh: ReviewCandidate[];
	linked: ReviewCandidate[];
	sampled: Sampled[];
}

/** One event-pending item filtered by the unchanged gate (P1, D7). */
export interface UnchangedEvent {
	readonly workspaceId: string;
	readonly kind: "memory" | "skill";
	readonly id: string;
}

/** The queue plus the event items the unchanged gate held back. */
export interface CandidateCollection {
	readonly candidates: ReviewCandidate[];
	readonly unchangedEvents: UnchangedEvent[];
}

/** Per-collection context: the clock, the window, and the pending-event keys. */
interface CollectContext {
	now: number;
	staleMs: number;
	/** `workspace\0kind\0id` of every item a linkage event is waiting on. */
	linked: Set<string>;
	/** The same keys for the clock tiers: probation due, promotion candidates. */
	clock: Set<string>;
	/** Event-pending items held back as unchanged (absent = uncounted). */
	unchanged?: UnchangedEvent[] | undefined;
}

/**
 * Collect review candidates across every workspace carrying active items:
 * new items first (newest first), then event-linked requeues, then up to a
 * fifth of the batch in stale samples (oldest first). Bounded by `limit`.
 * Event requeues pass the unchanged gate (P1, D7): an event-pending item
 * whose body did not change since its last complete verdict is held back
 * (counted in `collectCandidatesWithUnchanged`, invisible here).
 * @param store - The central store, sole source of the queue.
 * @param opts - Clock override, staleness window, batch size, and queue bound.
 * @returns Candidates ordered by tier.
 */
export function collectCandidates(store: MemoryStore, opts: CandidateQueueOptions = {}): ReviewCandidate[] {
	return collect(store, opts, undefined).candidates;
}

/**
 * Collect review candidates plus the event-pending items the unchanged gate
 * held back. Same queue as {@link collectCandidates}; the second half is the
 * P1 accounting surface (the scheduler logs it, no LLM is spent on it).
 * @param store - The central store, sole source of the queue.
 * @param opts - Clock override, staleness window, batch size, and queue bound.
 * @returns Candidates ordered by tier, and the held-back event items.
 */
export function collectCandidatesWithUnchanged(store: MemoryStore, opts: CandidateQueueOptions = {}): CandidateCollection {
	return collect(store, opts, []);
}

function collect(store: MemoryStore, opts: CandidateQueueOptions, unchanged: UnchangedEvent[] | undefined): CandidateCollection {
	const now = opts.now ?? Date.now();
	const limit = opts.limit ?? 100;
	const sampleCap = Math.max(1, Math.floor((opts.batchSize ?? 10) / SAMPLE_FRACTION));
	const ctx: CollectContext = {
		now,
		staleMs: (opts.staleDays ?? 30) * DAY_MS,
		linked: linkedKeys(store),
		clock: clockKeys(store),
		unchanged,
	};
	const tiers: Tiers = { fresh: [], linked: [], sampled: [] };
	for (const partition of partitionsOf(store)) {
		memoryTier(store, tiers, partition, ctx);
		if (partition !== "") {
			skillTier(store, tiers, partition, ctx, "project");
		}
	}
	// Global skills ride along once (project rows shadow them per id).
	skillTier(store, tiers, "", ctx, "global");
	const sampled = [...tiers.sampled].sort((a, b) => b.age - a.age).slice(0, sampleCap).map((row) => row.candidate);
	return { candidates: [...tiers.fresh, ...tiers.linked, ...sampled].slice(0, limit), unchangedEvents: ctx.unchanged ?? [] };
}

/**
 * Every partition that can hold a queueable item: memory partitions, skill
 * partitions, and the global one (both kinds may live there).
 * @param store - The central store.
 * @returns The partition ids, `""` last.
 */
function partitionsOf(store: MemoryStore): string[] {
	const partitions = new Set<string>();
	for (const summary of store.listWorkspaces()) {
		partitions.add(summary.workspaceId);
	}
	for (const summary of store.listSkillWorkspaces()) {
		partitions.add(summary.workspaceId);
	}
	partitions.delete("");
	return [...partitions, ""];
}

/**
 * The pending-event keys, one query for the whole drain.
 * @param store - The central store.
 * @returns The `workspace\0kind\0id` keys of items with an unconsumed event.
 */
function linkedKeys(store: MemoryStore): Set<string> {
	try {
		return new Set(store.reviewEventQueue().map((row) => `${row.workspaceId}\u0000${row.kind}\u0000${row.id}`));
	} catch {
		// An unreadable event table falls back to the calendar alone: fewer
		// requeues, never a dropped queue.
		return new Set();
	}
}

/**
 * The clock-tier keys: memories due for their probation review, and `person`
 * candidates waiting for their second judgement. Independent of `staleDays`
 * and of the sampling quota by design (`2026-10-17-…-rollout` §R3).
 * @param store - The central store.
 * @returns The `workspace\0kind\0id` keys of clock-queued memories.
 */
function clockKeys(store: MemoryStore): Set<string> {
	const keys = new Set<string>();
	const add = (rows: readonly { workspaceId: string; id: string }[]): void => {
		for (const row of rows) {
			keys.add(`${row.workspaceId}\u0000memory\u0000${row.id}`);
		}
	};
	try {
		add(store.probationQueue());
		add(store.promotionQueue());
	} catch {
		// An unreadable tiering table drops the clock tiers, never the queue.
	}
	return keys;
}

/**
 * The unchanged gate (P1, D7): an event-pending item is only requeued when
 * its body changed since its last complete verdict. Compares the row's write
 * instant against `reviewStateOf().lastTs`, which already skips incomplete
 * rows — no new state key, no watermark to reconcile. An unparseable write
 * instant reads as changed (fail open: review rather than silently skip).
 * Clock and sample tiers are exempt by design and evaluated after this.
 * @param updatedAt - The row's last write instant (ISO).
 * @param lastTs - The last complete verdict instant, null when never reviewed.
 * @returns True when the item changed since its last review.
 */
export function changedSinceReview(updatedAt: string, lastTs: string | null): boolean {
	const updated = Date.parse(updatedAt) || 0;
	if (updated === 0) {
		return true;
	}
	return updated > (Date.parse(lastTs ?? "") || 0);
}

/**
 * Fill the tiers from one partition's memories. A row named by a `corrects`
 * link counts as linked even without an event row — links written before the
 * event table shipped would otherwise be invisible to this queue forever.
 * @param store - The central store.
 * @param tiers - The tiers being filled.
 * @param workspaceId - The memory partition.
 * @param ctx - The collect context.
 */
function memoryTier(store: MemoryStore, tiers: Tiers, workspaceId: string, ctx: CollectContext): void {
	const records = store.listAll(workspaceId);
	const correctsTargets = new Set<string>();
	for (const record of records) {
		if (record.corrects !== null && record.corrects.length > 0) {
			correctsTargets.add(record.corrects);
		}
	}
	for (const record of records) {
		if (record.status !== "active") {
			continue;
		}
		const base = {
			workspaceId, kind: "memory" as const, id: record.id, title: record.title,
			description: record.description, body: record.body, memoryType: record.type,
		};
		const state = store.reviewStateOf(workspaceId, "memory", record.id);
		if (state === undefined) {
			tiers.fresh.push({ ...base, priority: 0, source: "new" });
			continue;
		}
		const key = `${workspaceId}\u0000memory\u0000${record.id}`;
		// A row named by a `corrects` link always requeues: an explicit
		// correction is new evidence about the target even when the target
		// row itself is untouched, and this branch is the pre-event-table
		// backstop that must never go blind (P1 ADR). Only pure lexical
		// events (`similar`/`correction` with no corrects link) pass the
		// unchanged gate below.
		if (correctsTargets.has(record.id)) {
			tiers.linked.push({ ...base, priority: 1, source: "event" });
			continue;
		}
		if (ctx.linked.has(key)) {
			if (changedSinceReview(record.updatedAt, state.lastTs)) {
				tiers.linked.push({ ...base, priority: 1, source: "event" });
				continue;
			}
			// Unchanged since the last verdict: held back from the event tier
			// (P1, D7), but still eligible for the exempt clock/sample tiers.
			ctx.unchanged?.push({ workspaceId, kind: "memory", id: record.id });
		}
		// Clock tiers outrank the settle exemption (rollout ADR §R1): a due
		// probation or a promotion candidate is owed a judgment on schedule.
		if (ctx.clock.has(key)) {
			tiers.linked.push({ ...base, priority: 1, source: "clock" });
			continue;
		}
		pushSample(tiers, { ...base, priority: 2, source: "sample" }, record.updatedAt, ctx, () =>
			factorOf(store, workspaceId, "memory", record.id),
		);
	}
}

/**
 * Fill the tiers from one partition's skills of one scope.
 * @param store - The central store.
 * @param tiers - The tiers being filled.
 * @param partition - The skill partition (`""` is global).
 * @param ctx - The collect context.
 * @param scope - The scope the rows carry in the queue.
 */
function skillTier(
	store: MemoryStore,
	tiers: Tiers,
	partition: string,
	ctx: CollectContext,
	scope: "project" | "global",
): void {
	const shadowed = scope === "global" ? shadowedSkills(store) : new Set<string>();
	for (const record of store.listAllSkills(partition)) {
		if (record.status !== "active" || shadowed.has(record.id)) {
			continue;
		}
		const base = {
			workspaceId: partition, kind: "skill" as const, id: record.id, title: record.title,
			description: record.description, body: record.body, scope,
		};
		const state = store.reviewStateOf(partition, "skill", record.id);
		if (state === undefined) {
			tiers.fresh.push({ ...base, priority: 0, source: "new" });
			continue;
		}
		const key = `${partition}\u0000skill\u0000${record.id}`;
		if (ctx.linked.has(key)) {
			if (changedSinceReview(record.updatedAt, state.lastTs)) {
				tiers.linked.push({ ...base, priority: 1, source: "event" });
				continue;
			}
			// Unchanged since the last verdict: held back from the event tier
			// (P1, D7), but still eligible for the exempt clock/sample tiers.
			ctx.unchanged?.push({ workspaceId: partition, kind: "skill", id: record.id });
		}
		if (ctx.clock.has(key)) {
			tiers.linked.push({ ...base, priority: 1, source: "clock" });
			continue;
		}
		pushSample(tiers, { ...base, priority: 2, source: "sample" }, record.updatedAt, ctx, () =>
			factorOf(store, partition, "skill", record.id),
		);
	}
}

/**
 * The active project skill ids, which shadow same-id global rows.
 * @param store - The central store.
 * @returns Every active project id.
 */
function shadowedSkills(store: MemoryStore): Set<string> {
	const ids = new Set<string>();
	for (const summary of store.listSkillWorkspaces()) {
		if (summary.workspaceId === "") {
			continue;
		}
		for (const record of store.listAllSkills(summary.workspaceId)) {
			// Archived rows shadow nothing (the card shows the global row once a
			// project row archives after a move-to-global).
			if (record.status === "active") {
				ids.add(record.id);
			}
		}
	}
	return ids;
}

/**
 * Queue one candidate for sampling when the calendar window — stretched by
 * the item's keep streak — has passed. The streak read is lazy: only items
 * already past the base window pay for it, which keeps a drain over thousands
 * of settled rows at one query per row instead of three.
 * @param tiers - The tiers being filled.
 * @param candidate - The candidate at tier 2.
 * @param updatedAt - The row's last write instant.
 * @param ctx - The collect context.
 * @param factor - Reads the streak's exemption multiplier.
 */
function pushSample(
	tiers: Tiers,
	candidate: ReviewCandidate,
	updatedAt: string,
	ctx: CollectContext,
	factor: () => number,
): void {
	const age = ctx.now - (Date.parse(updatedAt) || 0);
	if (age >= ctx.staleMs * factor()) {
		tiers.sampled.push({ candidate, age });
	}
}

/**
 * The exemption multiplier for one item. A derived read that fails reads as
 * "no streak": the calendar then uses its base window, which reviews sooner.
 * @param store - The central store.
 * @param workspaceId - The item's partition.
 * @param kind - Memory or skill.
 * @param id - The item id.
 * @returns The multiplier from {@link exemptionFactor}.
 */
function factorOf(store: MemoryStore, workspaceId: string, kind: "memory" | "skill", id: string): number {
	try {
		return exemptionFactor(store.reviewSettled(workspaceId, kind, id).keeps);
	} catch {
		return 1;
	}
}

/** Re-exported shape so callers describe the same union the queue writes. */
export type { CandidateSource };
