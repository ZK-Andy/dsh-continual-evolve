/**
 * The prompt-supplement card routes: a workspace snapshot plus one body by
 * id, mounted beside the memory/skill routes by `mountCardRoutes`. Same
 * fence (the store answers 404 for unknown roots — no filesystem oracle),
 * same GET-only contract, same never-throw-past-the-response discipline.
 */
import { idParamOf, isGet, rootParamOf, sendJson, type CardRequest, type CardResponse, type CardRoute, type CardWebServer } from "./card-http.js";
import { promptEntryContent, promptSnapshot } from "./prompt-snapshot.js";
import type { MemoryStore } from "../store.js";

/** URL paths of the prompt API (kind-exact routes under the card prefix). */
export const CARD_API_PROMPTS_PATH = "/dsh-continual-evolve/api/v1/prompts";
export const CARD_API_PROMPT_FILE_PATH = "/dsh-continual-evolve/api/v1/prompts/file";

/**
 * Register the two prompt routes and return a disposer that removes them.
 * @param webServer - The host web server service.
 * @param store - The open central store.
 * @param isKnownRoot - The card's read fence (shared with the other routes).
 * @returns A disposer that removes both routes.
 */
export function mountPromptRoutes(
	webServer: CardWebServer,
	store: MemoryStore,
	isKnownRoot: (store: MemoryStore, root: string) => boolean,
): () => void {
	const disposers: unknown[] = [];
	disposers.push(webServer.register(promptListRoute(store, isKnownRoot)));
	disposers.push(webServer.register(promptFileRoute(store, isKnownRoot)));
	return () => {
		for (const disposer of disposers) {
			if (typeof disposer === "function") {
				disposer();
			}
		}
	};
}

/** The workspace snapshot route (GET-only, fenced to known roots). */
function promptListRoute(
	store: MemoryStore,
	isKnownRoot: (store: MemoryStore, root: string) => boolean,
): CardRoute {
	return {
		kind: "exact",
		path: CARD_API_PROMPTS_PATH,
		handler(request: CardRequest, response: CardResponse) {
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
				sendJson(response, 404, { error: "unknown workspace root" });
				return;
			}
			sendJson(response, 200, promptSnapshot(store, root));
		},
	};
}

/** The single-prompt body route (GET-only, same fence, display-only previews). */
function promptFileRoute(
	store: MemoryStore,
	isKnownRoot: (store: MemoryStore, root: string) => boolean,
): CardRoute {
	return {
		kind: "exact",
		path: CARD_API_PROMPT_FILE_PATH,
		handler(request: CardRequest, response: CardResponse) {
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
			const content = promptEntryContent(store, root, id);
			if (!content.ok) {
				if (content.reason === "too-large") {
					sendJson(response, 413, { error: "prompt body exceeds the 5 MiB preview limit" });
				} else {
					sendJson(response, 404, { error: "prompt not found" });
				}
				return;
			}
			// Human previews are display-only, same as skills: previews
			// leave no count; only model-side reads feed the heartbeat.
			sendJson(response, 200, {
				id: content.id,
				content: content.content,
				updatedAtMs: content.updatedAtMs,
			});
		},
	};
}
