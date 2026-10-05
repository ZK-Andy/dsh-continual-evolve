/**
 * dsh-continual-evolve — plugin entry.
 *
 * The v0.15 SQLite single-store redesign (ADR
 * `2026-10-06-sqlite-single-store`): every memory lives in one central
 * database (`~/.dsh/evolve/memory.db`, rows partitioned by workspace path)
 * and the plugin's code is the literal sole writer. This entry wires three
 * surfaces over the store:
 *
 * - the session-start section (`memory-section.ts`): a store query rendered
 *   as the injected index, frozen per session for the prompt cache;
 * - the model tools (`memory-tools.ts`): `memory_write` for explicit
 *   "记住/忘掉" instructions, `memory_read` for bodies and search;
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
import { createKnownWorkspaces } from "./known-workspaces.js";
import {
	createFrozenMemorySection,
	cwdOf,
	DEFAULT_MAX_CHARS,
	DEFAULT_MEMORY_SECTION_ORDER,
	MEMORY_SECTION_NAME,
	memorySectionText,
} from "./memory-section.js";
import { registerMemoryTools } from "./memory-tools.js";
import { openMemoryStore, type MemoryStore } from "./store.js";
import { createWorkspaceCatalog, type WorkspaceRegistryLike } from "./workspace-catalog.js";

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
 * Register the memory tools through a nested inject, so a host without the
 * tools service degrades to the guide's "tell the user" phrasing instead of
 * blocking plugin activation (the workflowEngine pitfall, docs/FAQ.md #1).
 */
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
 * Mount the card routes on the host web server through a nested inject, so
 * the plugin stays mountable on hosts without that service. Called only when
 * the card is enabled. The workspace registry is looked up inside the scoped
 * context (nothing else injects it: a host without the service must still get
 * the card) and read per request, so a workspace created while the card is
 * open appears on the next refresh.
 */
function mountCardWhenAvailable(host: HostContext, served: ReturnType<typeof createKnownWorkspaces>): void {
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
		const catalog = createWorkspaceCatalog({
			registry: registryLookup(scoped),
			served: served,
			homeDir: process.env.DSH_HOME,
		});
		mountCardRoutes(webServer, catalog);
	});
}

/**
 * A live `ctx.workspaceRegistry` getter over the scoped context. The service
 * is a sibling, so it is reached with `ctx.get` (property access only walks
 * fiber ancestors) and treated as optional: an absent, foreign or throwing
 * service degrades the catalogue to its fallback sources instead of taking the
 * card down.
 */
function registryLookup(scoped: unknown): () => WorkspaceRegistryLike | undefined {
	const context = scoped as { get?: (name: string) => unknown };
	return () => {
		if (typeof context.get !== "function") {
			return undefined;
		}
		try {
			const service = context.get("workspaceRegistry");
			return service === undefined || service === null ? undefined : (service as WorkspaceRegistryLike);
		} catch {
			return undefined;
		}
	};
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
		},
		(error: unknown) => {
			// node:sqlite missing (old runtime) or the database unusable:
			// degrade to a no-op plugin, never take the host down.
			log.warn(
				`memory store unavailable — injection and tools disabled: ${error instanceof Error ? error.message : String(error)}`,
			);
		},
	);
	const workspaces = createKnownWorkspaces();
	const frozen = createFrozenMemorySection();
	host.systemPrompt.section({
		name: MEMORY_SECTION_NAME,
		order: config.memoryIndex?.order ?? DEFAULT_MEMORY_SECTION_ORDER,
		text: (context) => {
			const cwd = cwdOf(context.agent);
			if (cwd !== undefined) {
				workspaces.remember(cwd);
			}
			const store = state.store;
			if (store === undefined) {
				// Still loading or unavailable: render nothing (and freeze
				// nothing — the first assembly after readiness builds for real).
				return "";
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
	if (config.memoryCard?.enabled === false) {
		return;
	}
	mountCardWhenAvailable(host, workspaces);
}
