/**
 * Producer declaration for every message this plugin injects.
 *
 * Harness message sources are a merge-extensible sum type: each producer
 * declares its own `kind` in its own module, and dsh 0.1.7 removed the shared
 * catch-all `kind: "plugin"`. Declaring our kind once, here, keeps every
 * injection site checked against the host vocabulary instead of repeating a
 * local literal that silently drifts when that vocabulary changes.
 */

declare module "@deepseek-ai/dsh-llm" {
	interface MessageSourceMap {
		"continual-evolve": EvolveMessageSource;
	}
}

/** Source tag identifying dsh-continual-evolve as the message producer. */
export interface EvolveMessageSource {
	kind: "continual-evolve";
}

/** Source value carried by every message this plugin injects. */
export const EVOLVE_MESSAGE_SOURCE = { kind: "continual-evolve" } as const satisfies EvolveMessageSource;
