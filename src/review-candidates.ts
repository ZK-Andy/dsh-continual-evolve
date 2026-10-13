/**
 * The review queue: which stored items are due for a close look.
 *
 * The queue is rebuilt from the store on every drain (no cursor of its own):
 * new items first, then corrects-linked requeues, then items untouched past
 * the staleness window. One row whose last verdict never produced an item
 * decision is still queued — "reviewed but nothing happened" is not progress.
 */
import type { MemoryStore } from "./store.js";
import type { ReviewCandidate } from "./review.js";

/**
 * Collect review candidates across every workspace carrying active items:
 * new items first (newest first), then corrects-linked requeues, then stale
 * requeues (`staleDays`, default 30). Bounded by `limit`.
 *
 * @param store - The central store, sole source of the queue.
 * @param opts - Clock override (tests), staleness window, and queue bound.
 * @returns Candidates ordered by priority.
 */
export function collectCandidates(store: MemoryStore, opts: { now?: number | undefined; staleDays?: number | undefined; limit?: number | undefined } = {}): ReviewCandidate[] {
	const now = opts.now ?? Date.now();
	const staleMs = (opts.staleDays ?? 30) * 24 * 60 * 60 * 1000;
	const limit = opts.limit ?? 100;
	const fresh: ReviewCandidate[] = [];
	const requeued: ReviewCandidate[] = [];
	const stale: ReviewCandidate[] = [];
	// One push per enumerated row: store primary keys make (workspace, kind,
	// id) unique, so no dedup set is needed — a duplicate here would mean a
	// store invariant broke, and failing loud beats silently merging.
	const push = (candidate: ReviewCandidate): void => {
		(candidate.priority === 0 ? fresh : candidate.priority === 1 ? requeued : stale).push(candidate);
	};
	const partitions = new Set<string>();
	for (const summary of store.listWorkspaces()) {
		partitions.add(summary.workspaceId);
	}
	for (const summary of store.listSkillWorkspaces()) {
		partitions.add(summary.workspaceId);
	}
	partitions.add("");
	for (const workspaceId of partitions) {
		const correctsTargets = new Set<string>();
		const memories = store.listAll(workspaceId);
		for (const record of memories) {
			if (record.corrects !== null && record.corrects.length > 0) {
				correctsTargets.add(record.corrects);
			}
		}
		for (const record of memories) {
			if (record.status !== "active") {
				continue;
			}
			const state = store.reviewStateOf(workspaceId, "memory", record.id);
			const updatedAt = Date.parse(record.updatedAt) || 0;
			if (state === undefined) {
				push({ workspaceId, kind: "memory", id: record.id, priority: 0, title: record.title, description: record.description, body: record.body, memoryType: record.type });
			} else if (correctsTargets.has(record.id)) {
				push({ workspaceId, kind: "memory", id: record.id, priority: 1, title: record.title, description: record.description, body: record.body, memoryType: record.type });
			} else if (now - updatedAt >= staleMs) {
				push({ workspaceId, kind: "memory", id: record.id, priority: 2, title: record.title, description: record.description, body: record.body, memoryType: record.type });
			}
		}
		const projectSeen = new Set<string>();
		const skillsOf = (partition: string, scope: "project" | "global"): void => {
			for (const record of store.listAllSkills(partition)) {
				if (record.status !== "active" || projectSeen.has(record.id)) {
					continue;
				}
				projectSeen.add(record.id);
				const state = store.reviewStateOf(partition, "skill", record.id);
				const updatedAt = Date.parse(record.updatedAt) || 0;
				const candidate: ReviewCandidate = {
					workspaceId: partition, kind: "skill", id: record.id,
					priority: state === undefined ? 0 : 2,
					title: record.title, description: record.description, body: record.body, scope,
				};
				if (state === undefined || now - updatedAt >= staleMs) {
					push(candidate);
				}
			}
		};
		if (workspaceId !== "") {
			skillsOf(workspaceId, "project");
		}
	}
	// Global skills ride along once (project rows shadow them per id).
	skillsGlobal(store, now, staleMs, push);
	const byPriority = (a: ReviewCandidate, b: ReviewCandidate): number => (a.priority - b.priority);
	return [...fresh, ...requeued, ...stale].sort(byPriority).slice(0, limit);
}

/** The global partition's skills, minus every id an active project row shadows. */
function skillsGlobal(
	store: MemoryStore,
	now: number,
	staleMs: number,
	push: (candidate: ReviewCandidate) => void,
): void {
	const projectIds = new Set<string>();
	for (const summary of store.listSkillWorkspaces()) {
		if (summary.workspaceId === "") {
			continue;
		}
		for (const record of store.listAllSkills(summary.workspaceId)) {
			// Archived rows shadow nothing (readWithScope shows the global
			// row once the project row archives after a move-to-global).
			if (record.status === "active") {
				projectIds.add(record.id);
			}
		}
	}
	for (const record of store.listAllSkills("")) {
		if (record.status !== "active" || projectIds.has(record.id)) {
			continue;
		}
		const state = store.reviewStateOf("", "skill", record.id);
		const updatedAt = Date.parse(record.updatedAt) || 0;
		if (state === undefined || now - updatedAt >= staleMs) {
			push({
				workspaceId: "", kind: "skill", id: record.id,
				priority: state === undefined ? 0 : 2,
				title: record.title, description: record.description, body: record.body, scope: "global",
			});
		}
	}
}
