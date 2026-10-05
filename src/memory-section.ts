/**
 * The session-start memory section: a store query rendered into the system
 * prompt (the v0.15 SQLite single-store redesign, ADR
 * `2026-10-06-sqlite-single-store`).
 *
 * The injected index is a query result, not a file: one line per active
 * memory of the assembling agent's workspace, feedback > user > reference,
 * hooks only (title + description). Bodies live in the database and are
 * fetched on demand with `memory_read`; there is no MEMORY.md to maintain
 * and nothing for the model to write directly.
 *
 * Session-freeze contract (the prompt-cache guard): the section is computed
 * once per agent id and reused byte-for-byte afterwards, so the system
 * prompt stays stable within a session and cache reads keep hitting. A
 * memory written mid-session becomes visible in the NEXT session.
 */
import { isAbsolute, join, resolve } from "node:path";
import { memoryGuideIntro, MEMORY_GUIDE_RULES } from "./memory-guide.js";
import type { MemoryStore } from "./store.js";

/** Name of the injected section (unique — duplicate names throw upstream). */
export const MEMORY_SECTION_NAME = "evolve:memory-index";
/** Default prompt-section order (empty 1–499 slot; upstream named slots start at 500). */
export const DEFAULT_MEMORY_SECTION_ORDER = 400;
/** Default hard character budget for the injected index. */
export const DEFAULT_MAX_CHARS = 6000;
/** Sessions whose frozen section text is kept before LRU eviction. */
export const DEFAULT_FROZEN_SESSIONS = 32;

/**
 * Legacy MD-era store location. Only the migration path (`import-md.ts`) and
 * the not-yet-migrated card projection still resolve it; the injection path
 * queries the central database.
 */
export function memoryDirFor(cwd: string): string {
	return join(resolve(cwd), ".evolve", "memory");
}

/** Minimal agent shape the section needs (duck-typed). */
interface CwdAgentLike {
	session?: {
		header?: {
			cwd?: unknown;
			meta?: { cwd?: unknown };
		};
	};
	id?: unknown;
}

/** The assembling agent's validated absolute cwd, or undefined when absent. */
export function cwdOf(agent: unknown): string | undefined {
	try {
		const header = (agent as CwdAgentLike | undefined)?.session?.header;
		const raw = header?.cwd ?? header?.meta?.cwd;
		if (typeof raw !== "string" || raw.trim().length === 0) {
			return undefined;
		}
		const cwd = raw.trim();
		if (!isAbsolute(cwd)) {
			return undefined;
		}
		return resolve(cwd);
	} catch {
		return undefined;
	}
}

/** What fitting the index into the budget produced. */
export interface IndexFit {
	/** Index text actually shown (possibly truncated to a line boundary). */
	text: string;
	/** Characters dropped by the budget, 0 when the index fit whole. */
	dropped: number;
}

/**
 * Whole-line-preserving truncation of the index to `maxChars` characters.
 * Only index rows that fit whole are shown — a partial row would corrupt the
 * line the model reads. When not even one row fits, `text` is "" and
 * `dropped` carries the full length.
 */
export function fitIndex(index: string, maxChars: number): IndexFit {
	const budget = Math.max(0, maxChars);
	if (index.length <= budget) {
		return { text: index, dropped: 0 };
	}
	const cut = index.slice(0, budget);
	const lastLine = cut.lastIndexOf("\n");
	if (lastLine <= 0) {
		return { text: "", dropped: index.length };
	}
	const text = cut.slice(0, lastLine);
	return { text, dropped: index.length - text.length };
}

/** One index line: hook only — bodies are a `memory_read` call away. */
export function indexLineOf(record: {
	id: string;
	title: string;
	description: string;
	type: string;
}): string {
	return `- [${record.id}] ${record.title} — ${record.description}（${record.type}）`;
}

/** Options for {@link memorySectionText}. */
export interface MemorySectionOptions {
	/** The opened store; undefined while it is still loading or failed. */
	store: MemoryStore | undefined;
	/** Hard character budget for the injected index (default 6000). */
	maxChars?: number;
	/** Include the when-to-save guide (default true). */
	guide?: boolean;
	/** Whether `memory_write`/`memory_read` are actually registered on this host. */
	toolsAvailable?: boolean;
}

/**
 * Compose the full memory section for one assembling agent. Any store
 * failure degrades to "" — injection must never break an assembly. With the
 * guide off and an empty store the result is "" — the prompt renderer then
 * drops the section, so an empty workspace costs zero tokens.
 */
export function memorySectionText(agent: unknown, opts: MemorySectionOptions): string {
	const guide = opts.guide ?? true;
	const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
	const cwd = cwdOf(agent);
	if (!cwd || opts.store === undefined) {
		return "";
	}
	let records;
	try {
		records = opts.store.list(cwd);
	} catch {
		return "";
	}
	const index = records.map(indexLineOf).join("\n");
	const { text, dropped } = fitIndex(index, maxChars);

	const parts: string[] = [];
	if (records.length === 0) {
		parts.push("<memories>\n（暂无记忆）\n</memories>");
	} else if (text.length > 0) {
		parts.push(`<memories>\n${text}\n</memories>`);
		if (dropped > 0) {
			parts.push(`（索引超出 ${maxChars} 字符预算，已截断——其余记忆用 \`memory_read\` 关键词检索）`);
		}
	} else {
		parts.push(`（索引超出 ${maxChars} 字符预算，一行都放不下——记忆用 \`memory_read\` 关键词检索）`);
	}
	if (!guide) {
		return records.length === 0 ? "" : parts.join("\n\n");
	}
	return [
		memoryGuideIntro(opts.store.path, cwd, opts.toolsAvailable ?? true),
		...parts,
		MEMORY_GUIDE_RULES,
	].join("\n\n");
}

/** A per-session frozen view of the memory section text. */
export interface FrozenMemorySection {
	/**
	 * The section text for this agent: built on first use per agent id and
	 * reused byte-for-byte afterwards. An agent without an id is rebuilt on
	 * every call (nothing to key the cache on).
	 */
	textFor(agent: unknown, build: (agent: unknown) => string): string;
	/** Sessions currently frozen (test/observability hook). */
	size(): number;
	/** Drop every frozen session (tests; a restart rebuilds naturally). */
	clear(): void;
}

/**
 * Freeze the section text per agent id. The frozen value is what keeps the
 * system prompt stable across a session's assemblies (prompt-cache guard);
 * bounded by `maxSessions` with insertion-order (LRU) eviction, so a
 * long-lived process cannot grow without limit.
 */
export function createFrozenMemorySection(maxSessions: number = DEFAULT_FROZEN_SESSIONS): FrozenMemorySection {
	const limit = Math.max(1, maxSessions);
	const frozen = new Map<string, string>();
	return {
		textFor(agent, build) {
			const id = (agent as CwdAgentLike | undefined)?.id;
			const key = typeof id === "string" && id.length > 0 ? id : undefined;
			if (key === undefined) {
				return build(agent);
			}
			const cached = frozen.get(key);
			if (cached !== undefined) {
				return cached;
			}
			const text = build(agent);
			frozen.set(key, text);
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
