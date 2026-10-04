/**
 * The whole runtime of the plugin after the 2026-10-04 ZCode-alignment
 * teardown: the session-start memory section.
 *
 * The store is plain markdown inside the workspace — `<cwd>/.evolve/memory/`
 * with a `MEMORY.md` index and one file per fact — so the model reads and
 * writes it with its native file tools (DSH fences only out-of-workspace
 * writes; dot-directories inside the workspace pass both ways). This module
 * hands out the absolute path, injects the index content, and wraps the
 * when-to-save guide around it. There are no tools, no scopes, and no
 * governance: the files are the store, and a bad memory is a visible file
 * the user deletes.
 *
 * Session-freeze contract (the prompt-cache guard): the section is computed
 * once per agent id and reused byte-for-byte afterwards, so the system
 * prompt stays stable within a session and cache reads keep hitting. A
 * memory written mid-session becomes visible in the NEXT session; the model
 * can always read the directory directly for the immediate need.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { MEMORY_GUIDE_RULES, memoryGuideIntro } from "./memory-guide.js";

/** Name of the injected section (unique — duplicate names throw upstream). */
export const MEMORY_SECTION_NAME = "evolve:memory-index";
/** Default prompt-section order (empty 1–499 slot; upstream named slots start at 500). */
export const DEFAULT_MEMORY_SECTION_ORDER = 400;
/** Default hard character budget for the injected index. */
export const DEFAULT_MAX_CHARS = 6000;
/** Sessions whose frozen section text is kept before LRU eviction. */
export const DEFAULT_FROZEN_SESSIONS = 32;

const MEMORY_DIR_SEGMENTS = [".evolve", "memory"] as const;
const INDEX_FILE = "MEMORY.md";

/** Starter index written on first use; the model maintains every line after. */
const STARTER_INDEX =
	"# 记忆索引\n\n<!-- 一行一条：- [标题](文件名.md) — 一句话相关性钩子；写新记忆后在此追加一行 -->\n";

/** Appended to the workspace .gitignore on bootstrap (git workspaces only). */
const GITIGNORE_ENTRY = "# workspace memory (dsh-continual-evolve)\n.evolve/\n";

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

/** Absolute memory directory for a workspace root. */
export function memoryDirFor(cwd: string): string {
	return join(resolve(cwd), ...MEMORY_DIR_SEGMENTS);
}

/**
 * Ensure `.evolve/` is ignored when the workspace is a git repository, so
 * the memory store never shows up in git status. Best-effort hygiene: a
 * non-git workspace (no `.git` entry at the cwd) is left untouched — no
 * `.gitignore` is created — and any write failure is swallowed.
 */
export function ensureGitIgnored(cwd: string): void {
	try {
		if (!existsSync(join(cwd, ".git"))) {
			return;
		}
		const gitignore = join(cwd, ".gitignore");
		const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
		if (existing.split("\n").some((line) => line.trim() === ".evolve/")) {
			return;
		}
		const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
		writeFileSync(gitignore, `${existing}${prefix}${GITIGNORE_ENTRY}`, "utf8");
	} catch {
		// Never blocks the store; worst case is a visible .evolve/ in git status.
	}
}

/**
 * Ensure the store exists (creating the directory and a starter index on
 * first use), then return the trimmed index text. Any filesystem failure
 * degrades to "" — injection must never break an assembly.
 */
export function readMemoryIndex(dir: string, bootstrap: boolean = true): string {
	try {
		if (bootstrap && !existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, INDEX_FILE), STARTER_INDEX, "utf8");
			ensureGitIgnored(resolve(dir, "..", ".."));
		}
		return readFileSync(join(dir, INDEX_FILE), "utf8").trim();
	} catch {
		return "";
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
 * Only index rows that fit whole are shown — a partial markdown row would
 * corrupt the line the model reads. When not even one row fits, `text` is
 * "" and `dropped` carries the full length.
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

/** Options for {@link memorySectionText}. */
export interface MemorySectionOptions {
	/** Hard character budget for the injected index (default 6000). */
	maxChars?: number;
	/** Include the when_to_save guide (default true). */
	guide?: boolean;
	/** Skip store bootstrap (tests). */
	bootstrap?: boolean;
}

/**
 * Compose the full memory section for one assembling agent: the guide
 * wrapped around the budget-bounded index, with the absolute store path
 * handed out so the model can read and write the files directly. With the
 * guide off and an empty index the result is "" — the prompt renderer then
 * drops the section, so an empty workspace costs zero tokens.
 */
export function memorySectionText(agent: unknown, opts?: MemorySectionOptions): string {
	const guide = opts?.guide ?? true;
	const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
	const cwd = cwdOf(agent);
	if (!cwd) {
		return "";
	}
	const dir = memoryDirFor(cwd);
	const index = readMemoryIndex(dir, opts?.bootstrap ?? true);
	const { text, dropped } = fitIndex(index, maxChars);

	const parts: string[] = [];
	if (index.length === 0) {
		parts.push("<memories>\n（暂无记忆）\n</memories>");
	} else if (text.length > 0) {
		parts.push(`<memories>\n${text}\n</memories>`);
		if (dropped > 0) {
			parts.push(`（索引超出 ${maxChars} 字符预算，已截断——其余记忆直接读取 \`${dir}/\` 目录）`);
		}
	} else {
		parts.push(`（索引超出 ${maxChars} 字符预算，一行都放不下——记忆直接读取 \`${dir}/\` 目录）`);
	}
	if (!guide) {
		return index.length === 0 ? "" : parts.join("\n\n");
	}
	return [memoryGuideIntro(dir), ...parts, MEMORY_GUIDE_RULES].join("\n\n");
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
