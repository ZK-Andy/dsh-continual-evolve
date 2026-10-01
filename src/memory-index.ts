/**
 * evolve v2 — the passive read path: the `evolve:memory-index` system-prompt
 * section that puts memory CONTENT in front of the model at session start.
 *
 * Why not just hand out a path: the memory store lives in `<dshHome>/evolve/`,
 * outside the workspace sandbox, so the model's read tool cannot open it.
 * The section therefore carries the entries themselves — full body while the
 * character budget allows, then one-line index rows, then a `evolve_recall`
 * pointer for the rest. Budget is hard: a bounded prompt beats an unbounded one.
 *
 * Session-freeze contract (the prompt-cache guard): the section is computed
 * once per session and reused byte-for-byte afterwards, so the system prompt
 * stays stable within a session and cache reads keep hitting. A memory written
 * mid-session becomes visible in the NEXT session; `evolve_recall` covers the
 * immediate need. See `.agents/notes/proposed/feature/2026-10-01-evolve-v2-passive-read-write.md`.
 */
import type { HarnessEntry } from "./types.js";
import { MEMORY_TYPE_KEY, isArchived, isMemoryType, type MemoryRecallType } from "./types.js";
import type { EvolutionEngine } from "./service.js";
import { recordInjection } from "./usage.js";
import { MEMORY_GUIDE_INTRO, MEMORY_GUIDE_RULES } from "./memory-guide.js";
import { directoryLine, mergedInjectionState, recencyScore, type AgentLike } from "./inject.js";

/** Hard character budget for the `<memories>` block. */
export const DEFAULT_MEMORY_INDEX_MAX_CHARS = 6000;
/** Prompt-section order of the memory index (empty 1–499 slot, see ADR). */
export const DEFAULT_MEMORY_SECTION_ORDER = 400;
/** Sessions whose frozen section text is kept before LRU eviction. */
export const DEFAULT_FROZEN_SESSIONS = 32;
/** Name of the injected section (unique — duplicate names throw upstream). */
export const MEMORY_SECTION_NAME = "evolve:memory-index";

/**
 * Recall-type priority for the budget: durable, behavior-shaping types first.
 * `project` (current work context) > `feedback` (how to behave) > `user` (who
 * the user is) > `reference` (external pointers). Entries without a valid
 * memoryType sink below every typed entry.
 */
export const MEMORY_TYPE_PRIORITY: Record<MemoryRecallType, number> = {
	project: 0,
	feedback: 1,
	user: 2,
	reference: 3,
};

/** Priority of an entry whose metadata carries no valid recall type. */
const UNTYPED_PRIORITY = 4;

/** The entry's recall type, or undefined when the metadata key is absent/invalid. */
export function memoryTypeOf(entry: HarnessEntry): MemoryRecallType | undefined {
	const value = entry.metadata[MEMORY_TYPE_KEY];
	return isMemoryType(value) ? value : undefined;
}

/** Deterministic final tiebreak (matches `inject.ts` ranking). */
function stableCompare(a: HarnessEntry, b: HarnessEntry): number {
	return [a.path, a.title, a.id].join("\0").localeCompare([b.path, b.title, b.id].join("\0"));
}

/**
 * Order memories for injection: recall-type priority first
 * ({@link MEMORY_TYPE_PRIORITY}), then recency (newest first), then the stable
 * dictionary order — deterministic for equal inputs, so a frozen section is
 * reproducible across builds. The input is never mutated.
 */
export function rankMemories(entries: readonly HarnessEntry[], now: number = Date.now()): HarnessEntry[] {
	return [...entries].sort((a, b) => {
		const aType = memoryTypeOf(a);
		const bType = memoryTypeOf(b);
		const priorityDelta =
			(aType ? MEMORY_TYPE_PRIORITY[aType] : UNTYPED_PRIORITY) - (bType ? MEMORY_TYPE_PRIORITY[bType] : UNTYPED_PRIORITY);
		if (priorityDelta !== 0) {
			return priorityDelta;
		}
		const recencyDelta = recencyScore(b, now) - recencyScore(a, now);
		if (recencyDelta !== 0) {
			return recencyDelta;
		}
		return stableCompare(a, b);
	});
}

/** One memory rendered in full, as a list item with the body indented. */
export function memoryFullLine(entry: HarnessEntry): string {
	const type = memoryTypeOf(entry);
	const body = entry.content.trim().replace(/\n/g, "\n  ");
	const head = `- [memory${type ? `:${type}` : ""}:${entry.id}] ${entry.title}`;
	return body.length > 0 ? `${head}\n  ${body}` : head;
}

/** What a budget-bounded memory block shows. */
export interface MemorySelection {
	/** Entries rendered with their full body, in display order. */
	full: HarnessEntry[];
	/** Entries degraded to a one-line index row (`id` + title hook). */
	indexed: HarnessEntry[];
	/** Entries that fit neither and are only counted. */
	dropped: number;
	/** Entries actually shown (full + indexed), in display order. */
	shown: HarnessEntry[];
}

/**
 * Greedy budget fill over {@link rankMemories}: each entry takes the full body
 * while it fits, otherwise degrades to an index row, otherwise is dropped —
 * and because the ranking is fixed, the first entry that fits neither means
 * every later one is dropped too (their rows are no smaller).
 */
export function selectMemoryInjection(entries: readonly HarnessEntry[], maxChars: number = DEFAULT_MEMORY_INDEX_MAX_CHARS): MemorySelection {
	const visible = entries.filter((entry) => !isArchived(entry));
	const ranked = rankMemories(visible);
	const budget = Math.max(0, maxChars);
	const full: HarnessEntry[] = [];
	const indexed: HarnessEntry[] = [];
	const shown: HarnessEntry[] = [];
	let used = 0;
	let dropped = 0;
	for (const entry of ranked) {
		const fullLine = memoryFullLine(entry);
		if (used + fullLine.length <= budget) {
			full.push(entry);
			shown.push(entry);
			used += fullLine.length;
			continue;
		}
		const indexLine = directoryLine(entry);
		if (used + indexLine.length <= budget) {
			indexed.push(entry);
			shown.push(entry);
			used += indexLine.length;
			continue;
		}
		dropped = ranked.length - shown.length;
		break;
	}
	return { full, indexed, dropped, shown };
}

/** The `evolve_recall` pointer appended when rows had to be degraded or dropped. */
export const MEMORY_OVERFLOW_HINT = "- 更多记忆可用 evolve_recall 按需读取";

/**
 * Render a selection as the `<memories>` block, or "" when nothing is shown.
 * Full bodies come first in display order, then the degraded index rows, then
 * the `evolve_recall` pointer with the degradation/drop counts.
 */
export function renderMemorySelection(selection: MemorySelection): string {
	const { full, indexed, dropped, shown } = selection;
	if (shown.length === 0) {
		return "";
	}
	const lines: string[] = [];
	for (const entry of full) {
		lines.push(memoryFullLine(entry));
	}
	for (const entry of indexed) {
		lines.push(directoryLine(entry));
	}
	const omitted: string[] = [];
	if (indexed.length > 0) {
		omitted.push(`${indexed.length} 条仅列索引`);
	}
	if (dropped > 0) {
		omitted.push(`${dropped} 条未列出`);
	}
	lines.push(omitted.length > 0 ? `${MEMORY_OVERFLOW_HINT}（${omitted.join("，")}）` : MEMORY_OVERFLOW_HINT);
	return `<memories>\n${lines.join("\n")}\n</memories>`;
}

/** {@link renderMemorySelection} over a fresh selection (convenience). */
export function formatMemoriesBlock(entries: readonly HarnessEntry[], maxChars: number = DEFAULT_MEMORY_INDEX_MAX_CHARS): string {
	return renderMemorySelection(selectMemoryInjection(entries, maxChars));
}

/** Options for {@link memoryIndexSectionText}. */
export interface MemoryIndexOptions {
	/** Hard budget for the memories block (default 6000). */
	maxChars?: number;
	/** Include the when_to_save guide (default true). */
	guide?: boolean;
	/** Pin the project layer explicitly (tests/tools); otherwise derived from cwd. */
	projectKey?: string;
}

/**
 * Compose the full `evolve:memory-index` section for one assembling agent:
 * the persistent-memory guide (when to save / how to maintain) wrapped around
 * the budget-bounded memories block. With the guide off and no memories the
 * result is "" — the prompt renderer then drops the section, so an empty store
 * keeps costing zero tokens.
 *
 * Injection usage is recorded for everything shown (best-effort; a failure
 * never blocks injection), deduped per session by {@link recordInjection}.
 */
export function memoryIndexSectionText(
	engine: EvolutionEngine,
	agent: AgentLike | undefined,
	opts?: MemoryIndexOptions,
): string {
	if (!agent) {
		return "";
	}
	const guide = opts?.guide ?? true;
	const maxChars = opts?.maxChars ?? DEFAULT_MEMORY_INDEX_MAX_CHARS;
	const merged = mergedInjectionState(engine, agent, opts);
	const selection = selectMemoryInjection(Object.values(merged.entries.memory), maxChars);
	const block = renderMemorySelection(selection);

	if (selection.shown.length > 0) {
		try {
			recordInjection(engine.baseDir, selection.shown.map((entry) => `${entry.kind}:${entry.id}`), agent.id);
		} catch {
			// Usage recording is diagnostic; never interrupt the injection path.
		}
	}

	if (!guide) {
		return block;
	}
	return [MEMORY_GUIDE_INTRO, block.length > 0 ? block : "<memories>\n（暂无记忆）\n</memories>", MEMORY_GUIDE_RULES].join("\n\n");
}

/** A per-session frozen view of the memory section text. */
export interface FrozenMemorySection {
	/**
	 * The section text for this agent: built on first use per `agent.id` and
	 * reused byte-for-byte afterwards. `undefined` agent → "" (unbuilt).
	 */
	textFor(agent: AgentLike | undefined, build: (agent: AgentLike) => string): string;
	/** Sessions currently frozen (test/observability hook). */
	size(): number;
	/** Drop every frozen session (tests; a restart rebuilds naturally). */
	clear(): void;
}

/**
 * Freeze the section text per session id. The frozen value is what keeps the
 * system prompt stable across a session's assemblies (prompt-cache guard);
 * bounded by `maxSessions` with insertion-order (LRU) eviction, so a long-lived
 * process cannot grow without limit.
 */
export function createFrozenMemorySection(maxSessions: number = DEFAULT_FROZEN_SESSIONS): FrozenMemorySection {
	const limit = Math.max(1, maxSessions);
	const frozen = new Map<string, string>();
	return {
		textFor(agent, build) {
			if (!agent) {
				return "";
			}
			const cached = frozen.get(agent.id);
			if (cached !== undefined) {
				return cached;
			}
			const text = build(agent);
			frozen.set(agent.id, text);
			while (frozen.size > limit) {
				const oldest = frozen.keys().next();
				if (oldest.done === true) {
					break;
				}
				frozen.delete(oldest.value);
			}
			return text;
		},
		size: () => frozen.size,
		clear: () => frozen.clear(),
	};
}
