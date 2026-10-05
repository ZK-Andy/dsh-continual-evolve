/**
 * The read-only HTTP surface the plugin management card fetches from.
 *
 * Mounted through the host's `webServer` service (same registration shape
 * dshmarket uses: `kind: "exact"` routes on the profile's web server), the
 * three endpoints are GET-only projections of the central SQLite store: the
 * workspace list (active partitions whose directory still exists), the
 * memory snapshot for a known workspace, and one record's body by id. The
 * store itself is the security fence — a `root` parameter only resolves
 * when the database has rows for it, so the API cannot probe the
 * filesystem; the content endpoint takes an id, never a path. Handlers are
 * synchronous and never throw past the response.
 */
import { memoryEntryContent, listCardWorkspaces, memorySnapshot } from "./memory-snapshot.js";
import type { MemoryStore } from "./store.js";

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
export function mountCardRoutes(webServer: CardWebServer, store: MemoryStore): () => void {
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
				sendJson(response, 200, { workspaces: listCardWorkspaces(store) });
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
