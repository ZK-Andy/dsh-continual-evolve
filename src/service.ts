/**
 * The evolution engine: the only entry point that mutates harness state.
 * Every mutation path goes through here so snapshot-before-write, apply
 * accounting, persistence, and result history are enforced in one place.
 */
import type { EntrySource, HarnessScope, RefinementProposal, RefinementResult } from "./types.js";
import { CONFLICT_HINT_KEY } from "./types.js";
import { applyRefinementProposal } from "./apply.js";
import { randomUUID } from "node:crypto";
import { rollbackProposal } from "./rollback.js";
import { loadHarnessState, saveHarnessState } from "./state.js";
import { appendResult, loadResults, pruneJsonlFile, pruneSnapshots, resolveHistoryRetention, snapshotBefore, storePaths } from "./store.js";
import { materializeMemoryProjection } from "./projection.js";
import type { HistoryRetention } from "./store.js";
import { CONFLICT_BLOCK_SCORE, CONFLICT_WARN_SCORE, buildConflictNotice, mostSimilarEntry, secretLeakReason, type SimilarEntryHit } from "./promotion.js";

/** A post-commit apply failure that still carries the durable applied result. */
export class EvolutionApplyPostCommitError extends Error {
	constructor(
		message: string,
		readonly result: RefinementResult,
		readonly scope: HarnessScope,
		readonly storeId: string | undefined,
		override readonly cause: unknown,
	) {
		super(message);
	}
}

export interface ApplyContext {
	scope: HarnessScope;
	sessionId?: string;
	/** When set, optimistic-concurrency checks reject edits whose entries changed since this baseline. */
	baselineState?: Parameters<typeof applyRefinementProposal>[0];
	/** Trajectory citation stamped into newly created entries (see apply.ts). */
	source?: EntrySource | undefined;
	/** Marks the resulting refinement as the deterministic rollback of another (audit chain). */
	rollbackOf?: string | undefined;
}

export interface EvolutionHooks {
	/** Called after every applied refinement (side-effect boundary: skills sync, etc.). */
	onApplied?: (result: RefinementResult) => void;
}

export interface EvolutionEngineOptions {
	/**
	 * Storage-hygiene retention (#20): how many snapshots / JSONL tail
	 * lines each apply keeps. Resolved with generous defaults — rollback
	 * only needs recent snapshots and readers need a working window.
	 */
	historyRetain?: Partial<HistoryRetention>;
}

export function createEvolutionEngine(baseDir: string, hooks: EvolutionHooks = {}, opts: EvolutionEngineOptions = {}) {
	const retention = resolveHistoryRetention(opts.historyRetain);
	/**
	 * Load a scope's state. For `project` the `sessionId` parameter carries
	 * the project key (see `resolveProjectKey` in project.ts); callers
	 * derive it with `projectKeyOf(agent)` and pass it through unchanged.
	 */
	function load(scope: HarnessScope, sessionId: string | undefined) {
		return loadHarnessState(storePaths(baseDir, scope, sessionId).stateDir, scope);
	}

	function apply(scope: HarnessScope, sessionId: string | undefined, proposal: RefinementProposal, context?: ApplyContext): RefinementResult {
		const paths = storePaths(baseDir, scope, sessionId);
		// Working state is ALWAYS the freshest on-disk snapshot: apply mutates
		// and persists the state whole-file, so building on the caller's
		// planning-time copy would silently overwrite concurrent writers
		// (another gate run, another session writing global). The caller's
		// baselineState is ONLY the optimistic-concurrency comparison baseline
		// — "reject edits whose target changed since planning" (review audit
		// 2026-08-28 B1: the two roles were previously folded into one object,
		// which made the advertised guard unreachable).
		const state = load(scope, sessionId);
		// Write-time conflict guard (R2): persistent-scope creates are
		// checked against the existing same-kind entries BEFORE any side
		// effect — a near-duplicate is rejected with an actionable error
		// (evolve_update instead), a moderate overlap proceeds stamped with
		// CONFLICT_HINT_KEY. Rollbacks bypass the guard: re-creating an entry
		// that resembles its successor is the point of rollback. Local scope
		// is never blocked (scratch space); the wrapup/fate promotion path
		// already enforces its own overlap policy there.
		//
		// Secret-leak guard (P0, same throat): every persistent-scope create
		// and update is screened before any side effect. Project and global
		// stores both outlive the current session, so approval never turns a
		// credential-shaped literal into an allowed write. The screen covers
		// every field the edit can plant: title, content, and the JSON forms
		// of reference, arguments, and metadata. Fixed patterns, not policy-
		// configurable.
		const warnHits = new Map<number, SimilarEntryHit>();
		if ((scope === "project" || scope === "global") && !context?.rollbackOf) {
			for (const [index, edit] of proposal.edits.entries()) {
				if (edit.action === "create" || edit.action === "update") {
					const screenable = [
						typeof edit.id === "string" ? edit.id : "",
						typeof edit.path === "string" ? edit.path : "",
						typeof edit.title === "string" ? edit.title : "",
						typeof edit.content === "string" ? edit.content : "",
						edit.reference !== undefined ? JSON.stringify(edit.reference) : "",
						edit.arguments !== undefined ? JSON.stringify(edit.arguments) : "",
						edit.metadata !== undefined ? JSON.stringify(edit.metadata) : "",
					];
					const secret = secretLeakReason(screenable.join("\n"));
					if (secret) {
						throw new Error(`${edit.action} blocked: ${secret}`);
					}
				}
				if (edit.action !== "create") continue;
				// An unknown kind must fail per-edit in validateEdit, never
				// crash the whole proposal here (review audit 2026-08-28 S1).
				const corpus = state.entries[edit.kind];
				if (!corpus) continue;
				const hit = mostSimilarEntry(Object.values(corpus), edit.title ?? "", edit.content ?? "", CONFLICT_WARN_SCORE);
				if (!hit) continue;
				if (hit.score >= CONFLICT_BLOCK_SCORE) {
					throw new Error(`create blocked: ${buildConflictNotice(hit)} already lives in the global ${edit.kind} store — use evolve_update on it instead of adding a duplicate`);
				}
				warnHits.set(index, hit);
			}
		}
		const id = `evolve_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
		// Code-enforced snapshot: runs before any mutation, cannot be skipped by the model.
		snapshotBefore(paths, id);
		const result = applyRefinementProposal(state, proposal, {
			id,
			scope,
			...(context?.source ? { source: context.source } : {}),
			...(context?.baselineState ? { baselineState: context.baselineState } : {}),
			...(context?.rollbackOf ? { rollbackOf: context.rollbackOf } : {}),
		});
		// Stamp warn-tier conflicts onto the freshly created entries (both the
		// live state and the result's after-snapshot stay coherent).
		for (const [index, hit] of warnHits) {
			const applied = result.appliedEdits[index];
			if (!applied?.applied || applied.action !== "create" || !applied.id) continue;
			const hint = `${applied.kind}:${hit.id}:${hit.score.toFixed(2)}`;
			const live = state.entries[applied.kind][applied.id];
			if (live) {
				live.metadata[CONFLICT_HINT_KEY] = hint;
				if (applied.after) {
					applied.after.metadata[CONFLICT_HINT_KEY] = hint;
				}
			}
		}
		saveHarnessState(paths.stateDir, state);
		try {
			appendResult(paths, result);
		} catch (cause) {
			throw new EvolutionApplyPostCommitError(
				`Refinement ${result.id} persisted state but failed to append history: ${cause instanceof Error ? cause.message : String(cause)}`,
				result,
				scope,
				sessionId,
				cause,
			);
		}
		// Storage hygiene (#20): bound the append-only past at write time —
		// snapshots keep the newest N, the per-store history keeps its tail.
		// Best-effort (never throws): a prune failure must not fail the apply.
		try {
			pruneSnapshots(paths.snapshotsDir, retention.snapshots);
		} catch {
			// ignored — the next apply retries
		}
		try {
			pruneJsonlFile(paths.resultsPath, retention.refinements);
		} catch {
			// ignored — the next apply retries
		}
		// Readable Markdown projection (P1): rewritten from the post-apply
		// state whenever a memory edit landed, so rollback and archive stay
		// in sync through this same apply path. The model has no writer for
		// these files — only this engine entry point materializes them.
		if (result.appliedEdits.some((edit) => edit.applied && edit.kind === "memory")) {
			try {
				materializeMemoryProjection(paths.stateDir, state);
			} catch {
				// ignored — the projection is derived (JSON stays the source
				// of truth) and the next memory apply retries
			}
		}
		try {
			hooks.onApplied?.(result);
		} catch (cause) {
			throw new EvolutionApplyPostCommitError(
				`Refinement ${result.id} persisted state but a post-commit hook failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				result,
				scope,
				sessionId,
				cause,
			);
		}
		return result;
	}

	/** Roll back an already-observed result without consulting history. */
	function rollbackResult(scope: HarnessScope, sessionId: string | undefined, target: RefinementResult): RefinementResult {
		return apply(scope, sessionId, rollbackProposal(target), { scope, rollbackOf: target.id });
	}

	function rollback(scope: HarnessScope, sessionId: string | undefined, refinementId: string): RefinementResult {
		const paths = storePaths(baseDir, scope, sessionId);
		const history = loadResults(paths);
		const target = history.find((item) => item.id === refinementId);
		if (!target) {
			throw new Error(`Refinement ${refinementId} not found in ${scope} history`);
		}
		return rollbackResult(scope, sessionId, target);
	}

	function history(scope: HarnessScope, sessionId: string | undefined): RefinementResult[] {
		return loadResults(storePaths(baseDir, scope, sessionId));
	}

	return { load, apply, rollback, rollbackResult, history, baseDir, retention };
}

export type EvolutionEngine = ReturnType<typeof createEvolutionEngine>;
