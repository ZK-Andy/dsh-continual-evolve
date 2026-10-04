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
 * The host API surface is declared locally (the minimal shape this plugin
 * touches) instead of importing the DSH type packages — the section call is
 * the same one every prior release used, verified in production.
 */
import z from "@deepseek-ai/schemastery";
import {
	createFrozenMemorySection,
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
});

/**
 * Structurally typed resolved config (loader passes the validated object).
 * Derived from the schemastery schema — single source of truth, no manual sync.
 */
export type EvolveConfig = Partial<Schemastery.TypeT<typeof Config>>;

export function apply(host: HostContext, config: EvolveConfig): void {
	if (config.memoryIndex?.enabled === false) {
		return;
	}
	const frozen = createFrozenMemorySection();
	host.systemPrompt.section({
		name: MEMORY_SECTION_NAME,
		order: config.memoryIndex?.order ?? DEFAULT_MEMORY_SECTION_ORDER,
		text: (context) =>
			frozen.textFor(context.agent, (agent) =>
				memorySectionText(agent, {
					maxChars: config.memoryIndex?.maxChars ?? DEFAULT_MAX_CHARS,
					guide: config.memoryIndex?.guide ?? true,
				}),
			),
	});
	host.logger("continual-evolve").info(
		"continual-evolve memory section registered (workspace .evolve/memory, native file read/write)",
	);
}
