/**
 * The autonomous content-quality loop (the model's verdicts, code's
 * consequences): cheap gate first, evolve pass only on approval, every
 * terminal path ledgered as one `item-review` row, one day-rollup merge per
 * run. No human in the loop — delete never lands automatically (verdicts
 * only know keep/rewrite/quarantine) and oversized rewrites degrade to
 * quarantine instead of landing.
 *
 * This track is independent from the extraction pipeline by construction:
 * own prompts (`review-prompt.ts`), own budget (`review_daily`), own ledger
 * (`review_log`), no cursor, no increment. It only shares the store's write
 * gates (`applyProposals` / `applySkillProposals` / `quarantine`).
 */
import { normalizeUsage, zeroUsage, type UsageTotals } from "./token-usage.js";
import {
	evolvePrompt,
	gatePrompt,
	parseEvolveAnswer,
	parseGateAnswer,
	REVIEW_CHEAP_SYSTEM_PROMPT,
	REVIEW_MEMORY_SYSTEM_PROMPT,
	REVIEW_SKILL_SYSTEM_PROMPT,
} from "./review-prompt.js";
import type { MemoryStore } from "./store.js";
import { cwdOf } from "./memory-section.js";
import { resolveCallRoute, streamOnce, type LlmRuntime, type ModelSelection, type RouteResolver } from "./llm-call.js";

/** The LLM face review calls, aliased so each scheduler can name its own. */
export type ReviewLlm = LlmRuntime;

export interface ReviewDeps {
	store: MemoryStore;
	llm: LlmRuntime | undefined;
	/**
	 * Route resolution for a direct call: the agent's explicit selection first,
	 * the host default model second. Absent keeps the legacy agent-options-only
	 * behavior (tests and older hosts).
	 */
	resolveRoute?: RouteResolver | undefined;
}

export interface ReviewCandidate {
	workspaceId: string;
	kind: "memory" | "skill";
	id: string;
	/** 0 = new, 1 = corrects-linked requeue, 2 = stale requeue. */
	priority: number;
	title: string;
	description: string;
	body: string;
	/** Memory type, present only for memory candidates. */
	memoryType?: string | undefined;
	/** Skill scope, present only for skill candidates. */
	scope?: "project" | "global" | undefined;
}

export interface ReviewRunOptions {
	/** UTC day `YYYY-MM-DD` the hard cap accounts against. */
	day: string;
	/** Hard cap for the day (100). Candidates past it count as dropped. */
	budget: number;
	/** Trial mode: verdicts ledgered, nothing applied or quarantined. */
	dryRun: boolean;
	/** Max items per run (batching keeps one prompt small). */
	batchSize?: number | undefined;
	/** Days of untouched age before an item requeues (default 30). */
	staleDays?: number | undefined;
	provider?: string | undefined;
	model?: string | undefined;
	sessionId?: string | undefined;
	runId?: string | undefined;
}

export interface ReviewRunSummary {
	reviewed: number;
	approved: number;
	applied: number;
	dropped: number;
	backlog: number;
	cheapToken: number;
	evolveToken: number;
}

/** A rewrite lands only when the body-length ratio stays within this bound. */
export const REWRITE_MAGNITUDE_CAP = 0.3;

/**
 * Output budget for one cheap-gate call: a verdict JSON **plus** the reasoning
 * a thinking model spends before emitting it. A 512-token budget cut the gate
 * off on reasoning-model calls (2026-10-13) and the cut was ledgered as a
 * route failure, so the per-item failure rate read as a network problem.
 */
export const GATE_MAX_TOKENS = 1024;

/** Output budget for the evolve pass: a verdict plus full replacement text. */
export const EVOLVE_MAX_TOKENS = 4096;

/** Defaults for the review settings the host may override — and edit live. */
export const REVIEW_DEFAULT_DRY_RUN = true;
export const REVIEW_DEFAULT_DAILY_BUDGET = 100;
export const REVIEW_DEFAULT_BATCH_SIZE = 10;
export const REVIEW_DEFAULT_STALE_DAYS = 30;

/** Relative body change: |new-old| / max(old, 1). Above the cap → quarantine. */
export function rewriteMagnitude(oldBody: string, newBody: string): number {
	return Math.abs(newBody.length - oldBody.length) / Math.max(oldBody.length, 1);
}

/**
 * Collect review candidates across every workspace carrying active items:
 * new items first (newest first), then corrects-linked requeues, then stale
 * requeues (30 days untouched). bounded by `limit`.
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

/**
 * Run one review batch: cheap gate per item, evolve pass on approval,
 * safeguards before landing, one `item-review` row per terminal path, one
 * daily merge at the end. Never throws: LLM and parse failures degrade to
 * skip rows (the run keeps going), exactly like extraction's fail-ledgered
 * discipline.
 */
export async function runReviewBatch(deps: ReviewDeps, candidates: readonly ReviewCandidate[], opts: ReviewRunOptions): Promise<ReviewRunSummary> {
	const summary: ReviewRunSummary = { reviewed: 0, approved: 0, applied: 0, dropped: 0, backlog: 0, cheapToken: 0, evolveToken: 0 };
	const skipReasons: string[] = [];
	const batch = candidates.slice(0, Math.max(1, opts.batchSize ?? 10));
	const runId = opts.runId ?? `review:${opts.day}:${Date.now()}`;
	let newItems = 0;
	let requeued = 0;
	const route: ModelSelection | undefined = opts.provider === undefined || opts.model === undefined
		? undefined
		: { provider: opts.provider, model: opts.model };
	const noRoute = deps.llm === undefined || route === undefined;
	let position = 0;
	for (const candidate of batch) {
		const remaining = deps.store.consumeReviewBudget(opts.day, opts.budget);
		if (remaining < 0) {
			// Hard cap hit: this item and everything after it drops (low
			// priority never rolls over — it simply waits for a future run).
			summary.dropped += batch.length - position;
			for (const item of batch.slice(position)) {
				deps.store.logReview({
					runId, workspaceId: item.workspaceId, itemKind: item.kind, itemId: item.id,
					verdict: "skip", reason: "budget-exhausted", applied: 0,
				});
			}
			skipReasons.push("budget-exhausted");
			break;
		}
		summary.reviewed += 1;
		if (candidate.priority === 0) {
			newItems += 1;
		} else {
			requeued += 1;
		}
		if (noRoute || route === undefined) {
			deps.store.logReview({
				runId, workspaceId: candidate.workspaceId, itemKind: candidate.kind, itemId: candidate.id,
				verdict: "skip", reason: "no-route", applied: 0,
			});
			skipReasons.push("no-route");
			position += 1;
			continue;
		}
		await reviewOne(deps, runId, candidate, opts, route, summary, skipReasons);
		position += 1;
	}
	summary.backlog = Math.max(0, candidates.length - summary.reviewed - summary.dropped);
	deps.store.mergeDaily(opts.day, opts.budget, {
		newItems, requeued, approved: summary.approved, applied: summary.applied,
		cheapToken: summary.cheapToken, evolveToken: summary.evolveToken,
		backlog: summary.backlog, dropped: summary.dropped,
		skipReasons: skipReasons.length > 0 ? skipReasons : undefined,
	});
	return summary;
}

async function reviewOne(
	deps: ReviewDeps,
	runId: string,
	candidate: ReviewCandidate,
	opts: ReviewRunOptions,
	route: ModelSelection,
	summary: ReviewRunSummary,
	skipReasons: string[],
): Promise<void> {
	const base = {
		runId, workspaceId: candidate.workspaceId, itemKind: candidate.kind, itemId: candidate.id,
	} as const;
	// ── Cheap gate ──────────────────────────────────────────────
	let gateUsage: UsageTotals = zeroUsage();
	let gateRaw: unknown;
	try {
		const answer = await streamOnce(deps.llm, route, opts.sessionId, REVIEW_CHEAP_SYSTEM_PROMPT, gatePrompt(candidate), GATE_MAX_TOKENS);
		gateRaw = answer.usage;
		const gate = parseGateAnswer(answer.text);
		if (gate === null) {
			// A cut gate is a failure only when no complete verdict came
			// through: the JSON usually lands before the budget runs out, so
			// parse first and blame the finish reason only if it did not.
			if (answer.finish !== undefined && answer.finish !== "stop") {
				throw new Error(`stream finished with ${answer.finish}`);
			}
			deps.store.logReview({ ...base, verdict: "skip", reason: "gate-parse-failed", cheapUsage: gateRaw, applied: 0 });
			skipReasons.push("gate-parse-failed");
			return;
		}
		if (!gate.worthReview) {
			summary.cheapToken += totalOf(gateRaw);
			deps.store.logReview({ ...base, verdict: "skip", reason: gate.reason, cheapUsage: gateRaw, applied: 0 });
			skipReasons.push("cheap-gate");
			return;
		}
		summary.cheapToken += totalOf(gateRaw);
		gateUsage = normalizedOf(gateRaw);
	} catch (error) {
		// The error text rides the row: a bare `gate-llm-failed` hid a ~50%
		// per-item failure rate in production (2026-10-12) with no way to
		// tell transient route faults from systematic ones.
		deps.store.logReview({ ...base, verdict: "skip", reason: `gate-llm-failed: ${failureHead(error)}`, applied: 0 });
		skipReasons.push("gate-llm-failed");
		return;
	}
	summary.approved += 1;
	// ── Evolve pass ─────────────────────────────────────────────
	const neighbors = neighborHooks(deps.store, candidate);
	const extra = candidate.kind === "memory" && candidate.memoryType === "feedback"
		? "注意：feedback 类正文必须带 Why 与 How to apply 两行。"
		: undefined;
	let evolveRaw: unknown;
	try {
		const system = candidate.kind === "memory" ? REVIEW_MEMORY_SYSTEM_PROMPT : REVIEW_SKILL_SYSTEM_PROMPT;
		const answer = await streamOnce(
			deps.llm, route, opts.sessionId, system,
			evolvePrompt({ id: candidate.id, title: candidate.title, description: candidate.description, body: candidate.body, extra, scope: candidate.scope }, neighbors),
			EVOLVE_MAX_TOKENS,
		);
		evolveRaw = answer.usage;
		summary.evolveToken += totalOf(evolveRaw);
		// The evolve pass carries full replacement text: a cut stream may hold
		// half a body, so it never becomes a verdict.
		if (answer.finish !== undefined && answer.finish !== "stop") {
			throw new Error(`stream finished with ${answer.finish}`);
		}
		const evolved = parseEvolveAnswer(answer.text);
		if (evolved === null) {
			deps.store.logReview({ ...base, verdict: "skip", reason: "evolve-parse-failed", cheapUsage: gateUsage, evolveUsage: evolveRaw, applied: 0 });
			skipReasons.push("evolve-parse-failed");
			return;
		}
		if (evolved.verdict === "keep") {
			deps.store.logReview({ ...base, verdict: "keep", reason: evolved.reason, cheapUsage: gateUsage, evolveUsage: evolveRaw, applied: 0 });
			return;
		}
		if (evolved.verdict === "quarantine") {
			landQuarantine(deps, base, candidate, opts, evolved.reason, gateUsage, evolveRaw, proposedOf(evolved), summary);
			return;
		}
		// ── Rewrite: magnitude cap first, dry-run second, gates last ──
		const nextBody = evolved.body ?? candidate.body;
		if (rewriteMagnitude(candidate.body, nextBody) > REWRITE_MAGNITUDE_CAP) {
			landQuarantine(deps, base, candidate, opts, `幅度超限转隔离：${evolved.reason}`, gateUsage, evolveRaw, proposedOf(evolved), summary);
			return;
		}
		if (opts.dryRun) {
			deps.store.logReview({ ...base, verdict: "rewrite", reason: `试运行未落盘：${evolved.reason}`, proposed: proposedOf(evolved), cheapUsage: gateUsage, evolveUsage: evolveRaw, applied: 0 });
			return;
		}
		landRewrite(deps, base, candidate, opts, evolved, gateUsage, evolveRaw, summary);
	} catch (error) {
		deps.store.logReview({ ...base, verdict: "skip", reason: `evolve-llm-failed: ${failureHead(error)}`, cheapUsage: gateUsage, evolveUsage: evolveRaw, applied: 0 });
		skipReasons.push("evolve-llm-failed");
	}
}

/**
 * The rewrite payload a non-landing row keeps: exactly the fields the model
 * supplied, or `undefined` when it proposed no text at all.
 */
function proposedOf(evolved: { title?: string | undefined; description?: string | undefined; body?: string | undefined; corrects?: string | undefined }): Record<string, string> | undefined {
	const payload: Record<string, string> = {};
	if (evolved.title !== undefined) {
		payload.title = evolved.title;
	}
	if (evolved.description !== undefined) {
		payload.description = evolved.description;
	}
	if (evolved.body !== undefined) {
		payload.body = evolved.body;
	}
	if (evolved.corrects !== undefined) {
		payload.corrects = evolved.corrects;
	}
	return Object.keys(payload).length === 0 ? undefined : payload;
}

function neighborHooks(store: MemoryStore, candidate: ReviewCandidate): { id: string; title: string; description: string }[] {
	try {
		if (candidate.kind === "memory") {
			const query = candidate.title.slice(0, 60);
			const hits = query.length >= 3 ? store.search(candidate.workspaceId, query, 5) : store.list(candidate.workspaceId).slice(0, 5);
			return hits.filter((hit) => hit.id !== candidate.id).slice(0, 4).map((hit) => ({ id: hit.id, title: hit.title, description: hit.description }));
		}
		const hits = store.searchSkills(candidate.workspaceId, candidate.title.slice(0, 60), 5);
		return hits.filter((hit) => hit.id !== candidate.id).slice(0, 4).map((hit) => ({ id: hit.id, title: hit.title, description: hit.description }));
	} catch {
		return [];
	}
}

function landQuarantine(
	deps: ReviewDeps,
	base: { runId: string; workspaceId: string | undefined; itemKind: "memory" | "skill"; itemId: string },
	candidate: ReviewCandidate,
	opts: ReviewRunOptions,
	reason: string,
	gateUsage: UsageTotals,
	evolveRaw: unknown,
	proposed: Record<string, string> | undefined,
	summary: ReviewRunSummary,
): void {
	const prior = deps.store.reviewStateOf(candidate.workspaceId, candidate.kind, candidate.id)?.evolveCount ?? 0;
	if (opts.dryRun) {
		deps.store.logReview({ ...base, verdict: "quarantine", reason: `试运行未隔离：${reason}`, proposed, cheapUsage: gateUsage, evolveUsage: evolveRaw, applied: 0, evolveCount: prior });
		return;
	}
	const ok = deps.store.quarantine(candidate.workspaceId, candidate.kind, candidate.id);
	deps.store.logReview({
		...base, verdict: "quarantine", reason, cheapUsage: gateUsage, evolveUsage: evolveRaw,
		applied: ok ? 1 : 0, evolveCount: ok ? prior + 1 : prior,
	});
	if (ok) {
		summary.applied += 1;
	}
}

function landRewrite(
	deps: ReviewDeps,
	base: { runId: string; workspaceId: string | undefined; itemKind: "memory" | "skill"; itemId: string },
	candidate: ReviewCandidate,
	opts: ReviewRunOptions,
	evolved: { reason: string; title?: string | undefined; description?: string | undefined; body?: string | undefined; corrects?: string | undefined },
	gateUsage: UsageTotals,
	evolveRaw: unknown,
	summary: ReviewRunSummary,
): void {
	const prior = deps.store.reviewStateOf(candidate.workspaceId, candidate.kind, candidate.id)?.evolveCount ?? 0;
	const ctx = { workspaceId: candidate.workspaceId, trigger: "item-review" as const, sessionId: opts.sessionId, runId: base.runId, model: opts.model, decision: evolved.reason };
	if (candidate.kind === "memory") {
		const [outcome] = deps.store.applyProposals(ctx, [{
			action: "update", id: candidate.id,
			title: evolved.title, description: evolved.description, body: evolved.body,
			corrects: evolved.corrects,
		}]);
		const ok = outcome !== undefined && outcome.ok;
		deps.store.logReview({
			...base, verdict: "rewrite", reason: ok ? evolved.reason : `门禁拒绝：${outcome?.reason ?? "未知原因"}`,
			cheapUsage: gateUsage, evolveUsage: evolveRaw, applied: ok ? 1 : 0, evolveCount: ok ? prior + 1 : prior,
		});
		if (ok) {
			summary.applied += 1;
		}
		return;
	}
	const { outcomes } = deps.store.applySkillProposals(ctx, [{
		action: "update", scope: candidate.scope ?? "project", id: candidate.id,
		title: evolved.title, description: evolved.description, body: evolved.body,
	}]);
	const outcome = outcomes[0];
	const ok = outcome !== undefined && outcome.ok;
	deps.store.logReview({
		...base, verdict: "rewrite", reason: ok ? evolved.reason : `门禁拒绝：${outcome?.reason ?? "未知原因"}`,
		cheapUsage: gateUsage, evolveUsage: evolveRaw, applied: ok ? 1 : 0, evolveCount: ok ? prior + 1 : prior,
	});
	if (ok) {
		summary.applied += 1;
	}
}

function totalOf(raw: unknown): number {
	return normalizeUsage(raw)?.total ?? 0;
}

/** One-line error head for ledger rows (fail-loud shape, capped length). */
export function failureHead(error: unknown, max = 120): string {
	const message = error instanceof Error ? error.message : String(error);
	const head = message.split("\n", 1)[0] ?? "";
	return head.length > max ? `${head.slice(0, max)}…` : head;
}

function normalizedOf(raw: unknown): UsageTotals {
	return normalizeUsage(raw) ?? zeroUsage();
}

/** Current UTC day `YYYY-MM-DD` for the hard-cap account. */
export function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
}

/** The event wiring surface (duck-typed cordis context, mirrors extraction). */
export interface ReviewSchedulerHost {
	on(event: string, handler: (...args: never[]) => void): unknown;
	logger(name: string): { info(message: string): void; warn(message: string): void };
}

/** The editable review settings, re-read on every drain. */
export interface ReviewSettings {
	dryRun: boolean;
	dailyBudget: number;
	batchSize: number;
	staleDays: number;
}

export interface ReviewSchedulerConfig {
	enabled: boolean;
	/**
	 * Read the current settings for each drain: the host's configuration is
	 * volatile, so values edited live take effect without a remount and are
	 * never captured once at mount time.
	 */
	read: () => ReviewSettings;
	/** Minimum ms between two drains (default 5 minutes). */
	minIntervalMs: number;
}

/**
 * Wire the review triggers onto the host context. Global single-flight with
 * a minimum interval: turn boundaries arm the pending workspace, compaction
 * and session close drain immediately. Each drain reviews one batch bounded
 * by the remaining daily budget — never more.
 */
export function createReviewScheduler(
	host: ReviewSchedulerHost,
	deps: ReviewDeps,
	config: ReviewSchedulerConfig,
): () => void {
	const listeners: unknown[] = [];
	let running = false;
	let lastRunAt = 0;
	let pendingWorkspace: string | undefined;
	let lastRoute: { provider: string; model: string; sessionId: string } | undefined;

	const drain = (triggerWorkspace: string | undefined): void => {
		if (!config.enabled || running) {
			if (triggerWorkspace !== undefined) {
				pendingWorkspace = triggerWorkspace;
			}
			return;
		}
		if (Date.now() - lastRunAt < config.minIntervalMs) {
			if (triggerWorkspace !== undefined) {
				pendingWorkspace = triggerWorkspace;
			}
			return;
		}
		if (deps.llm === undefined || lastRoute?.provider === undefined || lastRoute?.model === undefined) {
			return;
		}
		running = true;
		lastRunAt = Date.now();
		const workspace = triggerWorkspace ?? pendingWorkspace;
		pendingWorkspace = undefined;
		void (async () => {
			try {
				const settings = config.read();
				const day = todayUtc();
				const daily = deps.store.getDaily(day);
				const remaining = settings.dailyBudget - (daily?.reviewed ?? 0);
				if (remaining <= 0) {
					return;
				}
				const candidates = collectCandidates(deps.store, { staleDays: settings.staleDays, limit: settings.batchSize * 2 });
				const ordered = workspace === undefined
					? candidates
					: [...candidates.filter((c) => c.workspaceId === workspace), ...candidates.filter((c) => c.workspaceId !== workspace)];
				await runReviewBatch(deps, ordered.slice(0, settings.batchSize), {
					day, budget: settings.dailyBudget, dryRun: settings.dryRun,
					batchSize: settings.batchSize, staleDays: settings.staleDays,
					provider: lastRoute?.provider, model: lastRoute?.model, sessionId: lastRoute?.sessionId,
				});
			} catch (error) {
				host.logger("continual-evolve").warn(
					`review drain failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				running = false;
			}
		})();
	};

	listeners.push(
		host.on("agent/turn-stopping", (payload: { agent?: unknown }) => {
			const agent = payload.agent as { id?: unknown } | undefined;
			const id = agent?.id;
			if (typeof id !== "string" || id.length === 0) {
				return;
			}
			// A drain needs a live route. A session running on the host default
			// model carries no explicit selection, so the default-model service
			// fills it in; with neither, the boundary is only remembered and the
			// next turn boundary reviews it. This is what keeps a review call
			// from being sent with an empty provider or a dead session identity
			// (both of which the provider answers with a bare stream error).
			// Absent resolver (older host, tests) still reads the agent's explicit
			// selection: the fallback is the legacy behavior, never "no route".
			const route = deps.resolveRoute?.(agent) ?? resolveCallRoute(agent, undefined);
			if (route === undefined) {
				pendingWorkspace = cwdOf(agent);
				return;
			}
			lastRoute = { provider: route.provider, model: route.model, sessionId: id };
			drain(cwdOf(agent));
		}),
	);
	const armed = config.read();
	host.logger("continual-evolve").info(
		`review scheduler armed (daily cap ${armed.dailyBudget}, dry-run ${armed.dryRun ? "on" : "off"})`,
	);
	return () => {
		pendingWorkspace = undefined;
		for (const listener of listeners) {
			if (typeof listener === "function") {
				listener();
			}
		}
	};
}
