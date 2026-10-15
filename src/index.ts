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
 * - the model tools (`evolve-tools.ts`): `evolve_write` for every
 *   explicit "记住/忘掉/沉淀" instruction (`kind` selects memory vs skill
 *   vs prompt) and `evolve_read` for bodies and search;
 * - the extraction scheduler (`extraction.ts`): turn-level, per-session
 *   slots, single-flight per session; proposals land only through the
 *   store's gates;
 * - the read-only card routes (`card-routes.ts`) in the official plugin
 *   manager.
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
import { mountCardRoutes, type CardWebServer } from "./surfaces/card-routes.js";
import { createExtractionScheduler, type LlmRuntime, type SchedulerHost } from "./extraction.js";
import { resolveCallRoute, type RouteResolver } from "./llm-call.js";
import {
	createReviewScheduler,
	REVIEW_DEFAULT_BATCH_SIZE,
	REVIEW_DEFAULT_DAILY_BUDGET,
	REVIEW_DEFAULT_DRY_RUN,
	REVIEW_DEFAULT_STALE_DAYS,
	type ReviewSchedulerHost,
} from "./review.js";
import type { SurfaceReader } from "./extraction-surface.js";import {
	createFrozenMemorySection,
	cwdOf,
	DEFAULT_MAX_CHARS,
	DEFAULT_MEMORY_SECTION_ORDER,
	MEMORY_SECTION_NAME,
	memorySectionText,
} from "./surfaces/memory-section.js";
import { registerEvolveTools } from "./surfaces/evolve-tools.js";
import { importWorkspaceMd } from "./import-md.js";
import { openMemoryStore, type MemoryStore } from "./store.js";
import { createPluginLog, type PluginLog } from "./plugin-log.js";
import { pruneIfDue } from "./retention.js";
import { newestRegistryPath } from "./workspace-hint.js";

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
interface NestedInjectHost {
	inject(services: string[], callback: (scoped: unknown) => void): void;
}

interface HostContext {
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

/** Mutable plugin state the async store open fills in. */
interface StoreState {
	store: MemoryStore | undefined;
	toolsAvailable: boolean;
}

/**
 * Build the route resolver a scheduler uses for its direct calls: the agent's
 * explicit selection first, the host's default-model service second.
 *
 * The default-model service is read through `ctx.get` on every call and never
 * joins an inject list — a host without it (or an older one) must keep working,
 * and its absence only means a session with no explicit selection has no route.
 */
function routeResolverOf(scoped: unknown, get: ((name: string) => unknown) | undefined): RouteResolver | undefined {
	if (typeof get !== "function") {
		return undefined;
	}
	const read = get.bind(scoped);
	return (agent: unknown) => resolveCallRoute(agent, read);
}

/**
 * Keep one scheduler's disposer on the owning fiber.
 *
 * Without this a remount (HMR, a live config edit) leaves the previous
 * listeners attached: two schedulers then drain the same boundary, and the
 * older one holds an LLM service the remount already replaced.
 */
function registerSchedulerDisposer(scoped: unknown, dispose: () => void): void {
	const effect = (scoped as { effect?: unknown }).effect;
	if (typeof effect === "function") {
		(effect as (callback: () => () => void) => unknown).call(scoped, () => dispose);
	}
}

/** Register the unified tools through a nested inject (see evolve-tools.ts). */
function mountToolsWhenAvailable(host: HostContext, store: MemoryStore, state: StoreState, log: PluginLog): void {
	const nested = host as HostContext & Partial<NestedInjectHost>;
	if (typeof nested.inject !== "function") {
		log.warn(
			"tools-not-mounted",
			"host context exposes no inject — memory tools not registered (injection unaffected; explicit memory management falls back to telling the user)",
		);
		return;
	}
	nested.inject(["tools"], (scoped: unknown) => {
		const tools = (scoped as { tools?: unknown }).tools;
		if (tools === undefined || typeof (tools as { register?: unknown }).register !== "function") {
			log.warn(
				"tools-empty",
				"tools service present but empty — memory tools not registered (injection unaffected)",
			);
			return;
		}
		registerEvolveTools(tools as Parameters<typeof registerEvolveTools>[0], store);
		state.toolsAvailable = true;
		log.info("evolve-tools-registered", "evolve_write and evolve_read registered");
	});
}

/**
 * Arm the extraction scheduler through a nested inject: the session reader
 * and LLM services are siblings, so they are resolved inside the scoped
 * context while the event listeners use the plugin's own context. A host
 * without either service (or without `.on`) simply never arms — injection
 * and the explicit tools remain functional.
 */
function mountExtractionWhenAvailable(host: HostContext, store: MemoryStore, config: EvolveConfig, log: PluginLog): void {
	if (config.memoryIndex?.extraction === false) {
		log.info("extraction-disabled", "extraction disabled by config — injection and evolve_write remain active");
		return;
	}
	const nested = host as HostContext & Partial<NestedInjectHost>;
	const events = host as HostContext & Partial<SchedulerHost>;
	const on = events.on;
	if (typeof nested.inject !== "function" || typeof on !== "function") {
		log.warn("extraction-not-armed", "host context exposes no inject/on — extraction not armed (injection and tools unaffected)");
		return;
	}
	const schedulerHost: SchedulerHost = { on: (event, handler) => on.call(events, event, handler), log };
	nested.inject(["sessionQuery", "llm"], (scoped: unknown) => {
		const context = scoped as {
			sessionQuery?: unknown;
			llm?: unknown;
			get?: (name: string) => unknown;
		};
		const surface = context.sessionQuery as SurfaceReader | undefined;
		const llm = (context.llm ?? context.get?.("llm")) as LlmRuntime | undefined;
		if (surface === undefined || typeof surface.readSurface !== "function") {
			log.warn("extraction-no-surface", "sessionQuery service present but empty — extraction not armed (injection and tools unaffected)");
			return;
		}
		const resolveRoute = routeResolverOf(scoped, context.get);
		registerSchedulerDisposer(scoped, createExtractionScheduler(schedulerHost, {
			store, surface, llm,
			...(resolveRoute === undefined ? {} : { resolveRoute }),
		}));
	});
}

/**
 * Arm the review scheduler through a nested inject: the loop needs only the
 * LLM sibling (no trajectory reader — it judges stored items, not session
 * increments), so it mounts independently from extraction. Own prompts, own
 * budget, own ledger; the store's write gates are the only shared surface.
 */
function mountReviewWhenAvailable(host: HostContext, store: MemoryStore, config: EvolveConfig, log: PluginLog): void {
	if (config.review?.enabled?.get() === false) {
		log.info("review-disabled", "review disabled by config — extraction and tools unaffected");
		return;
	}
	const nested = host as HostContext & Partial<NestedInjectHost>;
	const events = host as HostContext & Partial<ReviewSchedulerHost>;
	const on = events.on;
	if (typeof nested.inject !== "function" || typeof on !== "function") {
		log.warn("review-not-armed", "host context exposes no inject/on — review not armed (injection and tools unaffected)");
		return;
	}
	const schedulerHost: ReviewSchedulerHost = { on: (event, handler) => on.call(events, event, handler), log };
	nested.inject(["llm"], (scoped: unknown) => {
		const context = scoped as { llm?: unknown; get?: (name: string) => unknown };
		const llm = (context.llm ?? context.get?.("llm")) as LlmRuntime | undefined;
		const resolveRoute = routeResolverOf(scoped, context.get);
		registerSchedulerDisposer(scoped, createReviewScheduler(schedulerHost, {
			store, llm,
			...(resolveRoute === undefined ? {} : { resolveRoute }),
		}, {
			enabled: true,
			read: () => ({
				dryRun: config.review?.dryRun?.get() ?? REVIEW_DEFAULT_DRY_RUN,
				dailyBudget: config.review?.dailyBudget?.get() ?? REVIEW_DEFAULT_DAILY_BUDGET,
				batchSize: config.review?.batchSize?.get() ?? REVIEW_DEFAULT_BATCH_SIZE,
				staleDays: config.review?.staleDays?.get() ?? REVIEW_DEFAULT_STALE_DAYS,
			}),
			minIntervalMs: 5 * 60 * 1000,
		}));
	});
}

/**
 * Mount the card routes on the host web server through a nested inject, so
 * the plugin stays mountable on hosts without that service. Called once the
 * store is ready — the routes are projections of the store, not of files.
 *
 * The card's opening workspace comes from the host registry, read through
 * `ctx.get` on every request (the FAQ #2 sibling-service rule — the service is
 * optional, so it must not join the inject list, which would gate the mount).
 */
function mountCardWhenAvailable(host: HostContext, store: MemoryStore, log: PluginLog): void {
	const nested = host as HostContext & Partial<NestedInjectHost>;
	if (typeof nested.inject !== "function") {
		log.warn(
			"card-not-mounted",
			"host context exposes no inject — memory card routes not mounted (memory section unaffected)",
		);
		return;
	}
	nested.inject(["webServer"], (scoped: unknown) => {
		const context = scoped as { webServer?: CardWebServer; get?: (name: string) => unknown };
		const webServer = context.webServer;
		if (webServer === undefined) {
			log.warn(
				"card-empty-server",
				"webServer service present but empty — memory card routes not mounted (memory section unaffected)",
			);
			return;
		}
		mountCardRoutes(webServer, store, {
			currentWorkspace: () => newestRegistryPath(context.get?.("workspaceRegistry")),
		});
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
			mountExtractionWhenAvailable(host, store, config, log);
			mountReviewWhenAvailable(host, store, config, log);
			if (config.memoryCard?.enabled !== false) {
				mountCardWhenAvailable(host, store, log);
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
