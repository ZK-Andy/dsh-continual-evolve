/**
 * Cross-session ledger of declined memory proposals (the decline loop).
 *
 * In-memory `GateState.memoryDecisions` dies on restart and its decision
 * cursor is per-checkpoint, so a declined project/global batch is re-asked
 * in the next session. This file persists exact-batch fingerprints under
 * `<baseDir>/evolve/declined-memory.json` so a re-proposed batch is
 * suppressed without another popup. Matching is exact on purpose: a
 * rephrased proposal still asks (documented limitation, not silent loss).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { EVOLVE_DIR } from "./store.js";

/** Cap on remembered declines; oldest-first pruning keeps the file small. */
export const MAX_DECLINED_MEMORY_LEDGER = 50;

const DECLINED_MEMORY_FILE = "declined-memory.json";

/** One declined project/global batch, keyed by its content fingerprint. */
export interface DeclinedMemoryBatch {
	/** Persistent scope that was declined. Local never asks, so never lands here. */
	scope: "project" | "global";
	/** sha256-16 over the normalized batch (same cut as evaluate.ts/project.ts). */
	fingerprint: string;
	/** First edit title (audit readability only, never matched on). */
	title: string;
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
		return raw.filter((entry): entry is DeclinedMemoryBatch => {
			if (typeof entry !== "object" || entry === null) return false;
			const candidate = entry as { scope?: unknown; fingerprint?: unknown };
			return (
				(candidate.scope === "project" || candidate.scope === "global") &&
				typeof candidate.fingerprint === "string"
			);
		});
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
 * Record one human decline, pruning oldest-first past the cap.
 *
 * @param baseDir - engine base directory.
 * @param scope - persistent scope that was declined.
 * @param fingerprint - fingerprint of the declined batch.
 * @param title - first edit title, kept for audit readability.
 * @returns the ledger file path.
 * @throws On filesystem write failure; callers on the approval path should
 * contain it (suppression is an optimization, never load-bearing).
 */
export function recordDeclinedMemory(
	baseDir: string,
	scope: "project" | "global",
	fingerprint: string,
	title: string,
): string {
	const entries = loadDeclinedMemory(baseDir);
	entries.push({ scope, fingerprint, title, declinedAt: new Date().toISOString() });
	entries.sort((left, right) => (left.declinedAt < right.declinedAt ? -1 : 1));
	while (entries.length > MAX_DECLINED_MEMORY_LEDGER) entries.shift();
	const path = declinedMemoryPath(baseDir);
	mkdirSync(join(baseDir, EVOLVE_DIR), { recursive: true });
	writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
	return path;
}
