/**
 * The read-only HTTP surface the plugin management card fetches from.
 *
 * Mounted through the host's `webServer` service (same registration shape
 * dshmarket uses: `kind: "exact"` routes on the profile's web server), the
 * three endpoints are GET-only projections of the central SQLite store: the
 * workspace list (active partitions whose directory still exists) plus the
 * partition the card should open on, the memory snapshot for a known
 * workspace, and one record's body by id. The store itself is the security
 * fence — a `root` parameter only resolves when the database has rows for it,
 * so the API cannot probe the filesystem; the content endpoint takes an id,
 * never a path. Handlers are synchronous and never throw past the response.
 */
import { memoryEntryContent, listCardWorkspaces, memorySnapshot } from "./memory-snapshot.js";
import type { MemoryStore } from "./store.js";
import { canonicalPath } from "./workspace-hint.js";

/** URL prefix of the card API (kind-exact routes registered under it). */
export const CARD_API_WORKSPACES_PATH = "/dsh-continual-evolve/api/v1/workspaces";
export const CARD_API_MEMORY_PATH = "/dsh-continual-evolve/api/v1/memory";
export const CARD_API_MEMORY_FILE_PATH = "/dsh-continual-evolve/api/v1/memory/file";

/** Minimal request shape the handlers touch (Node IncomingMessage subset). */
export interface CardRequest {
	method?: string;
	url?: string;
}

/** Minimal response shape the handlers touch (Node ServerResponse subset). */
export interface CardResponse {
	writeHead(status: number, headers?: Record<string, string>): unknown;
	end(body?: string): unknown;
}

/** One `kind: "exact"` route registration on the host web server. */
export interface CardRoute {
	kind: "exact";
	path: string;
	handler(request: CardRequest, response: CardResponse): void;
}

/** Minimal webServer surface the card mounts on. */
export interface CardWebServer {
	register(route: CardRoute): unknown;
}

/**
 * Per-request hints the mount takes from the host. Both are optional: a host
 * without the service behind them simply leaves the default to the next source
 * in the chain (see {@link defaultRootOf}).
 */
export interface CardRouteOptions {
	/**
	 * The GUI's current workspace, resolved live on every request so a
	 * workspace attached while the card is open is picked up on refresh.
	 */
	currentWorkspace?: (() => string | undefined) | undefined;
}

function sendJson(response: CardResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
}

function isGet(request: CardRequest): boolean {
	return (request.method ?? "GET") === "GET";
}

/** The card's read fence: a root only resolves when the store has rows for it. */
function isKnownRoot(store: MemoryStore, root: string): boolean {
	return listCardWorkspaces(store).some((workspace) => workspace.root === root);
}

/**
 * Register the card routes and return a disposer that removes them.
 * Registration return values are passed through untouched: whatever disposer
 * shape the host hands back (or none, as on some host versions), the
 * disposer calls only the functions among them.
 */
export function mountCardRoutes(
	webServer: CardWebServer,
	store: MemoryStore,
	options: CardRouteOptions = {},
): () => void {
	const disposers: unknown[] = [];
	disposers.push(
		webServer.register({
			kind: "exact",
			path: CARD_API_WORKSPACES_PATH,
			handler(request, response) {
				if (!isGet(request)) {
					response.writeHead(405, { allow: "GET" });
					response.end();
					return;
				}
				const workspaces = listCardWorkspaces(store);
				sendJson(response, 200, { workspaces, defaultRoot: defaultRootOf(store, workspaces, options) });
			},
		}),
	);
	disposers.push(
		webServer.register({
			kind: "exact",
			path: CARD_API_MEMORY_PATH,
			handler(request, response) {
				if (!isGet(request)) {
					response.writeHead(405, { allow: "GET" });
					response.end();
					return;
				}
				const root = rootParamOf(request);
				if (root === null) {
					sendJson(response, 400, { error: "root query parameter is required and must be an absolute path" });
					return;
				}
				if (!isKnownRoot(store, root)) {
					// The store answers 404 without distinguishing "no rows" from
					// "wrong path": no filesystem oracle.
					sendJson(response, 404, { error: "unknown workspace root" });
					return;
				}
				sendJson(response, 200, memorySnapshot(store, root));
			},
		}),
	);
	disposers.push(
		webServer.register({
			kind: "exact",
			path: CARD_API_MEMORY_FILE_PATH,
			handler(request, response) {
				if (!isGet(request)) {
					response.writeHead(405, { allow: "GET" });
					response.end();
					return;
				}
				const root = rootParamOf(request);
				if (root === null) {
					sendJson(response, 400, { error: "root query parameter is required and must be an absolute path" });
					return;
				}
				const id = idParamOf(request);
				if (id === null) {
					sendJson(response, 400, { error: "id query parameter is required" });
					return;
				}
				if (!isKnownRoot(store, root)) {
					// Same fence as the snapshot route.
					sendJson(response, 404, { error: "unknown workspace root" });
					return;
				}
				const content = memoryEntryContent(store, root, id);
				if (!content.ok) {
					// Absence answers 404; the oversized case is theoretically
					// unreachable (bodies are schema-capped at 64KB) but keeps its
					// own status for the day the preview limit shrinks.
					if (content.reason === "too-large") {
						sendJson(response, 413, { error: "memory body exceeds the 5 MiB preview limit" });
					} else {
						sendJson(response, 404, { error: "memory not found" });
					}
					return;
				}
				sendJson(response, 200, {
					id: content.id,
					content: content.content,
					updatedAtMs: content.updatedAtMs,
				});
			},
		}),
	);
	return () => {
		for (const disposer of disposers) {
			if (typeof disposer === "function") {
				disposer();
			}
		}
	};
}

/** The decoded `root` query parameter, or null when absent/relative. */
function rootParamOf(request: CardRequest): string | null {
	try {
		const url = new URL(request.url ?? "/", "http://dsh-card.invalid");
		const root = url.searchParams.get("root");
		if (root === null || root.trim().length === 0) {
			return null;
		}
		return root;
	} catch (error) {
		// A malformed URL is a bad request, not a crash: null maps to 400.
		void error;
		return null;
	}
}

/** The decoded `id` query parameter, or null when absent. */
function idParamOf(request: CardRequest): string | null {
	try {
		const url = new URL(request.url ?? "/", "http://dsh-card.invalid");
		const id = url.searchParams.get("id");
		if (id === null || id.trim().length === 0) {
			return null;
		}
		return id;
	} catch (error) {
		void error;
		return null;
	}
}

/**
 * The partition the card opens on: the host's current workspace when it is one
 * the card lists, else the store's most recently active partition, else null —
 * the client then falls back to the first row. A hint that names an unlisted
 * root is ignored rather than trusted, because the listed set is a projection
 * of the store and nothing outside it is readable; spelling differences
 * (symlink vs cwd) are resolved before the comparison.
 */
function defaultRootOf(
	store: MemoryStore,
	workspaces: readonly { root: string }[],
	options: CardRouteOptions,
): string | null {
	const listed = (candidate: string | undefined): string | null => {
		if (typeof candidate !== "string" || candidate.length === 0) {
			return null;
		}
		const exact = workspaces.find((workspace) => workspace.root === candidate);
		if (exact !== undefined) {
			return exact.root;
		}
		const canonical = canonicalPath(candidate);
		return workspaces.find((workspace) => canonicalPath(workspace.root) === canonical)?.root ?? null;
	};
	const candidates: (string | undefined)[] = [];
	try {
		candidates.push(options.currentWorkspace?.());
	} catch {
		// A failing hint is simply no hint; the store still answers.
	}
	try {
		candidates.push(store.mostRecentlyActiveWorkspace());
	} catch {
		// A failing query leaves the default to the client's first row.
	}
	for (const candidate of candidates) {
		const root = listed(candidate);
		if (root !== null) {
			return root;
		}
	}
	return null;
}
