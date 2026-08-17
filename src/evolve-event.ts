/**
 * Structured "evolve complete" events (gap C4): a durable, machine-readable
 * record emitted after every successful refinement application — whether
 * auto-gated or manual. Third-party consumers can observe these events via
 * the plugin log (JSONL) and the reviews.jsonl audit trail.
 *
 * Design: prime-agent `/refine` emits `refine_complete{id,summary,
 * appliedEdits,scope}` extension events. We follow the same pattern with
 * added provenance (trigger, source) so consumers know WHY the refinement
 * happened and WHO initiated it.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RefinementResult } from "./types.js";

/** The structured event payload emitted after every successful refinement. */
export interface EvolveCompleteEvent {
	/** Event discriminator for consumers. */
	type: "evolve_complete";
	/** The refinement id (same as the result). */
	refinementId: string;
	/** One-line summary of the refinement. */
	summary: string;
	/** Number of edits that were actually applied. */
	appliedEdits: number;
	/** Number of edits that failed to apply. */
	failedEdits: number;
	/** Scope of the refinement ("local" or "global"). */
	scope: string;
	/** What triggered this refinement (e.g. "auto_review", "manual_plan", "manual_tool"). */
	trigger: string;
	/** Session id that owns the refinement (auto or manual). */
	sessionId: string;
	/** ISO timestamp. */
	timestamp: string;
	/** Per-edit summaries (kind + id + action) for consumers that want detail. */
	edits: { action: string; kind: string; id: string; applied: boolean }[];
}

/** Build a structured evolve-complete event from a refinement result. */
export function buildEvolveCompleteEvent(
	result: RefinementResult,
	trigger: string,
	sessionId: string,
): EvolveCompleteEvent {
	return {
		type: "evolve_complete",
		refinementId: result.id,
		summary: result.summary,
		appliedEdits: result.appliedEdits.filter((e) => e.applied).length,
		failedEdits: result.appliedEdits.filter((e) => !e.applied).length,
		scope: result.scope ?? "local",
		trigger,
		sessionId,
		timestamp: new Date().toISOString(),
		edits: result.appliedEdits.map((e) => ({
			action: e.action,
			kind: e.kind,
			id: e.id,
			applied: e.applied,
		})),
	};
}

/**
 * Emit an evolve_complete event to the reviews.jsonl audit trail. The event
 * is JSONL-formatted (one line) so consumers can tail and parse it. This is
 * a best-effort write — failure never blocks the refinement path.
 */
export function emitEvolveComplete(baseDir: string, event: EvolveCompleteEvent): void {
	try {
		const dir = join(baseDir, "evolve");
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "reviews.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
	} catch {
		// Event emission is diagnostic; never interrupt the refinement path.
	}
}
