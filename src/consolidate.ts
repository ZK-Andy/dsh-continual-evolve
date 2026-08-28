/**
 * Global-store consolidation (R3): turn the two hygiene signals — R2's
 * `conflictHint` stamps and usage v2's zero-injection staleness — into one
 * deterministic, human-approved batch of archive edits (`/evolve consolidate`).
 *
 * Design (ADR implemented/feature/2026-08-24-consolidation-command.md):
 * - pure functions only; the command layer owns loading, reporting, and the
 *   apply phase, and ALWAYS re-scans fresh state before applying (the report
 *   and the apply are two separate invocations — prefer under-archiving over
 *   mis-archiving when state moved in between);
 * - archiving keeps data (ARCHIVED_AT_KEY stamp, restorable via
 *   `/evolve unarchive`) and preserves every existing metadata key including
 *   the conflictHint itself, so unarchived entries keep their trail;
 * - no LLM call anywhere: code proposes, the human disposes.
 */
import type { HarnessEntry, HarnessState, RefinementEdit, RefinementKind } from "./types.js";
import { ARCHIVED_AT_KEY, CONFLICT_HINT_KEY, MERGED_FROM_KEY, isArchived } from "./types.js";
import { getUsageCount, type UsageStore } from "./usage.js";

/** Zero-use entries at least this old are stale candidates (30d, matching the injection recency half-life scale). */
export const STALE_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const KINDS: readonly RefinementKind[] = ["prompt", "memory", "skill", "subagent"];

/** Parsed `<kind>:<id>:<score>` value of a {@link CONFLICT_HINT_KEY} stamp. */
export interface ConflictHint {
	kind: RefinementKind;
	id: string;
	score: number;
}

/**
 * Parse one conflictHint metadata value. Returns undefined for anything that
 * is not exactly `<kind>:<id>:<score>` with a known kind and a score in
 * [0, 1] — foreign or legacy junk must never crash the scan.
 */
export function parseConflictHint(value: unknown): ConflictHint | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const parts = value.split(":");
	if (parts.length !== 3) {
		return undefined;
	}
	const [kind, id, rawScore] = parts;
	if (!kind || !id || !rawScore || !KINDS.includes(kind as RefinementKind)) {
		return undefined;
	}
	const score = Number(rawScore);
	if (!Number.isFinite(score) || score < 0 || score > 1) {
		return undefined;
	}
	return { kind: kind as RefinementKind, id, score };
}

/** One planned archive with its human-readable justification. */
export interface ConsolidationCandidate {
	kind: RefinementKind;
	id: string;
	title: string;
	reason: string;
	/**
	 * Merge tier (P1 反膨胀): set on conflict-pair candidates — the entry's
	 * content merges into this survivor (pointed-to original) before the
	 * entry itself archives, so nothing readable is lost by the archive. The
	 * plan only EMITS the merge when `mergeDuplicates` is on.
	 */
	mergeInto?: { kind: RefinementKind; id: string; title: string };
}

/**
 * Entries stamped by the write-time conflict guard whose target still exists
 * and is still active. The hinted (newer) entry is the archive candidate —
 * the pointed-to original stays as the live copy.
 */
export function findConflictPairs(state: HarnessState): ConsolidationCandidate[] {
	const candidates: ConsolidationCandidate[] = [];
	for (const kind of KINDS) {
		for (const entry of Object.values(state.entries[kind])) {
			if (isArchived(entry)) continue;
			const hint = parseConflictHint(entry.metadata[CONFLICT_HINT_KEY]);
			if (!hint || hint.kind !== kind) continue;
		const target = state.entries[hint.kind]?.[hint.id];
		if (!target || isArchived(target)) continue;
		candidates.push({
			kind,
			id: entry.id,
			title: entry.title,
			reason: `near-duplicate of ${hint.id} 「${target.title}」 (${Math.round(hint.score * 100)}%) — keep the original`,
			mergeInto: { kind: hint.kind, id: hint.id, title: target.title },
		});
		}
	}
	return candidates;
}

/**
 * Active global entries never injected in any session and untouched for at
 * least `minAgeMs`: prime staleness candidates. Operates on whatever state
 * it is handed (callers pass the global store).
 */
export function findStaleEntries(
	state: HarnessState,
	store: UsageStore,
	now: number,
	minAgeMs: number = STALE_MIN_AGE_MS,
): ConsolidationCandidate[] {
	const candidates: ConsolidationCandidate[] = [];
	for (const kind of KINDS) {
		for (const entry of Object.values(state.entries[kind])) {
			if (isArchived(entry)) continue;
			if (getUsageCount(store, kind, entry.id) !== 0) continue;
			const updatedAt = Date.parse(entry.updated_at);
			if (Number.isNaN(updatedAt) || now - updatedAt < minAgeMs) continue;
			candidates.push({
				kind,
				id: entry.id,
				title: entry.title,
				reason: `0 injections since ${entry.updated_at.slice(0, 10)} (stale)`,
			});
		}
	}
	return candidates;
}

/**
 * Append a source entry's content to a survivor with an attributed divider,
 * so the survivor's reader can see which part came from which entry.
 */
export function mergeContent(target: string, source: string, sourceRef: string, dateIso: string): string {
	const body = source.trim();
	if (body.length === 0) {
		return target;
	}
	return `${target.trimEnd()}\n\n---\n[Merged from ${sourceRef} on ${dateIso.slice(0, 10)} — near-duplicate consolidated]\n${body}`;
}

/** Existing `<kind>:<id>` strings of a target's {@link MERGED_FROM_KEY} trail. */
function existingMergedFrom(metadata: Record<string, unknown>): string[] {
	const value = metadata[MERGED_FROM_KEY];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Merge both scans (conflict reason wins on overlap), deduped by kind:id,
 * and build the batch archive edits. Each edit preserves the entry's full
 * content and existing metadata — only ARCHIVED_AT_KEY is added — so
 * `/evolve unarchive` restores everything intact.
 *
 * With `opts.mergeDuplicates`, conflict-pair candidates additionally merge
 * their content INTO the pointed-to survivor (an attributed `mergeContent`
 * section + a `mergedFrom` provenance stamp) before archiving — the #11
 * candidate-c tier the 2026-08-28 ecosystem review promoted. Per-target
 * accumulation composes multiple hints into one survivor (update edits
 * replace content/metadata wholesale, so parallel merge edits would clobber
 * each other).
 *
 * @param now Epoch ms used for the archivedAt stamp (injected for tests).
 */
export function planConsolidation(
	state: HarnessState,
	store: UsageStore,
	now: number = Date.now(),
	opts?: { minAgeMs?: number; mergeDuplicates?: boolean },
): { candidates: ConsolidationCandidate[]; edits: RefinementEdit[] } {
	const byKey = new Map<string, ConsolidationCandidate>();
	for (const candidate of [...findConflictPairs(state), ...findStaleEntries(state, store, now, opts?.minAgeMs)]) {
		const key = `${candidate.kind}:${candidate.id}`;
		if (!byKey.has(key)) {
			byKey.set(key, candidate);
		}
	}
	const candidates = [...byKey.values()];
	const dateIso = new Date(now).toISOString();
	const edits: RefinementEdit[] = candidates.map((candidate): RefinementEdit => {
		const entry: HarnessEntry | undefined = state.entries[candidate.kind][candidate.id];
		const metadata = { ...entry?.metadata, [ARCHIVED_AT_KEY]: dateIso };
		return {
			action: "update",
			kind: candidate.kind,
			id: candidate.id,
			title: candidate.title,
			content: entry?.content ?? "",
			metadata,
		};
	});
	if (opts?.mergeDuplicates) {
		const merges = new Map<string, { kind: RefinementKind; id: string; title: string; content: string; mergedFrom: string[]; metadata: Record<string, unknown> }>();
		for (const candidate of candidates) {
			if (!candidate.mergeInto) continue;
			const source = state.entries[candidate.kind][candidate.id];
			const target = state.entries[candidate.mergeInto.kind]?.[candidate.mergeInto.id];
			if (!source || !target) continue;
			const key = `${candidate.mergeInto.kind}:${candidate.mergeInto.id}`;
			const acc =
				merges.get(key) ??
				{
					kind: candidate.mergeInto.kind,
					id: candidate.mergeInto.id,
					title: target.title,
					content: target.content,
					mergedFrom: existingMergedFrom(target.metadata),
					metadata: target.metadata,
				};
			acc.content = mergeContent(acc.content, source.content ?? "", `${candidate.kind}:${candidate.id}`, dateIso);
			acc.mergedFrom.push(`${candidate.kind}:${candidate.id}`);
			merges.set(key, acc);
		}
		for (const acc of merges.values()) {
			edits.unshift({
				action: "update",
				kind: acc.kind,
				id: acc.id,
				title: acc.title,
				content: acc.content,
				metadata: { ...acc.metadata, [MERGED_FROM_KEY]: acc.mergedFrom },
			});
		}
	}
	return { candidates, edits };
}
