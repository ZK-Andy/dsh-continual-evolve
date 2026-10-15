/**
 * Shared HTTP plumbing for the card routes: the host surface shapes plus
 * JSON replies, the GET-only guard, and the `root`/`id` query decoders. One
 * copy — `card-routes.js` and `prompt-routes.js` both import from here (and
 * `card-routes.js` re-exports the shapes, so existing importers keep
 * working). Handlers never throw past the response: malformed input maps
 * to 400, never to a crash.
 */

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
 * Reply with a JSON body.
 * @param response - The host response surface.
 * @param status - The HTTP status.
 * @param body - The JSON-encodable payload.
 */
export function sendJson(response: CardResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
}

/**
 * Whether the request is a GET (the card API is GET-only).
 * @param request - The host request surface.
 * @returns True for GET (or an absent method, the host default).
 */
export function isGet(request: CardRequest): boolean {
	return (request.method ?? "GET") === "GET";
}

/**
 * The decoded `root` query parameter, or null when absent/relative.
 * @param request - The host request surface.
 * @returns The root, or null for a bad request.
 */
export function rootParamOf(request: CardRequest): string | null {
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

/**
 * The decoded `id` query parameter, or null when absent.
 * @param request - The host request surface.
 * @returns The id, or null for a bad request.
 */
export function idParamOf(request: CardRequest): string | null {
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
