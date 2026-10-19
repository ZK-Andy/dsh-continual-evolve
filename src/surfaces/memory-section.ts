/**
 * The session-start memory section: a store query rendered into the system
 * prompt (the v0.15 SQLite single-store redesign, ADR
 * `2026-10-06-sqlite-single-store`).
 *
 * The injected index is a query result, not a file: one line per active
 * memory of the assembling agent's workspace, feedback > user > reference,
 * hooks only (title + description). Bodies live in the database and are
 * fetched on demand with `evolve_read`; there is no MEMORY.md to maintain
 * and nothing for the model to write directly.
 *
 * Session-freeze contract (the prompt-cache guard): the section is computed
 * once per agent id and reused byte-for-byte afterwards, so the system
 * prompt stays stable within a session and cache reads keep hitting. A
 * memory written mid-session becomes visible in the NEXT session.
 *
 * Two budgets shape what is shown (ADR
 * `2026-10-18-absorb-memory-plugin-strengths`): the hard cap is *tokens*,
 * estimated in `services/token-budget.ts`, and an index that does not fit
 * degrades in tiers — full hook lines, then id-only rows, then a counter
 * line — so a memory the budget could not afford is still discoverable by id
 * instead of vanishing.
 */
import { join, resolve } from "node:path";
import { GLOBAL_WORKSPACE } from "../store.js";
import { cwdOf } from "../services/agent.js";
import { estimateTokens, fitTiered, type IndexRow } from "../services/token-budget.js";
import { memoryGuideIntro, MEMORY_GUIDE_RULES } from "./memory-guide.js";
import type { MemoryStore } from "../store.js";

/** Name of the injected section (unique — duplicate names throw upstream). */
export const MEMORY_SECTION_NAME = "evolve:memory-index";
/** Default prompt-section order (empty 1–499 slot; upstream named slots start at 500). */
export const DEFAULT_MEMORY_SECTION_ORDER = 400;
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

/**
 * One index line: hook only — bodies are an `evolve_read` call away. The hook
 * is the id, the title and the head of the description: the type is carried by
 * the block's ordering (feedback > user > reference) instead of a per-line tag,
 * and the description is clipped so one long hook cannot price out five peers.
 * A row on probation says so: a trial memory is visible on purpose (an unseen
 * memory cannot earn the cross-project use that confirms it), and the marker is
 * what keeps the reader honest about its status.
 */
export function indexLineOf(record: {
	id: string;
	title: string;
	description: string;
	type: string;
	probationUntil?: string | null | undefined;
	notWhen?: string | undefined;
}): string {
	const probation = record.probationUntil === undefined || record.probationUntil === null ? "" : "（试用中）";
	const notWhen = record.notWhen === undefined || record.notWhen === "" ? "" : `（不适用：${clip(record.notWhen, NOT_WHEN_RENDER_LIMIT)}）`;
	const description = record.description === "" ? "" : ` — ${clip(record.description, DESCRIPTION_RENDER_LIMIT)}`;
	return `- [${record.id}] ${record.title}${description}${probation}${notWhen}`;
}

/** Longest rendered description fragment: the index is a hook, not a summary. */
const DESCRIPTION_RENDER_LIMIT = 20;

/** Longest rendered `notWhen` fragment, so one caveat cannot eat the index. */
const NOT_WHEN_RENDER_LIMIT = 60;

/** Clip a rendered fragment at a character boundary, marking the cut. */
function clip(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** The four injection layers, rendered in this fixed order (P6). */
export const INJECTION_LAYERS = ["User Profile", "Project Meta", "Project Memory", "Feedback Memory"] as const;

/** One injection layer name. */
export type InjectionLayer = (typeof INJECTION_LAYERS)[number];

/** The conflict rule rendered last inside the block: this round wins over memory. */
export const INJECTION_CONFLICT_RULE = "与本轮指令冲突以本轮为准";

/**
 * Map one listed record to its layer: person-level facts first, then global
 * reference, project reference, and feedback last. The partition
 * (`workspaceId === GLOBAL_WORKSPACE`) is the scope signal — the row `scope`
 * column carries legacy values and is not read here. This grouping rides on
 * top of the row-level `MEMORIES_ORDER` in `data/resource-kinds.ts` (which
 * decides order, this decides headings); change one and check the other.
 */
export function layerOf(record: { type: string; workspaceId: string }): InjectionLayer {
	if (record.type === "user") {
		return "User Profile";
	}
	if (record.type === "feedback") {
		return "Feedback Memory";
	}
	return record.workspaceId === GLOBAL_WORKSPACE ? "Project Meta" : "Project Memory";
}

/** Options for {@link buildSection}. */
export interface SectionOptions {
	/** The opened store; undefined while it is still loading or failed. */
	store: MemoryStore | undefined;
	/** Hard token budget for the injected index (default 6000). */
	maxTokens?: number | undefined;
	/** Include the when-to-save guide (default true). */
	guide?: boolean | undefined;
	/** Whether `evolve_write`/`evolve_read` are actually registered on this host. */
	toolsAvailable?: boolean | undefined;
}

/** One built section: the text plus the facts the accounting records. */
export interface SectionBuild {
	/** The rendered section text ("" when there is nothing to inject). */
	text: string;
	/** Memory ids the index named — full rows and id-only rows alike. */
	ids: string[];
	/** Estimated tokens of the rendered index (guide text excluded). */
	tokens: number;
	/** Rows rendered in full. */
	fullCount: number;
	/** Rows rendered as ids only. */
	idOnlyCount: number;
	/** Rows the budget dropped entirely (named in the counter line). */
	omittedCount: number;
}

/** The empty build: nothing to inject, nothing to account. */
const EMPTY_BUILD: SectionBuild = {
	text: "",
	ids: [],
	tokens: 0,
	fullCount: 0,
	idOnlyCount: 0,
	omittedCount: 0,
};

/**
 * Compose the full memory section for one assembling agent. Any store failure
 * degrades to an empty section — injection never breaks an assembly.
 */
export function buildSection(agent: unknown, opts: SectionOptions): SectionBuild {
	const guide = opts.guide ?? true;
	const maxTokens = opts.maxTokens ?? 0;
	const cwd = cwdOf(agent);
	if (!cwd || opts.store === undefined) {
		return EMPTY_BUILD;
	}
	let records;
	try {
		records = opts.store.list(cwd);
	} catch {
		return EMPTY_BUILD;
	}
	const rows: IndexRow[] = records.map((record) => ({
		id: record.id,
		line: indexLineOf({ ...record, notWhen: record.notWhen }),
	}));
	// Rows and records share `list` order, so the layer of row i is the layer
	// of record i. The fit stays global (one budget for the whole index);
	// grouping only decides where each fitted line renders.
	const layerByIndex = records.map((record) => layerOf(record));
	const fit = fitTiered(rows, maxTokens);
	const ids = [...rows.slice(0, fit.fullCount + fit.idOnlyCount).map((row) => row.id)];
	let fittedTokens = fit.tokens;

	const parts: string[] = [];
	if (records.length === 0) {
		parts.push("<memories>\n（暂无记忆）\n</memories>");
	} else if (fit.fullCount + fit.idOnlyCount > 0) {
		const lines: string[] = [];
		const chrome: string[] = [];
		for (const layer of INJECTION_LAYERS) {
			const group: string[] = [];
			for (let i = 0; i < fit.fullCount; i++) {
				if (layerByIndex[i] === layer) {
					group.push(rows[i]?.line ?? "");
				}
			}
			for (let i = fit.fullCount; i < fit.fullCount + fit.idOnlyCount; i++) {
				if (layerByIndex[i] === layer) {
					group.push(`- [${rows[i]?.id ?? ""}]`);
				}
			}
			if (group.length === 0) {
				continue;
			}
			const heading = `## ${layer}`;
			chrome.push(heading);
			lines.push(heading, ...group);
		}
		chrome.push(INJECTION_CONFLICT_RULE);
		lines.push(INJECTION_CONFLICT_RULE);
		parts.push(`<memories>\n${lines.join("\n")}\n</memories>`);
		// Headings and the rule ride outside the row budget, but the ledger
		// still accounts them so `estTokens` stays honest.
		fittedTokens = fit.tokens + estimateTokens(chrome.join("\n"));
	} else {
		parts.push(`（索引超出 ${String(maxTokens)} token 预算，一条都放不下——记忆用 \`evolve_read\` 关键词检索）`);
	}
	const body = guide
		? [memoryGuideIntro(opts.store.path, cwd, opts.toolsAvailable ?? true), ...parts, MEMORY_GUIDE_RULES].join("\n\n")
		: records.length === 0
			? ""
			: parts.join("\n\n");
	return {
		text: body,
		ids,
		tokens: fittedTokens,
		fullCount: fit.fullCount,
		idOnlyCount: fit.idOnlyCount,
		omittedCount: fit.omittedCount,
	};
}

/** What an assembly reported about a freshly built section. */
export interface SectionBuildInfo {
	/** The workspace whose partition was rendered. */
	workspace: string;
	/** The agent (session) the section was frozen for, when the host named one. */
	sessionId: string | undefined;
	/** Memory ids named by the index. */
	ids: string[];
	/** Estimated tokens of the rendered index. */
	tokens: number;
	/** Rows rendered in full / as ids / dropped. */
	fullCount: number;
	idOnlyCount: number;
	omittedCount: number;
}

/** Options for {@link createSectionRenderer}. */
export interface SectionRendererOptions {
	/** The store as it becomes ready (undefined until then). */
	readStore: () => MemoryStore | undefined;
	/** The per-session freeze. */
	frozen: FrozenMemorySection;
	/** Resolve the token budget at call time (config + migration marker). */
	readBudget: () => number;
	/** Whether the injected guide is shown (default true). */
	guide?: boolean | undefined;
	/** Whether the write/read tools are registered (default true). */
	toolsAvailable?: () => boolean;
	/** Runs before the first build for a workspace (legacy MD import). */
	prepare?: (cwd: string) => void;
	/** Called once per freshly built section — never on a frozen hit. */
	onBuilt?: (info: SectionBuildInfo) => void;
}

/** The renderer the plugin root registers with the host. */
export interface SectionRenderer {
	/** Section text for one assembly; "" while the store is unavailable. */
	text: (context: { agent?: unknown }) => string;
}

/**
 * Build the section renderer. The root registers `text` and nothing else; the
 * freeze, the budget and the build accounting live here so the entry point
 * stays an entry point.
 */
export function createSectionRenderer(opts: SectionRendererOptions): SectionRenderer {
	return {
		text(context) {
			const store = opts.readStore();
			if (store === undefined) {
				// Still loading or unavailable: render nothing and freeze nothing.
				return "";
			}
			const cwd = cwdOf(context.agent);
			if (cwd !== undefined && opts.prepare !== undefined) {
				try {
					opts.prepare(cwd);
				} catch {
					// The legacy import is best-effort; a failure never blocks injection.
				}
			}
			let built: SectionBuild | undefined;
			const { text, built: isBuild } = opts.frozen.textForMeta(context.agent, (agent) => {
				const section = buildSection(agent, {
					store,
					maxTokens: opts.readBudget(),
					guide: opts.guide ?? true,
					toolsAvailable: opts.toolsAvailable?.() ?? true,
				});
				built = section;
				return section.text;
			});
			if (isBuild && built !== undefined && opts.onBuilt !== undefined) {
				try {
					opts.onBuilt({
						workspace: cwd ?? "",
						sessionId: sessionIdOf(context.agent),
						ids: built.ids,
						tokens: built.tokens,
						fullCount: built.fullCount,
						idOnlyCount: built.idOnlyCount,
						omittedCount: built.omittedCount,
					});
				} catch {
					// Accounting never fails the assembly it rides on.
				}
			}
			return text;
		},
	};
}

/** The agent's session id when the host exposes one. */
function sessionIdOf(agent: unknown): string | undefined {
	const id = (agent as { id?: unknown } | undefined)?.id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** A per-session frozen view of the memory section text. */
export interface FrozenMemorySection {
	/**
	 * The section text for this agent: built on first use per agent id and
	 * reused byte-for-byte afterwards. An agent without an id is rebuilt on
	 * every call (nothing to key the cache on).
	 */
	textFor(agent: unknown, build: (agent: unknown) => string): string;
	/**
	 * Same freeze, but also reports whether this call built the text. Used by
	 * the accounting path, which must not count a frozen hit as a new exposure.
	 */
	textForMeta(agent: unknown, build: (agent: unknown) => string): { text: string; built: boolean };
	/** Sessions currently frozen (test/observability hook). */
	size(): number;
	/** Drop every frozen session (tests; a restart rebuilds naturally). */
	clear(): void;
	/**
	 * Drop one session's frozen text (post-compact re-injection, P6): the next
	 * assembly for that session rebuilds, other sessions keep their cache.
	 * Unknown ids are a no-op. The key is the agent id `sessionIdOf` reads.
	 */
	invalidate(sessionId: string): void;
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
	const meta = {
		textForMeta(agent: unknown, build: (agent: unknown) => string): { text: string; built: boolean } {
			const id = (agent as { id?: unknown } | undefined)?.id;
			const key = typeof id === "string" && id.length > 0 ? id : undefined;
			if (key === undefined) {
				return { text: build(agent), built: true };
			}
			const cached = frozen.get(key);
			if (cached !== undefined) {
				return { text: cached, built: false };
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
			return { text, built: true };
		},
	};
	return {
		textFor: (agent, build) => meta.textForMeta(agent, build).text,
		textForMeta: meta.textForMeta,
		size: () => frozen.size,
		clear: () => frozen.clear(),
		invalidate: (sessionId) => {
			frozen.delete(sessionId);
		},
	};
}
