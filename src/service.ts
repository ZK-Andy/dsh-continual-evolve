/**
 * The evolution engine: the only entry point that mutates harness state.
 * Every mutation path goes through here so snapshot-before-write, apply
 * accounting, persistence, and result history are enforced in one place.
 */
import type { EntrySource, HarnessScope, RefinementProposal, RefinementResult } from "./types.js";
import { applyRefinementProposal } from "./apply.js";
import { randomUUID } from "node:crypto";
import { rollbackProposal } from "./rollback.js";
import { loadHarnessState, saveHarnessState } from "./state.js";
import { appendResult, loadResults, snapshotBefore, storePaths } from "./store.js";

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
		const state = context?.baselineState ?? load(scope, sessionId);
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
