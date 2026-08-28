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
import { appendResult, loadResults, snapshotBefore, storePaths } from "./store.js";
import { CONFLICT_BLOCK_SCORE, CONFLICT_WARN_SCORE, buildConflictNotice, mostSimilarEntry, secretLeakReason, type SimilarEntryHit } from "./promotion.js";

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

export function createEvolutionEngine(baseDir: string, hooks: EvolutionHooks = {}) {
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
		// Write-time conflict guard (R2): global creates are checked against
		// the existing same-kind entries BEFORE any side effect — a
		// near-duplicate is rejected with an actionable error (evolve_update
		// instead), a moderate overlap proceeds stamped with
		// CONFLICT_HINT_KEY. Rollbacks bypass the guard: re-creating an entry
		// that resembles its successor is the point of rollback. Local scope
		// is never blocked (scratch space); the wrapup/fate promotion path
		// already enforces its own overlap policy there.
		//
		// Secret-leak guard (P0, same throat): global creates AND updates are
		// screened for credential-shaped literals before any side effect — a
		// secret reaching the cross-session store is a leak even when the
		// entry itself is legitimate. The screen covers every field the edit
		// can plant: title, content, and the JSON forms of reference,
		// arguments, and metadata (mount embeds reference verbatim into the
		// generated plugin file). Fixed patterns, not policy-configurable.
		const warnHits = new Map<number, SimilarEntryHit>();
		if (scope === "global" && !context?.rollbackOf) {
			for (const [index, edit] of proposal.edits.entries()) {
				if (edit.action === "create" || edit.action === "update") {
					const screenable = [
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
		appendResult(paths, result);
		hooks.onApplied?.(result);
		return result;
	}

	function rollback(scope: HarnessScope, sessionId: string | undefined, refinementId: string): RefinementResult {
		const paths = storePaths(baseDir, scope, sessionId);
		const history = loadResults(paths);
		const target = history.find((item) => item.id === refinementId);
		if (!target) {
			throw new Error(`Refinement ${refinementId} not found in ${scope} history`);
		}
		const proposal = rollbackProposal(target);
		// The rollback refinement carries rollbackOf so the audit chain links
		// the inverse operation back to its origin (previously the rollback
		// record only echoed "Rollback refinement <id>" in its summary text).
		return apply(scope, sessionId, proposal, { scope, rollbackOf: refinementId });
	}

	function history(scope: HarnessScope, sessionId: string | undefined): RefinementResult[] {
		return loadResults(storePaths(baseDir, scope, sessionId));
	}

	return { load, apply, rollback, history, baseDir };
}

export type EvolutionEngine = ReturnType<typeof createEvolutionEngine>;
