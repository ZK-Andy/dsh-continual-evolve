/**
 * dsh-continual-evolve — plugin entry.
 *
 * The v0.15 SQLite single-store redesign (ADR
 * `2026-10-06-sqlite-single-store`): every memory lives in one central
 * database (`~/.dsh/evolve/memory.db`, rows partitioned by workspace path)
 * and the plugin's code is the literal sole writer. This entry wires four
 * surfaces over the store:
 *
 * - the session-start section (`memory-section.ts`): a store query rendered
 *   as the injected index, frozen per session for the prompt cache;
 * - the model tools (`surfaces/evolve-tools.ts`): `evolve_write` for every
 *   explicit "记住/忘掉/沉淀" instruction (`kind` selects memory vs skill
 *   vs prompt) and `evolve_read` for bodies and search;
 * - the extraction scheduler (`services/extraction.ts`): turn-level,
 *   per-session slots, single-flight per session; proposals land only
 *   through the store's gates;
 * - the memory + settings cards (`pages/memory-card/`): the memory
 *   projection plus the global review-settings surface in the official
 *   plugin manager.
 *
 * Mounting itself is delegated: the four generic mounts (tools, extraction,
 * review, creator skills) live in `./assemble.js`, the card mounts in
 * `./pages/memory-card/mount.js` — this entry keeps config, host shapes,
 * and the apply orchestration.
 *
 * The store opens asynchronously (dynamic `node:sqlite` import); until it is
 * ready — or forever, if the runtime lacks `node:sqlite` — the section
 * renders "" and the tools never register. Injection must never break an
 * assembly, and a degraded plugin must never take the host down.
 *
 * The host API surface is declared locally (the minimal shapes this plugin
 * touches) instead of importing the DSH type packages — verified in
 * production across every prior release.
 */
import z from "@deepseek-ai/schemastery";
import { mountCardWhenAvailable, mountSettingsPresentation } from "./pages/memory-card/mount.js";
import type { ReviewSettingsSnapshot } from "./pages/memory-card/settings.js";
import {
	mountCreatorSkillsWhenAvailable,
	mountExtractionWhenAvailable,
	mountReviewWhenAvailable,
	mountToolsWhenAvailable,
	type StoreState,
} from "./assemble.js";
import {
	REVIEW_DEFAULT_BATCH_SIZE,
	REVIEW_DEFAULT_DAILY_BUDGET,
	REVIEW_DEFAULT_DRY_RUN,
	REVIEW_DEFAULT_STALE_DAYS,
} from "./services/review.js";
import {
	createFrozenMemorySection,
	DEFAULT_MAX_CHARS,
	DEFAULT_MEMORY_SECTION_ORDER,
	MEMORY_SECTION_NAME,
	memorySectionText,
} from "./surfaces/memory-section.js";
import { cwdOf } from "./services/agent.js";
import { importWorkspaceMd } from "./services/import-md.js";
import { openMemoryStore } from "./store.js";
import { createPluginLog } from "./services/plugin-log.js";
import { pruneIfDue } from "./services/retention.js";

export const name = "continual-evolve";

export const inject = ["systemPrompt"];

/** The minimal host surface this plugin touches. */
interface SectionContext {
	agent?: unknown;
}

/**
 * The nested `inject` shape (cordis Context), declared locally like every
 * other host surface. Used for the optional card and tool wiring: a host
 * that never provides `webServer` or `tools` never runs those callbacks, and
 * the plugin degrades instead of blocking on a missing service.
 */
export interface NestedInjectHost {
	inject(services: string[], callback: (scoped: unknown) => void): void;
}

export interface HostContext {
	systemPrompt: {
		section(section: {
			name: string;
			order: number;
			text: string | ((context: SectionContext) => string);
		}): void;
	};
}

export const Config = z.object({
	/**
	 * The memory section: injects the workspace memory index (a store query)
	 * at session start, frozen per session to keep the system prompt
	 * byte-stable (prompt cache). `enabled`/`guide`/`order`/`maxChars`
	 * default to true/true/400/6000; with `guide` off and an empty store the
	 * section renders to "" and costs no tokens.
	 */
	memoryIndex: z.object({
		enabled: z.boolean(),
		guide: z.boolean(),
		order: z.natural(),
		maxChars: z.natural(),
		/**
		 * The proposal-based extraction run (trigger: turn-level, per-session
		 * slots, no idle timer; writes land only through the store's gates).
		 * Off keeps the plugin injection + explicit tools only.
		 */
		extraction: z.boolean(),
	}),
	/**
	 * The autonomous content-quality loop (own prompts, own daily budget,
	 * own ledger — shares only the store's write gates with extraction).
	 * Every field is volatile: a settings surface edits them without a
	 * remount, so the scheduler re-reads them per drain instead of capturing
	 * them at mount. `dryRun` ledgers verdicts without landing them (trial
	 * mode, default on); `dailyBudget` caps reviewed items per UTC day
	 * (default 100); `staleDays` is how long a reviewed item stays out of the
	 * queue before it comes back (default 30).
	 */
	review: z.object({
		enabled: z.boolean().volatile(),
		dryRun: z.boolean().volatile(),
		dailyBudget: z.natural().volatile(),
		batchSize: z.natural().volatile(),
		staleDays: z.natural().volatile(),
	}),
	/**
	 * The read-only memory card in the official plugin manager
	 * (`plugins.bundle.config`). Defaults to on; hosts without the
	 * `webServer` service or the `plugins.bundle.config` slot degrade to no
	 * card, with the memory section unaffected.
	 */
	memoryCard: z.object({
		enabled: z.boolean(),
	}),
});

/**
 * Structurally typed resolved config (loader passes the validated object).
 * Derived from the schemastery schema — single source of truth, no manual sync.
 */
export type EvolveConfig = Partial<Schemastery.TypeT<typeof Config>>;

/** Build the card's settings reader: the volatile unpacking is the assembly root's job (ADR 2026-10-13). */
function readReviewSettingsOf(config: EvolveConfig): () => ReviewSettingsSnapshot {
	return () => ({
		enabled: config.review?.enabled?.get() ?? true,
		dryRun: config.review?.dryRun?.get() ?? REVIEW_DEFAULT_DRY_RUN,
		dailyBudget: config.review?.dailyBudget?.get() ?? REVIEW_DEFAULT_DAILY_BUDGET,
		batchSize: config.review?.batchSize?.get() ?? REVIEW_DEFAULT_BATCH_SIZE,
		staleDays: config.review?.staleDays?.get() ?? REVIEW_DEFAULT_STALE_DAYS,
	});
}

export function apply(host: HostContext, config: EvolveConfig): void {
	if (config.memoryIndex?.enabled === false) {
		return;
	}
	const state: StoreState = { store: undefined, toolsAvailable: false };
	// One log face for the whole plugin, writing to the store once it is open.
	// Created before the store exists: the early mounts and the failure path
	// below call it, and lines written before readiness are dropped.
	const log = createPluginLog(() => state.store);
	void openMemoryStore().then(
		(store) => {
			state.store = store;
			// Retention has no scheduler: the day-throttled check rides mount and
			// every log write, so the ledgers stay bounded in a long-lived process.
			try {
				pruneIfDue(store);
			} catch (error) {
				log.warn("prune-failed", `ledger retention skipped: ${error instanceof Error ? error.message : String(error)}`);
			}
			mountToolsWhenAvailable(host, store, state, log);
			mountCreatorSkillsWhenAvailable(host, log);
			mountExtractionWhenAvailable(host, store, config, log);
			// One live reader built by the root, shared by the loop and the card:
			// volatile config is unpacked here, never in the mounts.
			const readReviewSettings = readReviewSettingsOf(config);
			mountReviewWhenAvailable(host, store, { enabled: readReviewSettings().enabled, read: readReviewSettings }, log);
			mountSettingsPresentation(host, log);
			if (config.memoryCard?.enabled !== false) {
				mountCardWhenAvailable(host, store, readReviewSettings, log);
			}
			log.info("section-registered", "continual-evolve memory section registered (central SQLite store, sole-writer gates)");
		},
		(_error: unknown) => {
			// node:sqlite missing (old runtime) or the database unusable: degrade
			// to a no-op plugin, never take the host down. Nothing is logged: the
			// store is this plugin's only log home, and it is the thing that just
			// failed — the host's logger has no sink to fall back on.
		},
	);
	const frozen = createFrozenMemorySection();
	host.systemPrompt.section({
		name: MEMORY_SECTION_NAME,
		order: config.memoryIndex?.order ?? DEFAULT_MEMORY_SECTION_ORDER,
		text: (context) => {
			const store = state.store;
			if (store === undefined) {
				// Still loading or unavailable: render nothing (and freeze
				// nothing — the first assembly after readiness builds for real).
				return "";
			}
			const cwd = cwdOf(context.agent);
			if (cwd !== undefined) {
				// First contact with this workspace migrates any legacy MD-era
				// store into the database; flag-guarded, so it is a no-op after.
				try {
					importWorkspaceMd(store, cwd);
				} catch (error) {
					log.warn(
						"md-import-failed",
						`legacy memory import failed for ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
						{ workspaceId: cwd },
					);
				}
			}
			return frozen.textFor(context.agent, (agent) =>
				memorySectionText(agent, {
					store,
					maxChars: config.memoryIndex?.maxChars ?? DEFAULT_MAX_CHARS,
					guide: config.memoryIndex?.guide ?? true,
					toolsAvailable: state.toolsAvailable,
				}),
			);
		},
	});
}
