/**
 * The tiering exits of the review ring (`2026-10-13-memory-tiering-and-promotion`,
 * `2026-10-17-review-and-tiering-batch-rollout` §R2): archive, promote, demote,
 * and the probation resolution a `keep` verdict triggers.
 *
 * Every exit writes one verdict row in the partition the move happened in, and
 * that row is also the "already judged" marker: a promoted row is not brand
 * new (it keeps its history), an archived row leaves every queue, and a demoted
 * row does not look like a drop-in on its way back. Nothing here deletes: the
 * archive is a status bit and the source row keeps its body.
 */
import type { ReviewItem } from "./review-ring.js";
import { evolveCountOf, proposedOf, rowBaseOf } from "./review-row.js";

/** Verdicts only a memory can carry — the skill rubric never offers them. */
const MEMORY_ONLY = new Set(["promote", "demote", "archive", "export-suggestion"]);

/** The exits whose landing is advice only: the ledger row is the whole change. */
const ADVICE_ONLY = new Set(["export-suggestion"]);

/**
 * Land the exits that move a memory between layers or out of the queue.
 * @param item - The review item whose verdict asked for a move.
 * @param verdict - The verdict this item produced.
 * @returns True when the verdict was one of the tiering exits and is handled.
 */
export function landTieringExit(
	item: ReviewItem,
	verdict: "archive" | "promote" | "demote" | "keep" | "export-suggestion",
): boolean {
	if (item.candidate.kind === "skill" && MEMORY_ONLY.has(verdict)) {
		item.deps.store.logReview({
			...rowBaseOf(item), verdict: "skip", reason: `verdict-not-applicable: ${verdict}`,
			cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage, applied: 0,
		});
		item.skipReasons.push("verdict-not-applicable");
		return true;
	}
	if (verdict === "keep") {
		return landProbationKeep(item);
	}
	if (ADVICE_ONLY.has(verdict)) {
		// "This belongs in the repo's docs" is a suggestion a human acts on:
		// writing into the user's repository would bypass its ADR flow and doc
		// gates, so the row only marks the item for the card.
		item.deps.store.logReview({
			...rowBaseOf(item), verdict: "export-suggestion",
			reason: item.evolved?.reason ?? "内容对，但家该是仓库文档",
			cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage, applied: 0,
			evolveCount: evolveCountOf(item.deps.store, item.candidate),
		});
		return true;
	}
	if (verdict === "promote") {
		landPromote(item);
		return true;
	}
	if (verdict === "demote") {
		landDemote(item);
		return true;
	}
	landArchive(item);
	return true;
}

/** `promote`: move a `person` candidate into the global partition (on probation). */
function landPromote(item: ReviewItem): void {
	const { deps, candidate, opts, summary } = item;
	const prior = evolveCountOf(deps.store, candidate);
	const record = deps.store.get(candidate.workspaceId, candidate.id);
	const scope = record?.scope ?? "project";
	if (scope !== "person") {
		deps.store.logReview({
			...rowBaseOf(item), verdict: "promote", reason: "不是 person 候选，未提级（记录时判定与审查时判定不一致）",
			cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage, applied: 0, evolveCount: prior,
		});
		return;
	}
	if (opts.dryRun) {
		deps.store.logReview({
			...rowBaseOf(item), verdict: "promote", reason: `试运行未提级：${item.evolved?.reason ?? ""}`,
			cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage, applied: 0, evolveCount: prior,
		});
		return;
	}
	const outcome = deps.store.promoteMemory(candidate.workspaceId, candidate.id);
	deps.store.logReview({
		...rowBaseOf(item), verdict: "promote",
		reason: outcome.ok ? (item.evolved?.reason ?? "提级到全局") : `提级未落地：${outcome.reason ?? "未知原因"}`,
		cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage,
		applied: outcome.ok ? 1 : 0, evolveCount: outcome.ok ? prior + 1 : prior,
	});
	if (outcome.ok) {
		summary.applied += 1;
	}
}

/** `demote`: return a mis-homed global row to the partition it came from. */
function landDemote(item: ReviewItem): void {
	const { deps, candidate, opts, summary } = item;
	const prior = evolveCountOf(deps.store, candidate);
	if (candidate.workspaceId !== "" && !opts.dryRun) {
		// Not a global row: there is nothing to demote (the item is already in
		// its project partition), so the row says so instead of pretending.
		deps.store.logReview({
			...rowBaseOf(item), verdict: "demote", reason: "本条不在全局分区，无需降级",
			cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage, applied: 0, evolveCount: prior,
		});
		return;
	}
	if (opts.dryRun) {
		deps.store.logReview({
			...rowBaseOf(item), verdict: "demote", reason: `试运行未降级：${item.evolved?.reason ?? ""}`,
			cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage, applied: 0, evolveCount: prior,
		});
		return;
	}
	const outcome = deps.store.demoteMemory(candidate.workspaceId, candidate.id);
	deps.store.logReview({
		...rowBaseOf(item), verdict: "demote",
		reason: outcome.ok ? (item.evolved?.reason ?? "降回来源分区") : `降级未落地：${outcome.reason ?? "未知原因"}`,
		cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage,
		applied: outcome.ok ? 1 : 0, evolveCount: outcome.ok ? prior + 1 : prior,
	});
	if (outcome.ok) {
		summary.applied += 1;
	}
}

/** `archive`: only with zero references, no correction pointing at it, second judgement. */
function landArchive(item: ReviewItem): void {
	const { deps, candidate, opts, summary } = item;
	const prior = evolveCountOf(deps.store, candidate);
	const blocker = deps.store.archiveBlocker(candidate.workspaceId, candidate.id);
	if (blocker !== undefined) {
		deps.store.logReview({
			...rowBaseOf(item), verdict: "archive", reason: `未归档：${blocker}`,
			proposed: proposedOf(item.evolved ?? { verdict: "archive", reason: "" }),
			cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage, applied: 0, evolveCount: prior,
		});
		return;
	}
	if (opts.dryRun) {
		deps.store.logReview({
			...rowBaseOf(item), verdict: "archive", reason: `试运行未归档：${item.evolved?.reason ?? ""}`,
			cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage, applied: 0, evolveCount: prior,
		});
		return;
	}
	const ok = deps.store.archiveMemory(candidate.workspaceId, candidate.id);
	deps.store.logReview({
		...rowBaseOf(item), verdict: "archive",
		reason: ok ? (item.evolved?.reason ?? "归档") : "归档写入失败",
		cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage,
		applied: ok ? 1 : 0, evolveCount: ok ? prior + 1 : prior,
	});
	if (ok) {
		summary.applied += 1;
	}
}

/**
 * A `keep` verdict still resolves two states the rubric cannot see: a global
 * row on probation (转正 only with cross-partition use, else 降级 back home) and
 * a `person` candidate the reviewer declined to promote (its candidacy ends —
 * otherwise it would be re-judged forever).
 * @param item - The review item.
 * @returns True when the keep was a tiering resolution and is handled.
 */
function landProbationKeep(item: ReviewItem): boolean {
	const { deps, candidate, opts, summary } = item;
	const record = deps.store.get(candidate.workspaceId, candidate.id);
	if (record === undefined) {
		return false;
	}
	const prior = evolveCountOf(deps.store, candidate);
	if (record.probationUntil !== null && candidate.workspaceId === "") {
		const evidence = deps.store.probationEvidence(candidate.id, record.originWorkspace ?? "");
		if (evidence === 0 && !opts.dryRun) {
			const outcome = deps.store.demoteMemory("", candidate.id);
			deps.store.logReview({
				...rowBaseOf(item), verdict: "demote",
				reason: outcome.ok ? "实习期无跨分区引用，退回来源分区" : `实习降级未落地：${outcome.reason ?? ""}`,
				cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage, applied: outcome.ok ? 1 : 0, evolveCount: prior,
			});
			if (outcome.ok) {
				summary.applied += 1;
			}
			return true;
		}
		if (evidence > 0 && !opts.dryRun) {
			deps.store.confirmProbation(candidate.id);
		}
		deps.store.logReview({
			...rowBaseOf(item), verdict: "keep",
			reason: evidence > 0 ? "实习转正（有跨分区引用）" : `试运行未转正：实习期无跨分区引用`,
			cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage, applied: evidence > 0 && !opts.dryRun ? 1 : 0, evolveCount: prior,
		});
		if (evidence > 0 && !opts.dryRun) {
			summary.applied += 1;
		}
		return true;
	}
	if (record.scope === "person" && !opts.dryRun) {
		// Second judgement said "not person": end the candidacy so the funnel
		// stops re-queuing it. The scope write goes through the same gate.
		const outcome = deps.store.applyProposals(
			{ workspaceId: candidate.workspaceId, trigger: "item-review", sessionId: opts.sessionId, runId: item.runId, model: opts.model },
			[{ action: "update", id: candidate.id, scope: "project" }],
		)[0];
		deps.store.logReview({
			...rowBaseOf(item), verdict: "keep",
			reason: outcome?.ok === true ? "审查未判为人物画像，放弃提级候选" : `候选标记清除失败：${outcome?.reason ?? ""}`,
			cheapUsage: item.gate.usage, evolveUsage: item.evolveUsage, applied: 0, evolveCount: prior,
		});
		return true;
	}
	return false;
}
