/**
 * The shared `reviews.jsonl` audit trail: the only writer for extraction
 * decisions, mechanical skips, and the boot armed marker. Writes are
 * contained — a broken ledger must never break the extraction path that
 * already made its decision.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_REVIEWS_RETAIN, pruneJsonlFile } from "./store.js";

export interface ReviewAuditRow {
	sessionId: string;
	reason: string;
	turnsSinceLastReview: number;
	outcome: string;
	rationale?: string;
	[key: string]: unknown;
}

/** Resolve the shared audit trail path under `<baseDir>/evolve/`. */
export function reviewsAuditPath(baseDir: string): string {
	return join(baseDir, "evolve", "reviews.jsonl");
}

/** Append one audit row and bound the trail at write time. Never throws. */
export function appendReviewRecord(
	baseDir: string,
	entry: ReviewAuditRow,
	retain: number | undefined,
	onError?: (cause: unknown) => void,
): void {
	try {
		mkdirSync(join(baseDir, "evolve"), { recursive: true });
		appendFileSync(reviewsAuditPath(baseDir), `${JSON.stringify({ ...entry, timestamp: new Date().toISOString() })}\n`, "utf8");
	} catch (cause) {
		onError?.(cause);
		return;
	}
	try {
		pruneJsonlFile(reviewsAuditPath(baseDir), retain ?? DEFAULT_REVIEWS_RETAIN);
	} catch {
		// ignored — the next record retries
	}
}

/**
 * Boot-time diagnostic: the armed marker proves the listener was registered
 * even when its runtime default is off, distinguishing "not registered"
 * from "off". Never throws.
 */
export function writeArmedMarker(baseDir: string, rationale: string, onError?: (cause: unknown) => void): void {
	try {
		mkdirSync(join(baseDir, "evolve"), { recursive: true });
		appendFileSync(
			reviewsAuditPath(baseDir),
			`${JSON.stringify({
				timestamp: new Date().toISOString(),
				sessionId: "boot",
				reason: "boot",
				turnsSinceLastReview: 0,
				outcome: "armed",
				rationale,
			})}\n`,
			"utf8",
		);
	} catch (cause) {
		onError?.(cause);
	}
}
