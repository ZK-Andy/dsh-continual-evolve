/**
 * The plugin's log face: one call writes one durable row.
 *
 * The host's logger is not a channel this plugin uses. A stock host attaches no
 * exporter to it (docs/FAQ.md #4), so it can never be the home of a fact worth
 * re-reading — and the sink belongs to the user's environment, which the plugin
 * does not control. The store is the only home, which also means a diagnostic
 * written while the store is unavailable is dropped: this face never throws,
 * because a log line that can take a session down costs more than a lost line.
 */
import { pruneIfDue } from "./retention.js";
import type { MemoryStore } from "./store.js";

/** The partition a line belongs to, when the call site knows one. */
export interface LogWhere {
	workspaceId?: string | undefined;
	sessionId?: string | undefined;
}

/** The log face feature code holds: durable in the store, nothing else. */
export interface PluginLog {
	info(event: string, message: string, where?: LogWhere): void;
	warn(event: string, message: string, where?: LogWhere): void;
	error(event: string, message: string, where?: LogWhere): void;
}

/**
 * Bind a log face to one store accessor.
 *
 * @param storeOf - Reads the store each call: the sink outlives store startup,
 *   and a host whose store never opened has nowhere to write.
 * @returns The log face feature code calls.
 */
export function createPluginLog(storeOf: () => MemoryStore | undefined): PluginLog {
	const write = (level: "info" | "warn" | "error", event: string, message: string, where?: LogWhere): void => {
		const store = storeOf();
		if (store === undefined) {
			return;
		}
		try {
			store.logPlugin({ level, event, message, ...where });
			// Retention rides the writes: the log is the one table written
			// without a scheduler of its own, so it prunes itself.
			pruneIfDue(store);
		} catch {
			// Swallowed by design: the durable write and its prune are
			// best-effort, and there is no second channel to fall back to.
		}
	};
	return {
		info: (event, message, where) => write("info", event, message, where),
		warn: (event, message, where) => write("warn", event, message, where),
		error: (event, message, where) => write("error", event, message, where),
	};
}
