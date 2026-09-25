/**
 * Targeted memory recall (P1): the precise-reading counterpart of the cheap
 * directory index.
 *
 * The injected directory view (`inject.ts`) shows one line per entry and the
 * full `evolve_list` dumps whole stores; neither answers "give me everything
 * about X". Recall fills that gap: filter by query/kind/scope/memory-type,
 * rank with the same CJK BM25 machinery as injection, and return full
 * content plus source, version, and staleness signals. Read-only — it never
 * mutates a store.
 */
import type { EvolutionEngine } from "./service.js";
import { buildRelevanceIndex, relevanceScore } from "./search.js";
import { CONFLICT_HINT_KEY } from "./types.js";
import { isArchived, isMemoryType, ARCHIVED_AT_KEY, MEMORY_TYPE_KEY, SOURCE_SEQS_KEY, SOURCE_SESSION_KEY } from "./types.js";
import type { HarnessEntry, HarnessScope, RefinementKind } from "./types.js";

/** Memory recall types (the `memoryType` taxonomy, not entry kinds). */
export const RECALL_MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type RecallMemoryType = (typeof RECALL_MEMORY_TYPES)[number];

/** Entry kinds recall can filter on; memory is the default. */
const RECALL_KINDS: RefinementKind[] = ["prompt", "memory", "skill", "subagent"];

/** Default and maximum hits returned per recall call. */
export const DEFAULT_RECALL_LIMIT = 10;
export const MAX_RECALL_LIMIT = 50;

export interface RecallFilters {
	/** Free-text relevance query; empty means "most recently updated first". */
	query?: string;
	/** Entry kinds to search; default is memory only. */
	kinds?: RefinementKind[];
	/** Stores to search; default is local + project + global. */
	scopes?: HarnessScope[];
	/** Memory-type filter (applies to memory entries only). */
	memoryTypes?: RecallMemoryType[];
	/** Maximum hits; clamped to 1..50, defaults to 10. */
	limit?: number;
	/** Include archived entries; default false. */
	includeArchived?: boolean;
}

/** One recalled entry with full content and provenance. */
export interface RecallHit {
	scope: HarnessScope;
	kind: RefinementKind;
	id: string;
	title: string;
	content: string;
	path: string;
	version: number;
	createdAt: string;
	updatedAt: string;
	archived: boolean;
	/** Memory-type hook for memory entries; undefined for other kinds. */
	memoryType?: string;
	/** Conflict-hint stamp left by the promotion guard, when present. */
	staleHint?: string;
	/** Session the entry was distilled from, when recorded. */
	sourceSession?: string;
	/** Source user-message seqs, when recorded. */
	sourceSeqs?: number[];
}

export interface RecallResult {
	hits: RecallHit[];
	/** Skipped scopes with reasons (read-path honesty: never silently drop a store). */
	notes: string[];
	/** Candidates seen before ranking/truncation. */
	totalCandidates: number;
}

export interface RecallContext {
	/** Live session id for the local store; absent → local is skipped with a note. */
	sessionId?: string | undefined;
	/** Resolved project key; absent → project is skipped with a note. */
	projectKey?: string | undefined;
}

/**
 * Search the harness stores with mechanical filters and BM25 ranking.
 *
 * @param engine The evolution engine (read-only use).
 * @param context Store identities for the session-scoped stores.
 * @param filters Query/kind/scope/type/limit/archive filters.
 * @returns Ranked hits plus a note for every scope that could not be read.
 * @throws On an unknown kind, scope, or memory type — fail loud instead of
 *         silently narrowing the search.
 */
export function recallMemories(engine: EvolutionEngine, context: RecallContext, filters: RecallFilters = {}): RecallResult {
	const kinds = filters.kinds ?? ["memory"];
	for (const kind of kinds) {
		if (!RECALL_KINDS.includes(kind)) {
			throw new Error(`evolve_recall: unknown kind "${kind}" (expected one of ${RECALL_KINDS.join(", ")})`);
		}
	}
	const scopes = filters.scopes ?? ["local", "project", "global"];
	for (const scope of scopes) {
		if (scope !== "local" && scope !== "project" && scope !== "global") {
			throw new Error(`evolve_recall: unknown scope "${scope}" (expected local, project, or global)`);
		}
	}
	const memoryTypes = filters.memoryTypes ?? [];
	for (const memoryType of memoryTypes) {
		if (!(RECALL_MEMORY_TYPES as readonly string[]).includes(memoryType)) {
			throw new Error(`evolve_recall: unknown memoryType "${memoryType}" (expected one of ${RECALL_MEMORY_TYPES.join(", ")})`);
		}
	}
	const limit = typeof filters.limit === "number" && Number.isFinite(filters.limit) && filters.limit > 0
		? Math.min(Math.floor(filters.limit), MAX_RECALL_LIMIT)
		: DEFAULT_RECALL_LIMIT;
	const query = filters.query?.trim() ?? "";

	const candidates: HarnessEntry[] = [];
	const notes: string[] = [];
	for (const scope of scopes) {
		const storeId = scope === "local" ? context.sessionId : scope === "project" ? context.projectKey : undefined;
		if (scope !== "global" && storeId === undefined) {
			notes.push(`${scope} store skipped: ${scope === "local" ? "no live session id" : "no project key for this session"}`);
			continue;
		}
		let state;
		try {
			state = engine.load(scope, storeId);
		} catch (cause) {
			notes.push(`${scope} store unreadable: ${cause instanceof Error ? cause.message : String(cause)}`);
			continue;
		}
		for (const kind of kinds) {
			for (const entry of Object.values(state.entries[kind])) {
				if (!filters.includeArchived && isArchived(entry)) continue;
				if (kind === "memory" && memoryTypes.length > 0) {
					const type = entry.metadata[MEMORY_TYPE_KEY];
					if (typeof type !== "string" || !memoryTypes.includes(type as RecallMemoryType)) continue;
				}
				candidates.push(entry);
			}
		}
	}

	const ranked = query.length > 0 ? rankByRelevance(candidates, query) : [...candidates].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
	return { hits: ranked.slice(0, limit).map(toRecallHit), notes, totalCandidates: candidates.length };
}

function rankByRelevance(candidates: HarnessEntry[], query: string): HarnessEntry[] {
	const index = buildRelevanceIndex(candidates);
	const normalized = query.trim().toLowerCase();
	return candidates
		.map((entry) => {
			let score = relevanceScore(index, entry, query);
			// Exact scope:id addressing wins over fuzzy relevance (the
			// memory-agent manifest search precedent).
			if (`${entry.scope}:${entry.id}`.toLowerCase() === normalized) score += 1000;
			return { entry, score };
		})
		.filter((hit) => hit.score > 0)
		.sort((a, b) => b.score - a.score || (a.entry.updated_at < b.entry.updated_at ? 1 : -1))
		.map((hit) => hit.entry);
}

function toRecallHit(entry: HarnessEntry): RecallHit {
	const memoryType = entry.kind === "memory" && isMemoryType(entry.metadata[MEMORY_TYPE_KEY])
		? String(entry.metadata[MEMORY_TYPE_KEY])
		: undefined;
	const staleHint = typeof entry.metadata[CONFLICT_HINT_KEY] === "string" && (entry.metadata[CONFLICT_HINT_KEY] as string).length > 0
		? String(entry.metadata[CONFLICT_HINT_KEY])
		: undefined;
	const sourceSession = typeof entry.metadata[SOURCE_SESSION_KEY] === "string" ? String(entry.metadata[SOURCE_SESSION_KEY]) : undefined;
	const rawSeqs = entry.metadata[SOURCE_SEQS_KEY];
	const sourceSeqs = Array.isArray(rawSeqs) && rawSeqs.every((seq) => typeof seq === "number") ? (rawSeqs as number[]) : undefined;
	return {
		scope: entry.scope,
		kind: entry.kind,
		id: entry.id,
		title: entry.title,
		content: entry.content,
		path: entry.path,
		version: entry.version,
		createdAt: entry.created_at,
		updatedAt: entry.updated_at,
		archived: isArchived(entry),
		...(memoryType !== undefined ? { memoryType } : {}),
		...(staleHint !== undefined ? { staleHint } : {}),
		...(sourceSession !== undefined ? { sourceSession } : {}),
		...(sourceSeqs !== undefined ? { sourceSeqs } : {}),
	};
}

/**
 * Render recall hits for a model or human reader: full content, version,
 * source, and staleness on every hit; skipped scopes are always shown so
 * "no results" can never hide an unread store.
 */
export function formatRecallResult(result: RecallResult, query?: string): string {
	const lines = [`recall: ${result.hits.length} hit(s)${query?.trim() ? ` for "${query.trim()}"` : ""} (${result.totalCandidates} candidate(s))`];
	for (const hit of result.hits) {
		const type = hit.memoryType !== undefined ? ` · type=${hit.memoryType}` : "";
		const archived = hit.archived ? " · archived" : "";
		const stale = hit.staleHint !== undefined ? ` · conflict-hint=${hit.staleHint}` : "";
		const source = hit.sourceSession !== undefined ? ` · src=${hit.sourceSession}${hit.sourceSeqs ? `:${hit.sourceSeqs.join(",")}` : ""}` : "";
		lines.push(`- [${hit.scope}:${hit.kind}:${hit.id}] ${hit.title} (v${hit.version}${type}${archived}${stale}${source})`);
		lines.push(`  ${hit.content}`);
	}
	for (const note of result.notes) {
		lines.push(`note: ${note}`);
	}
	if (result.hits.length === 0) {
		lines.push(`(${ARCHIVED_AT_KEY} entries are hidden unless includeArchived is set)`);
	}
	return lines.join("\n");
}
