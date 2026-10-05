import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CARD_API_MEMORY_FILE_PATH,
	CARD_API_MEMORY_PATH,
	CARD_API_WORKSPACES_PATH,
	mountCardRoutes,
	type CardRequest,
	type CardRoute,
	type CardWebServer,
} from "../src/card-routes.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

let store: MemoryStore;
let workspace = "";

beforeEach(async () => {
	store = await openMemoryStore(join(mkdtempSync(join(tmpdir(), "evolve-card-routes-db-")), "memory.db"));
	workspace = mkdtempSync(join(tmpdir(), "evolve-card-routes-"));
});

afterEach(() => {
	store.close();
	rmSync(workspace, { recursive: true, force: true });
});

interface RecordedResponse {
	status: number;
	headers: Record<string, string> | undefined;
	body: string;
	ended: boolean;
}

function makeWebServer(): { routes: Map<string, CardRoute>; webServer: CardWebServer } {
	const routes = new Map<string, CardRoute>();
	const webServer: CardWebServer = {
		register(route: CardRoute) {
			routes.set(route.path, route);
			return () => routes.delete(route.path);
		},
	};
	return { routes, webServer };
}

function call(route: CardRoute | undefined, request: CardRequest): RecordedResponse {
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
	route.handler(request, response);
	return recorded;
}

function jsonBody(recorded: RecordedResponse): unknown {
	return JSON.parse(recorded.body);
}

/** One active memory in the test workspace (gives the root its read fence). */
function seed(id = "fedora-env", body = "Fedora 44"): boolean {
	return store
		.applyProposals({ workspaceId: workspace, trigger: "explicit" }, [
			{ action: "create", id, type: "user", title: id, description: `${id} 的钩子`, body },
		])[0]?.ok === true;
}

describe("mountCardRoutes", () => {
	it("registers all three routes and the disposer unregisters them", () => {
		const { routes, webServer } = makeWebServer();
		const disposer = mountCardRoutes(webServer, store);
		expect([...routes.keys()].sort()).toEqual(
			[CARD_API_WORKSPACES_PATH, CARD_API_MEMORY_PATH, CARD_API_MEMORY_FILE_PATH].sort(),
		);
		disposer();
		expect(routes.size).toBe(0);
	});

	it("the disposer tolerates hosts whose register returns nothing", () => {
		const bare: CardWebServer = { register: () => undefined };
		const disposer = mountCardRoutes(bare, store);
		expect(() => disposer()).not.toThrow();
	});

	it("lists workspace partitions that have rows and an existing directory", async () => {
		const { routes, webServer } = makeWebServer();
		expect(seed()).toBe(true);
		mountCardRoutes(webServer, store);
		const recorded = call(routes.get(CARD_API_WORKSPACES_PATH), { method: "GET", url: CARD_API_WORKSPACES_PATH });
		expect(recorded.status).toBe(200);
		expect(jsonBody(recorded)).toEqual({
			workspaces: [{ root: workspace, label: workspace.split("/").pop() }],
		});
	});

	it("hides rows whose workspace directory no longer exists (失联不阻塞)", async () => {
		const vanished = mkdtempSync(join(tmpdir(), "evolve-card-vanished-"));
		store.applyProposals({ workspaceId: vanished, trigger: "explicit" }, [
			{ action: "create", type: "user", title: "t", description: "d", body: "b" },
		]);
		rmSync(vanished, { recursive: true, force: true });
		const { routes, webServer } = makeWebServer();
		mountCardRoutes(webServer, store);
		const recorded = call(routes.get(CARD_API_WORKSPACES_PATH), { method: "GET", url: CARD_API_WORKSPACES_PATH });
		expect(jsonBody(recorded)).toEqual({ workspaces: [] });
		// The rows are still in the store — hidden, not deleted.
		expect(store.list(vanished)).toHaveLength(1);
	});

	it("answers 405 for non-GET requests on both routes", async () => {
		const { routes, webServer } = makeWebServer();
		mountCardRoutes(webServer, store);
		const workspaces = call(routes.get(CARD_API_WORKSPACES_PATH), { method: "POST", url: CARD_API_WORKSPACES_PATH });
		expect(workspaces.status).toBe(405);
		const memory = call(routes.get(CARD_API_MEMORY_PATH), { method: "PUT", url: CARD_API_MEMORY_PATH });
		expect(memory.status).toBe(405);
	});

	it("answers 400 when the root parameter is missing", async () => {
		const { routes, webServer } = makeWebServer();
		mountCardRoutes(webServer, store);
		const missing = call(routes.get(CARD_API_MEMORY_PATH), { method: "GET", url: CARD_API_MEMORY_PATH });
		expect(missing.status).toBe(400);
	});

	it("answers 404 for a root the store has no rows for", async () => {
		const { routes, webServer } = makeWebServer();
		mountCardRoutes(webServer, store);
		const recorded = call(routes.get(CARD_API_MEMORY_PATH), {
			method: "GET",
			url: `${CARD_API_MEMORY_PATH}?root=${encodeURIComponent("/etc")}`,
		});
		expect(recorded.status).toBe(404);
		expect(jsonBody(recorded)).toEqual({ error: "unknown workspace root" });
	});

	it("serves the read-only snapshot for a known root", async () => {
		const { routes, webServer } = makeWebServer();
		expect(seed()).toBe(true);
		mountCardRoutes(webServer, store);
		const recorded = call(routes.get(CARD_API_MEMORY_PATH), {
			method: "GET",
			url: `${CARD_API_MEMORY_PATH}?root=${encodeURIComponent(workspace)}`,
		});
		expect(recorded.status).toBe(200);
		expect(recorded.headers).toMatchObject({ "content-type": "application/json; charset=utf-8" });
		const body = jsonBody(recorded) as { root: string; exists: boolean; fileCount: number; files: { id: string }[] };
		expect(body.root).toBe(workspace);
		expect(body.exists).toBe(true);
		expect(body.fileCount).toBe(1);
		expect(body.files[0]?.id).toBe("fedora-env");
	});
});

describe("the memory content route", () => {
	function setup(): { routes: Map<string, CardRoute> } {
		const { routes, webServer } = makeWebServer();
		mountCardRoutes(webServer, store);
		return { routes };
	}

	it("answers 405 for non-GET and 400 for a missing id parameter", async () => {
		const { routes } = setup();
		expect(seed()).toBe(true);
		const put = call(routes.get(CARD_API_MEMORY_FILE_PATH), {
			method: "PUT",
			url: `${CARD_API_MEMORY_FILE_PATH}?root=${encodeURIComponent(workspace)}`,
		});
		expect(put.status).toBe(405);
		const noId = call(routes.get(CARD_API_MEMORY_FILE_PATH), {
			method: "GET",
			url: `${CARD_API_MEMORY_FILE_PATH}?root=${encodeURIComponent(workspace)}`,
		});
		expect(noId.status).toBe(400);
	});

	it("serves one memory body keyed by id", async () => {
		const { routes } = setup();
		expect(seed("note", "正文")).toBe(true);
		const recorded = call(routes.get(CARD_API_MEMORY_FILE_PATH), {
			method: "GET",
			url: `${CARD_API_MEMORY_FILE_PATH}?root=${encodeURIComponent(workspace)}&id=${encodeURIComponent("note")}`,
		});
		expect(recorded.status).toBe(200);
		const body = jsonBody(recorded) as { id: string; content: string; updatedAtMs: number };
		expect(body).toMatchObject({ id: "note", content: "正文" });
		expect(body.updatedAtMs).toBeGreaterThan(0);
	});

	it("answers 404 for a deleted memory and for a root with no rows", async () => {
		const { routes } = setup();
		expect(seed()).toBe(true);
		const ghost = call(routes.get(CARD_API_MEMORY_FILE_PATH), {
			method: "GET",
			url: `${CARD_API_MEMORY_FILE_PATH}?root=${encodeURIComponent(workspace)}&id=ghost`,
		});
		expect(ghost.status).toBe(404);
		const stranger = call(routes.get(CARD_API_MEMORY_FILE_PATH), {
			method: "GET",
			url: `${CARD_API_MEMORY_FILE_PATH}?root=${encodeURIComponent("/etc")}&id=x`,
		});
		expect(stranger.status).toBe(404);
	});

	it("never becomes a path oracle: id-shaped or not, only store rows answer", async () => {
		const { routes } = setup();
		expect(seed()).toBe(true);
		for (const id of ["../package.json", "sub/note", "note.txt", "."]) {
			const recorded = call(routes.get(CARD_API_MEMORY_FILE_PATH), {
				method: "GET",
				url: `${CARD_API_MEMORY_FILE_PATH}?root=${encodeURIComponent(workspace)}&id=${encodeURIComponent(id)}`,
			});
			expect(recorded.status).toBe(404);
		}
	});
});
