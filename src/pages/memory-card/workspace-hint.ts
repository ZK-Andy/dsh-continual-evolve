/**
 * The card's "current workspace" hint — which partition the card selects when
 * it opens.
 *
 * The card is one page in the host's plugin manager: it has no session of its
 * own, so "current" means "most recently active", and the host's workspace
 * registry (`ctx.workspaceRegistry`) is the freshest record of that — attaching
 * a session is a durable mutation, so the record with the newest `updatedAt` is
 * the workspace the user just worked in. The registry is consumed **only** as
 * this hint: the card's read fence and the listed set both stay projections of
 * the store (ADR `2026-10-06-sqlite-single-store`), and an absent or unusable
 * registry degrades to the store's own activity ordering.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** The slice of `ctx.workspaceRegistry` this hint consumes. */
export interface WorkspaceRegistryLike {
	list(): unknown;
}

/**
 * Canonical comparison spelling for one path: `fs.realpath` when the directory
 * survives, the resolved spelling otherwise. The registry stores realpath while
 * a partition id is the session's cwd, so the two can differ by a symlink.
 */
export function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * The path of the registry record with the newest `updatedAt`, or undefined
 * when the service is absent, malformed, or holds no usable record. Never
 * throws: a host service is untrusted input and a hint may not break a route.
 */
export function newestRegistryPath(registry: unknown): string | undefined {
	if (registry === null || registry === undefined) {
		return undefined;
	}
	const list = (registry as Partial<WorkspaceRegistryLike>).list;
	if (typeof list !== "function") {
		return undefined;
	}
	let rows: unknown;
	try {
		rows = list.call(registry);
	} catch {
		return undefined;
	}
	if (!Array.isArray(rows)) {
		return undefined;
	}
	let best: { path: string; updatedAt: string } | undefined;
	for (const row of rows) {
		const path = (row as { path?: unknown } | undefined)?.path;
		const updatedAt = (row as { updatedAt?: unknown } | undefined)?.updatedAt;
		if (typeof path !== "string" || path.trim().length === 0 || typeof updatedAt !== "string") {
			continue;
		}
		if (best === undefined || updatedAt > best.updatedAt) {
			best = { path: path.trim(), updatedAt };
		}
	}
	return best?.path;
}
