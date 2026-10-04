import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CARD_API_MEMORY_PATH,
	CARD_API_WORKSPACES_PATH,
	mountCardRoutes,
	type CardRequest,
	type CardRoute,
	type CardWebServer,
} from "../src/card-routes.js";
import { createKnownWorkspaces } from "../src/known-workspaces.js";

let workspace = "";

beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "evolve-card-routes-"));
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
});

interface RecordedResponse {
	status: number;
	headers: Record<string, string> | undefined;
	body: string;
	ended: boolean;
}

function makeWebServer(): { routes: Map<string, CardRoute>; webServer: CardWebServer; disposers: Array<() => void> } {
	const routes = new Map<string, CardRoute>();
	const disposers: Array<() => void> = [];
	const webServer: CardWebServer = {
		register(route: CardRoute) {
			routes.set(route.path, route);
			disposers.push(() => routes.delete(route.path));
			return disposers[disposers.length - 1];
		},
	};
	return { routes, webServer, disposers };
}

async function call(
	route: CardRoute | undefined,
	request: CardRequest,
): Promise<RecordedResponse> {
	if (route === undefined) {
		throw new Error(`route not mounted: ${String(request.url)}`);
	}
	const recorded: RecordedResponse = { status: 0, headers: undefined, body: "", ended: false };
	const response = {
		writeHead(status: number, headers?: Record<string, string>) {
			recorded.status = status;
			recorded.headers = headers;
			return response;
		},
		end(body?: string) {
			recorded.ended = true;
			recorded.body = body ?? "";
		},
	};
	await route.handler(request, response);
	return recorded;
}

function jsonBody(recorded: RecordedResponse): unknown {
	return JSON.parse(recorded.body);
}

describe("mountCardRoutes", () => {
	it("registers both routes and the disposer unregisters them", () => {
		const { routes, webServer } = makeWebServer();
		const disposer = mountCardRoutes(webServer, createKnownWorkspaces());
		expect([...routes.keys()]).toEqual([CARD_API_WORKSPACES_PATH, CARD_API_MEMORY_PATH]);
		disposer();
		expect(routes.size).toBe(0);
	});

	it("the disposer tolerates hosts whose register returns nothing", () => {
		const bare: CardWebServer = { register: () => undefined };
		const disposer = mountCardRoutes(bare, createKnownWorkspaces());
		expect(() => disposer()).not.toThrow();
	});

	it("serves the workspace allowlist", async () => {
		const { routes, webServer } = makeWebServer();
		const known = createKnownWorkspaces();
		known.remember(workspace);
		mountCardRoutes(webServer, known);
		const recorded = await call(routes.get(CARD_API_WORKSPACES_PATH), { method: "GET", url: CARD_API_WORKSPACES_PATH });
		expect(recorded.status).toBe(200);
		expect(jsonBody(recorded)).toEqual({ workspaces: [{ root: workspace, lastSeen: expect.any(String) }] });
	});

	it("answers 405 for non-GET requests on both routes", async () => {
		const { routes, webServer } = makeWebServer();
		mountCardRoutes(webServer, createKnownWorkspaces());
		const workspaces = await call(routes.get(CARD_API_WORKSPACES_PATH), { method: "POST", url: CARD_API_WORKSPACES_PATH });
		expect(workspaces.status).toBe(405);
		const memory = await call(routes.get(CARD_API_MEMORY_PATH), { method: "PUT", url: CARD_API_MEMORY_PATH });
		expect(memory.status).toBe(405);
	});

	it("answers 400 when the root parameter is missing or relative", async () => {
		const { routes, webServer } = makeWebServer();
		const known = createKnownWorkspaces();
		known.remember(workspace);
		mountCardRoutes(webServer, known);
		const missing = await call(routes.get(CARD_API_MEMORY_PATH), {
			method: "GET",
			url: CARD_API_MEMORY_PATH,
		});
		expect(missing.status).toBe(400);
		const relative = await call(routes.get(CARD_API_MEMORY_PATH), {
			method: "GET",
			url: `${CARD_API_MEMORY_PATH}?root=relative/path`,
		});
		expect(relative.status).toBe(404);
	});

	it("answers 404 for a root the process never served (allowlist fence)", async () => {
		const { routes, webServer } = makeWebServer();
		mountCardRoutes(webServer, createKnownWorkspaces());
		const recorded = await call(routes.get(CARD_API_MEMORY_PATH), {
			method: "GET",
			url: `${CARD_API_MEMORY_PATH}?root=${encodeURIComponent("/etc")}`,
		});
		expect(recorded.status).toBe(404);
		expect(jsonBody(recorded)).toEqual({ error: "unknown workspace root" });
	});

	it("serves the read-only snapshot for a known root", async () => {
		const { routes, webServer } = makeWebServer();
		const known = createKnownWorkspaces();
		known.remember(workspace);
		mountCardRoutes(webServer, known);
		mkdirSync(join(workspace, ".evolve", "memory"), { recursive: true });
		writeFileSync(join(workspace, ".evolve", "memory", "MEMORY.md"), "- [x](a.md) — y\n");
		const recorded = await call(routes.get(CARD_API_MEMORY_PATH), {
			method: "GET",
			url: `${CARD_API_MEMORY_PATH}?root=${encodeURIComponent(workspace)}`,
		});
		expect(recorded.status).toBe(200);
		expect(recorded.headers).toMatchObject({ "content-type": "application/json; charset=utf-8" });
		const body = jsonBody(recorded) as { root: string; exists: boolean; indexEntryCount: number };
		expect(body.root).toBe(workspace);
		expect(body.exists).toBe(true);
		expect(body.indexEntryCount).toBe(1);
	});
});
