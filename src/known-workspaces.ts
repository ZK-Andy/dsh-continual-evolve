/**
 * The workspace roots the card may look at, in memory only.
 *
 * Populated as a side effect of section assembly (the plugin already knows
 * each session's cwd there), this list is the card's read allowlist: the
 * memory API refuses any root the running process has not served a session
 * in, so the endpoint cannot be used to probe the filesystem. Bounded LRU,
 * never persisted — a restart starts empty and one session in a workspace
 * puts it back. No second store on disk.
 */
import { isAbsolute, resolve } from "node:path";

/** One known workspace: the resolved root and when it was last served. */
export interface KnownWorkspace {
	root: string;
	/** ISO timestamp of the most recent section assembly seen for this root. */
	lastSeen: string;
}

/** The allowlist the card routes read through. */
export interface KnownWorkspaces {
	/**
	 * Record (or refresh) a workspace root. A relative or blank cwd is a
	 * silent no-op — the caller is the injection path, where a bad cwd
	 * already renders an empty section and must not turn into a throw.
	 */
	remember(cwd: string): void;
	/** Known roots, most recently served first. */
	list(): KnownWorkspace[];
}

/** How many recent workspaces the card tracks. */
export const DEFAULT_KNOWN_WORKSPACE_LIMIT = 8;

/** Create the in-memory allowlist; `limit` is the LRU bound. */
export function createKnownWorkspaces(limit: number = DEFAULT_KNOWN_WORKSPACE_LIMIT): KnownWorkspaces {
	const max = Math.max(1, limit);
	// Insertion order encodes recency: the most recently served root is last.
	const recent = new Map<string, string>();
	return {
		remember(cwd: string) {
			const trimmed = cwd.trim();
			if (trimmed.length === 0 || !isAbsolute(trimmed)) {
				return;
			}
			recent.delete(resolve(trimmed));
			recent.set(resolve(trimmed), new Date().toISOString());
			while (recent.size > max) {
				const oldest = recent.keys().next();
				if (oldest.done === true) {
					break;
				}
				recent.delete(oldest.value);
			}
		},
		list() {
			return [...recent.entries()]
				.reverse()
				.map(([root, lastSeen]) => ({ root, lastSeen }));
		},
	};
}
