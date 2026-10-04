/**
 * The read-only HTTP surface the plugin management card fetches from.
 *
 * Mounted through the host's `webServer` service (same registration shape
 * dshmarket uses: `kind: "exact"` routes on the profile's web server), the
 * two endpoints are GET-only projections: the workspace allowlist and, for a
 * known root, the memory snapshot. The allowlist IS the security fence — the
 * memory endpoint resolves its `root` parameter only against roots the
 * running process has actually served, so the API cannot read arbitrary
 * paths. Handlers are synchronous and never throw past the response.
 */
import { resolve } from "node:path";
import type { KnownWorkspaces } from "./known-workspaces.js";
import { memorySnapshot } from "./memory-snapshot.js";

/** URL prefix of the card API (kind-exact routes registered under it). */
export const CARD_API_WORKSPACES_PATH = "/dsh-continual-evolve/api/v1/workspaces";
export const CARD_API_MEMORY_PATH = "/dsh-continual-evolve/api/v1/memory";

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

/**
 * Register the two card routes and return a disposer that removes them.
 * Registration return values are passed through untouched: whatever disposer
 * shape the host hands back (or none, as on some host versions), the
 * disposer calls only the functions among them.
 */
export function mountCardRoutes(webServer: CardWebServer, workspaces: KnownWorkspaces): () => void {
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
				sendJson(response, 200, { workspaces: workspaces.list() });
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
				const known = workspaces.list().find((workspace) => workspace.root === resolve(root));
				if (known === undefined) {
					// The allowlist answers 404 without distinguishing "never
					// served" from "wrong path": no filesystem oracle here.
					sendJson(response, 404, { error: "unknown workspace root" });
					return;
				}
				sendJson(response, 200, memorySnapshot(known.root));
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
