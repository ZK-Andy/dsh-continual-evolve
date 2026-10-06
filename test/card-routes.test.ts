import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
			// The only partition there is, so it is also the one to open on.
			defaultRoot: workspace,
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
		expect(jsonBody(recorded)).toEqual({ workspaces: [], defaultRoot: null });
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

describe("the default workspace the card opens on", () => {
	const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

	/** One active memory in another partition (its own temp directory). */
	function seedInto(root: string, id: string): void {
		store.applyProposals({ workspaceId: root, trigger: "explicit" }, [
			{ action: "create", id, type: "user", title: id, description: "d", body: "b" },
		]);
	}

	/** The workspaces route's answer for the mounted card. */
	function listWith(options: Parameters<typeof mountCardRoutes>[2] = {}): {
		workspaces: { root: string }[];
		defaultRoot: string | null;
	} {
		const { routes, webServer } = makeWebServer();
		mountCardRoutes(webServer, store, options);
		return jsonBody(call(routes.get(CARD_API_WORKSPACES_PATH), { method: "GET", url: CARD_API_WORKSPACES_PATH })) as {
			workspaces: { root: string }[];
			defaultRoot: string | null;
		};
	}

	it("prefers the host's current workspace over the store's own activity", async () => {
		const other = mkdtempSync(join(tmpdir(), "evolve-card-hint-"));
		expect(seed()).toBe(true);
		await sleep(10);
		seedInto(other, "later");
		// The store alone would answer `other`: its ledger row is the newest.
		expect(store.mostRecentlyActiveWorkspace()).toBe(other);
		expect(listWith({ currentWorkspace: () => workspace }).defaultRoot).toBe(workspace);
		rmSync(other, { recursive: true, force: true });
	});

	it("falls back to the store's most recently active partition", async () => {
		const other = mkdtempSync(join(tmpdir(), "evolve-card-fallback-"));
		expect(seed()).toBe(true);
		await sleep(10);
		seedInto(other, "later");
		expect(listWith().defaultRoot).toBe(other);
		rmSync(other, { recursive: true, force: true });
	});

	it("ignores a hint outside the listed set and a hint that throws", () => {
		expect(seed()).toBe(true);
		// The listed set is a store projection: a root the store cannot serve is
		// never opened on, however confidently the host names it.
		expect(listWith({ currentWorkspace: () => "/etc" }).defaultRoot).toBe(workspace);
		expect(
			listWith({
				currentWorkspace: () => {
					throw new Error("registry unavailable");
				},
			}).defaultRoot,
		).toBe(workspace);
	});

	it("matches a hint whose spelling is a symlink to a listed root", () => {
		expect(seed()).toBe(true);
		const link = join(mkdtempSync(join(tmpdir(), "evolve-card-link-")), "link");
		symlinkSync(workspace, link);
		expect(listWith({ currentWorkspace: () => link }).defaultRoot).toBe(workspace);
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
