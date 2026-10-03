/**
 * Wrap-up candidate domain: the mechanical audit of a session's local
 * entries (candidates, global coverage detection, usage hints), the LLM
 * assessment parser, and the shared wrap-up types. Pure logic — the LLM
 * call lives in `wrapup.ts`, the proposal builders in
 * `wrapup-proposals.ts`.
 */
import type { HarnessEntry, HarnessState, RefinementKind } from "./types.js";
import { PROMOTED_TO_KEY, VALENCE_NEGATIVE_KEY, isArchived } from "./types.js";
import { extractJsonObject } from "./plan.js";
import { getUsageCount, loadUsage } from "./usage.js";
import { recencyScore } from "./injection-rank.js";
export type WrapupVerdict = "promote" | "archive" | "keep";

/** A classified local entry: `key` matches one audited candidate exactly. */
export interface WrapupItem {
	/** `kind:id` of the candidate this verdict refers to. */
	key: string;
	verdict: WrapupVerdict;
	reason: string;
	/**
	 * Optional split-promotion payload (verdict "archive" only): the entry is
	 * archived as a whole, but a CLEANED cross-session-reusable part is
	 * offered for promotion — the durable fact distilled out of the mixed
	 * entry, with the ephemeral snapshot left behind in the archive.
	 */
	promote?: {
		title: string;
		content: string;
	};
	/**
	 * Valence signal (P1 效价反馈): the assessor found trajectory or global
	 * evidence contradicting this entry's content (user correction, overridden
	 * fact). Strictly parsed — only an explicit JSON `true` sets it. Keep
	 * verdicts with this flag get a negative-valence stamp; the assessor is
	 * instructed to prefer "archive" for contradicted entries.
	 */
	contradicted?: boolean;
}

/** A real global entry worth showing the assessor for the same topic. */
export interface GlobalHint {
	id: string;
	title: string;
}

/** The model's full classification of a session's local entries. */
export interface WrapupAssessment {
	items: WrapupItem[];
	rationale: string;
}

/** A local entry offered for assessment, plus its deterministic audit flags. */
export interface WrapupCandidate {
	kind: RefinementKind;
	id: string;
	title: string;
	content: string;
	path: string;
	version: number;
	metadata: Record<string, unknown>;
	/**
	 * True when the global store already covers this topic by a STRONG
	 * signal: a title that normalizes equal to, or (beyond a length floor)
	 * contains, the candidate's title. Collisions on id alone with a wildly
	 * different title are deliberately NOT coverage — see {@link globalHintsFor}.
	 */
	coveredGlobally: boolean;
	/**
	 * Actual global entries that touch the same topic (same id, equal
	 * normalized title, or title overlap). Shown to the assessor so it judges
	 * against real titles instead of a bare boolean; a bare same-id collision
	 * shows up here precisely so the model can tell whether the global copy
	 * really covers the local content.
	 */
	globalHints: GlobalHint[];
	/**
	 * Injection usage count (gap B1): how many times this entry was included
	 * in a system-prompt assembly. Zero means the entry was never used — a
	 * strong staleness signal the assessor can weigh.
	 */
	injectionCount: number;
	/**
	 * Staleness flag (gap B2): true when the entry has both zero injection
	 * usage AND a recency score below the staleness threshold (old + unused).
	 * The assessor is instructed to prefer "archive" for stale entries.
	 */
	stale: boolean;
	/**
	 * Negative-valence counter (P1 效价反馈): how many prior assessments marked
	 * this entry contradicted (metadata {@link VALENCE_NEGATIVE_KEY}). Shown to
	 * the assessor so it can prefer "archive"; also demotes the entry in
	 * injection ranking (inject.ts rankEntries).
	 */
	negativeCount: number;
}

export function candidateKey(kind: RefinementKind, id: string): string {
	return `${kind}:${id}`;
}

/** Lowercase, punctuation-stripped title used for cheap coverage matching. */
function normalizeKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, "").trim();
}

/**
 * Deterministic global-coverage check (STRONG signal): the global store
 * already covers a topic when it holds a title that normalizes equal to, or
 * (beyond a length floor) contains, the candidate's normalized title.
 * Archived global entries count too — the topic was already judged
 * cross-session; a local duplicate would only re-sediment it.
 *
 * The bare same-id case is deliberately NOT coverage: ids are slugs derived
 * from titles, so a real collision is usually caught by the title check
 * below. A same-id entry with a wildly different title is a weak signal — the
 * caller routes it through {@link globalHintsFor} for the assessor to judge
 * against the actual global title (real case: local `memory` "用户产品愿景与
 * 收入需求（本会话）" vs global `memory` "用户画像（持续更新）").
 */
export function globalCoverageDetected(
	globalState: HarnessState,
	kind: RefinementKind,
	entry: Pick<HarnessEntry, "id" | "title">,
): boolean {
	const records = globalState.entries[kind];
	const title = normalizeKey(entry.title);
	if (title.length === 0) return false;
	for (const other of Object.values(records)) {
		const otherTitle = normalizeKey(other.title);
		if (otherTitle.length === 0) continue;
		if (otherTitle === title) return true;
		if (title.length >= 4 && otherTitle.length >= 4 && (title.includes(otherTitle) || otherTitle.includes(title))) {
			return true;
		}
	}
	return false;
}

/**
 * The actual global entries that touch the same topic as a local candidate:
 * same id (regardless of title — the weak collision signal that is NOT
 * coverage on its own), equal normalized title, or title overlap. The raw ids
 * and titles let the assessor judge enrichment against real global content
 * (does the global copy already hold what the local one adds?) rather than a
 * bare boolean. Bounded: a handful of best matches, never the whole store.
 */
export function globalHintsFor(
	globalState: HarnessState,
	kind: RefinementKind,
	entry: Pick<HarnessEntry, "id" | "title">,
): GlobalHint[] {
	const records = globalState.entries[kind];
	const title = normalizeKey(entry.title);
	const hints: GlobalHint[] = [];
	for (const other of Object.values(records)) {
		const otherTitle = normalizeKey(other.title);
		if (otherTitle.length === 0 && other.id !== entry.id) continue;
		const matches =
			other.id === entry.id ||
			(otherTitle.length > 0 && (otherTitle === title || (title.length >= 4 && otherTitle.length >= 4 && (title.includes(otherTitle) || otherTitle.includes(title)))));
		if (matches) {
			hints.push({ id: other.id, title: other.title });
		}
	}
	return hints;
}

/**
 * The auditable local candidates of a session: every non-archived local
 * entry that has not already been promoted (a promoted entry's lifecycle is
 * finished — the global copy is the live one). Each carries its
 * `coveredGlobally` flag so the assessor never wastes a promote on a topic
 * the global store already owns.
 */
/** Staleness threshold: entries with recency below this AND zero usage are stale. */
const STALE_RECENCY_THRESHOLD = 0.1;

export function listLocalCandidates(state: HarnessState, globalState: HarnessState, baseDir?: string): WrapupCandidate[] {
	const usage = baseDir ? loadUsage(baseDir) : undefined;
	const now = Date.now();
	const candidates: WrapupCandidate[] = [];
	for (const kind of Object.keys(state.entries) as RefinementKind[]) {
		for (const entry of Object.values(state.entries[kind])) {
			if (entry.scope !== "local") continue;
			if (isArchived(entry)) continue;
			if (typeof entry.metadata[PROMOTED_TO_KEY] === "string") continue;
			const injectionCount = usage ? getUsageCount(usage, kind, entry.id) : 0;
			const stale = injectionCount === 0 && recencyScore(entry, now) < STALE_RECENCY_THRESHOLD;
			const rawNegative = entry.metadata[VALENCE_NEGATIVE_KEY];
			const negativeCount = typeof rawNegative === "number" && Number.isFinite(rawNegative) && rawNegative > 0 ? rawNegative : 0;
			candidates.push({
				kind,
				id: entry.id,
				title: entry.title,
				content: entry.content,
				path: entry.path,
				version: entry.version,
				metadata: entry.metadata,
				coveredGlobally: globalCoverageDetected(globalState, kind, entry),
				globalHints: globalHintsFor(globalState, kind, entry),
				injectionCount,
				stale,
				negativeCount,
			});
		}
	}
	return candidates;
}

/**
 * Parse and validate the model's assessment JSON. Defense is mechanical:
 * keys outside the candidate list are dropped, verdicts outside the enum
 * collapse to "keep", and candidates the model omitted default to "keep" —
 * a malformed reply can never change an entry's fate by itself.
 *
 * Split promotion (verdict "archive" with a `promote` sub-object): the
 * sub-object is accepted ONLY on archive verdicts and ONLY when both cleaned
 * title and content are non-empty strings — a dropped/malformed sub-object
 * silently degrades to a plain archive (the entry is never half-promoted).
 */
export function parseWrapupAssessment(text: string, candidates: readonly WrapupCandidate[]): WrapupAssessment {
	const value = extractJsonObject(text);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("wrap-up assessment JSON must be an object");
	}
	const record = value as Record<string, unknown>;
	const allowed = new Set(candidates.map((candidate) => candidateKey(candidate.kind, candidate.id)));
	const items: WrapupItem[] = [];
	if (Array.isArray(record["items"])) {
		for (const raw of record["items"]) {
			if (typeof raw !== "object" || raw === null) continue;
			const item = raw as Record<string, unknown>;
			const key = typeof item["key"] === "string" ? item["key"] : "";
			if (!allowed.has(key)) continue;
			const verdict = item["verdict"] === "promote" || item["verdict"] === "archive" ? item["verdict"] : "keep";
			const built: WrapupItem = { key, verdict, reason: typeof item["reason"] === "string" ? item["reason"] : "" };
			if (item["contradicted"] === true) {
				built.contradicted = true;
			}
			if (verdict === "archive" && typeof item["promote"] === "object" && item["promote"] !== null) {
				const sub = item["promote"] as Record<string, unknown>;
				const subTitle = typeof sub["title"] === "string" ? sub["title"].trim() : "";
				const subContent = typeof sub["content"] === "string" ? sub["content"].trim() : "";
				if (subTitle.length > 0 && subContent.length > 0) {
					built.promote = { title: subTitle, content: subContent };
				}
			}
			items.push(built);
		}
	}
	for (const candidate of candidates) {
		const key = candidateKey(candidate.kind, candidate.id);
		if (!items.some((item) => item.key === key)) {
			items.push({ key, verdict: "keep", reason: "not mentioned by the assessor" });
		}
	}
	return { items, rationale: typeof record["rationale"] === "string" ? record["rationale"] : "" };
}
