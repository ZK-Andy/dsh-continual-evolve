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
 * - the model tools (`memory-tools.ts`): `memory_write` for explicit
 *   "记住/忘掉" instructions, `memory_read` for bodies and search;
 * - the extraction scheduler (`extraction.ts`): turn-level, debounced,
 *   single-flight; proposals land only through the store's gates;
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
import { mountCardRoutes, type CardWebServer } from "./card-routes.js";
import { createExtractionScheduler, type LlmStream, type SchedulerHost } from "./extraction.js";
import type { SurfaceReader } from "./extraction-surface.js";
import {
	createFrozenMemorySection,
	cwdOf,
	DEFAULT_MAX_CHARS,
	DEFAULT_MEMORY_SECTION_ORDER,
	MEMORY_SECTION_NAME,
	memorySectionText,
} from "./memory-section.js";
import { registerMemoryTools } from "./memory-tools.js";
import { importWorkspaceMd } from "./import-md.js";
import { openMemoryStore, type MemoryStore } from "./store.js";

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
	logger(name: string): { info(message: string): void; warn(message: string): void };
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
		 * The proposal-based extraction run (trigger: turn-level with idle
		 * debounce; writes land only through the store's gates). Off keeps
		 * the plugin injection + explicit tools only.
		 */
		extraction: z.boolean(),
		/** Idle debounce minutes between turn end and an extraction run (0 = per turn). */
		debounceMin: z.natural(),
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

/** Register the memory tools through a nested inject (see memory-tools.ts). */
function mountToolsWhenAvailable(host: HostContext, store: MemoryStore, state: StoreState): void {
	const nested = host as HostContext & Partial<NestedInjectHost>;
	if (typeof nested.inject !== "function") {
		host.logger("continual-evolve").warn(
			"host context exposes no inject — memory tools not registered (injection unaffected; explicit memory management falls back to telling the user)",
		);
		return;
	}
	nested.inject(["tools"], (scoped: unknown) => {
		const tools = (scoped as { tools?: unknown }).tools;
		if (tools === undefined || typeof (tools as { register?: unknown }).register !== "function") {
			host.logger("continual-evolve").warn(
				"tools service present but empty — memory tools not registered (injection unaffected)",
			);
			return;
		}
		registerMemoryTools(tools as Parameters<typeof registerMemoryTools>[0], store);
		state.toolsAvailable = true;
		host.logger("continual-evolve").info("memory_write and memory_read registered");
	});
}

/**
 * Arm the extraction scheduler through a nested inject: the session reader
 * and LLM services are siblings, so they are resolved inside the scoped
 * context while the event listeners use the plugin's own context. A host
 * without either service (or without `.on`) simply never arms — injection
 * and the explicit tools remain functional.
 */
function mountExtractionWhenAvailable(host: HostContext, store: MemoryStore, config: EvolveConfig): void {
	const log = host.logger("continual-evolve");
	if (config.memoryIndex?.extraction === false) {
		log.info("extraction disabled by config — injection and memory_write remain active");
		return;
	}
	const nested = host as HostContext & Partial<NestedInjectHost>;
	const events = host as HostContext & Partial<SchedulerHost>;
	if (typeof nested.inject !== "function" || typeof events.on !== "function") {
		log.warn("host context exposes no inject/on — extraction not armed (injection and tools unaffected)");
		return;
	}
	nested.inject(["sessionQuery", "llm"], (scoped: unknown) => {
		const context = scoped as {
			sessionQuery?: unknown;
			llm?: unknown;
			get?: (name: string) => unknown;
		};
		const surface = context.sessionQuery as SurfaceReader | undefined;
		const llm = (context.llm ?? context.get?.("llm")) as LlmStream | undefined;
		if (surface === undefined || typeof surface.readSurface !== "function") {
			log.warn("sessionQuery service present but empty — extraction not armed (injection and tools unaffected)");
			return;
		}
		createExtractionScheduler(
			events as SchedulerHost,
			{ store, surface, llm },
			{ debounceMin: config.memoryIndex?.debounceMin ?? 10 },
		);
	});
}

/**
 * Mount the card routes on the host web server through a nested inject, so
 * the plugin stays mountable on hosts without that service. Called once the
 * store is ready — the routes are projections of the store, not of files.
 */
function mountCardWhenAvailable(host: HostContext, store: MemoryStore): void {
	const nested = host as HostContext & Partial<NestedInjectHost>;
	if (typeof nested.inject !== "function") {
		host.logger("continual-evolve").warn(
			"host context exposes no inject — memory card routes not mounted (memory section unaffected)",
		);
		return;
	}
	nested.inject(["webServer"], (scoped: unknown) => {
		const webServer = (scoped as { webServer?: CardWebServer }).webServer;
		if (webServer === undefined) {
			host.logger("continual-evolve").warn(
				"webServer service present but empty — memory card routes not mounted (memory section unaffected)",
			);
			return;
		}
		mountCardRoutes(webServer, store);
	});
}

export function apply(host: HostContext, config: EvolveConfig): void {
	if (config.memoryIndex?.enabled === false) {
		return;
	}
	const log = host.logger("continual-evolve");
	const state: StoreState = { store: undefined, toolsAvailable: false };
	void openMemoryStore().then(
		(store) => {
			state.store = store;
			mountToolsWhenAvailable(host, store, state);
			mountExtractionWhenAvailable(host, store, config);
			if (config.memoryCard?.enabled !== false) {
				mountCardWhenAvailable(host, store);
			}
		},
		(error: unknown) => {
			// node:sqlite missing (old runtime) or the database unusable:
			// degrade to a no-op plugin, never take the host down.
			log.warn(
				`memory store unavailable — injection and tools disabled: ${error instanceof Error ? error.message : String(error)}`,
			);
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
						`legacy memory import failed for ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
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
	log.info("continual-evolve memory section registered (central SQLite store, sole-writer gates)");
}
