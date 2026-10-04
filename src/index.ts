/**
 * dsh-continual-evolve — plugin entry.
 *
 * After the 2026-10-04 ZCode-alignment teardown the plugin is one thing: a
 * session-start system-prompt section that injects the workspace memory
 * index (`<cwd>/.evolve/memory/MEMORY.md`), hands out the store path, and
 * teaches the when-to-save guide. The model reads and writes the markdown
 * files with its native tools; there are no plugin tools, no commands, no
 * background extraction, and no governance. See
 * .agents/notes/implemented/architecture/2026-10-04-zcode-alignment-teardown.md.
 *
 * The 2026-10-04 plugin-management card adds a read-only surface: the
 * workspace roots the section has served feed an in-memory allowlist, and a
 * `webServer` route pair projects any known workspace's store for the card
 * in the official plugin manager (`plugins.bundle.config`, client bundle in
 * client/client.js). The card is a viewer — see
 * .agents/notes/implemented/feature/2026-10-04-plugin-management-card.md.
 *
 * The host API surface is declared locally (the minimal shape this plugin
 * touches) instead of importing the DSH type packages — the section call is
 * the same one every prior release used, verified in production.
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

export const name = "continual-evolve";

export const inject = ["systemPrompt"];

/** The minimal host surface this plugin touches. */
interface SectionContext {
	agent?: unknown;
}

/**
 * The nested `inject` shape (cordis Context), declared locally like every
 * other host surface. Used only for the optional card wiring: a host that
 * never provides `webServer` never runs the callback, and the card routes
 * simply do not exist there.
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
	 * The memory section: injects the workspace memory index at session
	 * start, frozen per session to keep the system prompt byte-stable
	 * (prompt cache). `enabled`/`guide`/`order`/`maxChars` default to
	 * true/true/400/6000; with `guide` off and an empty store the section
	 * renders to "" and costs no tokens.
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

/**
 * Mount the card routes on the host web server through a nested inject, so
 * the plugin stays mountable on hosts without that service. Called only when
 * the card is enabled.
 */
function mountCardWhenAvailable(host: HostContext, workspaces: ReturnType<typeof createKnownWorkspaces>): void {
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
		mountCardRoutes(webServer, workspaces);
	});
}

export function apply(host: HostContext, config: EvolveConfig): void {
	if (config.memoryIndex?.enabled === false) {
		return;
	}
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
			return frozen.textFor(context.agent, (agent) =>
				memorySectionText(agent, {
					maxChars: config.memoryIndex?.maxChars ?? DEFAULT_MAX_CHARS,
					guide: config.memoryIndex?.guide ?? true,
				}),
			);
		},
	});
	host.logger("continual-evolve").info(
		"continual-evolve memory section registered (workspace .evolve/memory, native file read/write)",
	);
	if (config.memoryCard?.enabled === false) {
		return;
	}
	mountCardWhenAvailable(host, workspaces);
}
