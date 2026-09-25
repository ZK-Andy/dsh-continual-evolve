/**
 * Cross-session ledger of declined memory proposals (the decline loop).
 *
 * In-memory `GateState.memoryDecisions` dies on restart and its decision
 * cursor is per-checkpoint, so a declined project/global batch is re-asked
 * in the next session. This file persists batch fingerprints plus content
 * tokens under `<baseDir>/evolve/declined-memory.json`: exact batches are
 * suppressed at approval time, and checkpoints overlapping declined content
 * are suppressed before the agent is even invoked. Token matching is
 * containment (entry ⊆ checkpoint) with a conservative floor; rephrasing
 * below the floor still asks (documented limitation, not silent loss).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { secretLeakReason } from "./promotion.js";
import { tokenize } from "./search.js";
import { EVOLVE_DIR } from "./store.js";

/** Cap on remembered declines; oldest-first pruning keeps the file small. */
export const MAX_DECLINED_MEMORY_LEDGER = 50;

/** Cap on stored content tokens per entry; enough for coverage, never prose. */
export const MAX_DECLINED_ENTRY_TOKENS = 128;

/** Minimum coverage of an entry's tokens by the checkpoint to pre-suppress. */
export const DECLINED_PRECHECK_COVERAGE = 0.85;

/** Minimum overlapping tokens; tiny entries must never match vacuously. */
export const DECLINED_PRECHECK_MIN_TOKENS = 5;

const DECLINED_MEMORY_FILE = "declined-memory.json";

/** One declined project/global batch, keyed by its content fingerprint. */
export interface DeclinedMemoryBatch {
	/** Persistent scope that was declined. Local never asks, so never lands here. */
	scope: "project" | "global";
	/** sha256-16 over the normalized batch (same cut as evaluate.ts/project.ts). */
	fingerprint: string;
	/** First edit title (audit readability only, never matched on). */
	title: string;
	/** Deduplicated content tokens for checkpoint containment checks. */
	tokens: string[];
	/** ISO timestamp of the human rejection. */
	declinedAt: string;
}

/** Minimal edit shape needed for fingerprinting (avoids importing the agent). */
export interface FingerprintableEdit {
	action: string;
	id?: string;
	title?: string;
	content?: string;
}

/** Full path of the decline ledger file. */
export function declinedMemoryPath(baseDir: string): string {
	return join(baseDir, EVOLVE_DIR, DECLINED_MEMORY_FILE);
}

/**
 * Fingerprint one scope batch. Normalization is whitespace-only on purpose:
 * case folding could conflate distinct facts (e.g. env var names), and a
 * missed match only costs one more popup (fail-closed).
 *
 * @param scope - persistent scope the batch targets.
 * @param edits - the scope batch in proposal order (order is significant).
 * @returns 16-char hex fingerprint.
 */
export function fingerprintMemoryBatch(
	scope: "project" | "global",
	edits: readonly FingerprintableEdit[],
): string {
	const parts: string[] = [scope];
	for (const edit of edits) {
		parts.push([edit.action, edit.id ?? "", edit.title ?? "", edit.content ?? ""].join("|"));
	}
	const material = parts.join("\n").replace(/\s+/g, " ").trim();
	return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 16);
}

/**
 * Load the decline ledger. Missing or malformed files read as empty so a
 * broken ledger degrades to the status quo (ask anyway), never to a crash
 * on the approval path.
 *
 * @param baseDir - engine base directory.
 * @returns validated ledger entries (possibly empty).
 */
export function loadDeclinedMemory(baseDir: string): DeclinedMemoryBatch[] {
	const path = declinedMemoryPath(baseDir);
	if (!existsSync(path)) return [];
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!Array.isArray(raw)) return [];
		return raw
			.filter((entry): entry is DeclinedMemoryBatch => {
				if (typeof entry !== "object" || entry === null) return false;
				const candidate = entry as { scope?: unknown; fingerprint?: unknown };
				return (
					(candidate.scope === "project" || candidate.scope === "global") &&
					typeof candidate.fingerprint === "string"
				);
			})
			.map((entry) => ({
				...entry,
				tokens: Array.isArray(entry.tokens) ? entry.tokens.filter((token): token is string => typeof token === "string") : [],
			}));
	} catch {
		return [];
	}
}

/**
 * Whether this exact batch was declined before.
 *
 * @param entries - loaded ledger.
 * @param scope - persistent scope of the pending batch.
 * @param fingerprint - fingerprint of the pending batch.
 */
export function isDeclinedRepeat(
	entries: readonly DeclinedMemoryBatch[],
	scope: "project" | "global",
	fingerprint: string,
): boolean {
	return entries.some((entry) => entry.scope === scope && entry.fingerprint === fingerprint);
}

/**
 * Record one human decline, pruning oldest-first past the cap. The batch
 * edits supply fingerprint material, match tokens, and the secret screen:
 * a secret-shaped decline is still declined, but never lands in the ledger
 * (it was never engine-screened, so it must not be persisted anywhere).
 *
 * @param baseDir - engine base directory.
 * @param scope - persistent scope that was declined.
 * @param edits - the declined scope batch in proposal order.
 * @param title - first edit title, kept for audit readability.
 * @returns the ledger file path, or undefined when skipped by the secret screen.
 * @throws On filesystem write failure; callers on the approval path should
 * contain it (suppression is an optimization, never load-bearing).
 */
export function recordDeclinedMemory(
	baseDir: string,
	scope: "project" | "global",
	edits: readonly FingerprintableEdit[],
	title: string,
): string | undefined {
	const screenable = edits.map((edit) => `${edit.title ?? ""}\n${edit.content ?? ""}`).join("\n");
	if (secretLeakReason(screenable) !== undefined) return undefined;
	const entries = loadDeclinedMemory(baseDir);
	entries.push({
		scope,
		fingerprint: fingerprintMemoryBatch(scope, edits),
		title,
		tokens: declinedContentTokens(edits),
		declinedAt: new Date().toISOString(),
	});
	entries.sort((left, right) => (left.declinedAt < right.declinedAt ? -1 : 1));
	while (entries.length > MAX_DECLINED_MEMORY_LEDGER) entries.shift();
	const path = declinedMemoryPath(baseDir);
	mkdirSync(join(baseDir, EVOLVE_DIR), { recursive: true });
	writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
	return path;
}

/**
 * Deduplicated content tokens of one batch, capped. Shared CJK-aware
 * tokenizer with the manifest ranking, so both sides of the containment
 * check speak the same token language.
 *
 * @param edits - batch edits.
 * @returns at most MAX_DECLINED_ENTRY_TOKENS distinct tokens.
 */
export function declinedContentTokens(edits: readonly FingerprintableEdit[]): string[] {
	const seen = new Set<string>();
	for (const edit of edits) {
		for (const token of tokenize(`${edit.title ?? ""} ${edit.content ?? ""}`)) {
			seen.add(token);
			if (seen.size >= MAX_DECLINED_ENTRY_TOKENS) return [...seen];
		}
	}
	return [...seen];
}

/** One checkpoint containment hit: which entry matched and how strongly. */
export interface DeclinedCheckpointHit {
	/** Ledger entry whose content the checkpoint re-covers. */
	entry: DeclinedMemoryBatch;
	/** Fraction of the entry's tokens present in the checkpoint. */
	coverage: number;
	/** Overlapping token count. */
	hits: number;
}

/**
 * Match a pending checkpoint against declined content (entry ⊆ checkpoint).
 * Conservative by design: high coverage plus an absolute token floor, so
 * tiny or vague declines can never suppress anything.
 *
 * @param entries - loaded ledger.
 * @param checkpointTokens - tokens of the pending checkpoint trajectory.
 * @returns the strongest hit, or undefined when nothing clears the floor.
 */
export function matchDeclinedCheckpoint(
	entries: readonly DeclinedMemoryBatch[],
	checkpointTokens: readonly string[],
): DeclinedCheckpointHit | undefined {
	const pending = new Set(checkpointTokens);
	let best: DeclinedCheckpointHit | undefined;
	for (const entry of entries) {
		if (entry.tokens.length === 0) continue;
		let hits = 0;
		for (const token of entry.tokens) {
			if (pending.has(token)) hits += 1;
		}
		if (hits < DECLINED_PRECHECK_MIN_TOKENS) continue;
		const coverage = hits / entry.tokens.length;
		if (coverage < DECLINED_PRECHECK_COVERAGE) continue;
		if (best === undefined || coverage > best.coverage) best = { entry, coverage, hits };
	}
	return best;
}
