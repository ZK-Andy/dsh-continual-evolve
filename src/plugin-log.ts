/**
 * The plugin's log face: one call writes the durable row, then mirrors the
 * line to the host's logger.
 *
 * The host logger is the live channel and a stock host attaches no exporter to
 * it (docs/FAQ.md #4), so it can never be the only home of a fact worth
 * re-reading — the store is written first. Logging never throws: a diagnostic
 * write that can take a session down is worse than a lost line, and the caller
 * has no recovery for either.
 */
import { pruneIfDue } from "./retention.js";
import type { MemoryStore } from "./store.js";

/** The live channel the host exposes (duck-typed; the host may add levels we never call). */
export interface LiveLogger {
	info(message: string): void;
	warn(message: string): void;
}

/** The partition a line belongs to, when the call site knows one. */
export interface LogWhere {
	workspaceId?: string | undefined;
	sessionId?: string | undefined;
}

/** The log face feature code holds: durable in the store, mirrored live. */
export interface PluginLog {
	info(event: string, message: string, where?: LogWhere): void;
	warn(event: string, message: string, where?: LogWhere): void;
	error(event: string, message: string, where?: LogWhere): void;
}

/**
 * Bind a log face to one store accessor and one live channel.
 *
 * @param storeOf - Reads the store each call: the sink outlives store startup,
 *   and a host whose store never opened gets the mirror only.
 * @param live - The host's logger; every line is mirrored there as
 *   `event: message` (the live channel has no structured field to put the slug
 *   in). `error` mirrors at `warn` — the host face here carries two levels.
 * @returns The log face feature code calls.
 */
export function createPluginLog(storeOf: () => MemoryStore | undefined, live: LiveLogger): PluginLog {
	const write = (level: "info" | "warn" | "error", event: string, message: string, where?: LogWhere): void => {
		const store = storeOf();
		if (store !== undefined) {
			try {
				store.logPlugin({ level, event, message, ...where });
				// Retention rides the writes: the log is the one table written
				// without a scheduler of its own, so it prunes itself.
				pruneIfDue(store);
			} catch {
				// Swallowed by design: the durable write and its prune are
				// best-effort, and the mirror below still reports the line.
			}
		}
		const line = `${event}: ${message}`;
		if (level === "error") {
			live.warn(line);
		} else {
			live[level](line);
		}
	};
	return {
		info: (event, message, where) => write("info", event, message, where),
		warn: (event, message, where) => write("warn", event, message, where),
		error: (event, message, where) => write("error", event, message, where),
	};
}
