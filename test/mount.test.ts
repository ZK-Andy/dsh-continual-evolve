import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountCardWhenAvailable, mountSettingsPresentation } from "../src/pages/memory-card/mount.js";
import {
	CARD_API_MEMORY_PATH,
	CARD_API_REVIEW_SETTINGS_PATH,
	type CardRequest,
	type CardResponse,
	type CardRoute,
	type CardWebServer,
} from "../src/pages/memory-card/card-routes.js";
import type { HostContext } from "../src/index.js";
import { openMemoryStore, type MemoryStore } from "../src/store.js";

function makeLog(): {
	events: string[];
	log: { warn(event: string, message: string): void; info(event: string, message: string): void };
} {
	const events: string[] = [];
	return {
		events,
		log: {
			warn: (event: string) => events.push(`warn:${event}`),
			info: (event: string) => events.push(`info:${event}`),
		},
	};
}

let store: MemoryStore;
let dbDir = "";

beforeEach(async () => {
	dbDir = mkdtempSync(join(tmpdir(), "evolve-mount-db-"));
	store = await openMemoryStore(join(dbDir, "memory.db"));
});

afterEach(() => {
	store.close();
	rmSync(dbDir, { recursive: true, force: true });
});

function bareHost(extra: Record<string, unknown> = {}): HostContext {
	return { systemPrompt: { section: () => {} }, ...extra } as HostContext;
}

function makeWebServer(): { routes: Map<string, CardRoute>; webServer: CardWebServer } {
	const routes = new Map<string, CardRoute>();
	return {
		routes,
		webServer: {
			register(route: CardRoute) {
				routes.set(route.path, route);
				return () => routes.delete(route.path);
			},
		},
	};
}

function postRoute(routes: Map<string, CardRoute>, body: unknown): { status: number; body: string } {
	const route = routes.get(CARD_API_REVIEW_SETTINGS_PATH);
	if (route === undefined) {
		throw new Error("settings route not mounted");
	}
	let status = 0;
	let text = "";
	const response = {
		writeHead(code: number) {
			status = code;
			return response;
		},
		end(content?: string) {
			text = content ?? "";
		},
	} as CardResponse;
	route.handler({ method: "POST", url: CARD_API_REVIEW_SETTINGS_PATH, body } as CardRequest, response);
	return {
		get status() {
			return status;
		},
		get body() {
			return text;
		},
	};
}

async function flush(times = 10): Promise<void> {
	for (let index = 0; index < times; index++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

const SNAPSHOT = { enabled: true, dryRun: true, dailyBudget: 100, batchSize: 10, staleDays: 30 };

describe("memory-card mount", () => {
	it("warns and mounts nothing without nested inject", () => {
		const { events, log } = makeLog();
		mountCardWhenAvailable(bareHost(), store, () => ({ ...SNAPSHOT }), log);
		expect(events).toEqual(["warn:card-not-mounted"]);
	});

	it("warns when the web server service is empty", () => {
		const { events, log } = makeLog();
		const host = bareHost({
			inject: (_services: string[], callback: (scoped: unknown) => void) => callback({}),
		});
		mountCardWhenAvailable(host, store, () => ({ ...SNAPSHOT }), log);
		expect(events).toEqual(["warn:card-empty-server"]);
	});

	it("mounts the memory and settings routes on a host web server", () => {
		const { events, log } = makeLog();
		const { routes, webServer } = makeWebServer();
		const host = bareHost({
			inject: (_services: string[], callback: (scoped: unknown) => void) => callback({ webServer }),
		});
		mountCardWhenAvailable(host, store, () => ({ ...SNAPSHOT }), log);
		expect(routes.has(CARD_API_MEMORY_PATH)).toBe(true);
		expect(routes.has(CARD_API_REVIEW_SETTINGS_PATH)).toBe(true);
		expect(events).toHaveLength(0);
	});

	it("maps an unwritable host to 500 on settings POST", async () => {
		const { log } = makeLog();
		const { routes, webServer } = makeWebServer();
		const host = bareHost({
			inject: (_services: string[], callback: (scoped: unknown) => void) => callback({ webServer }),
		});
		mountCardWhenAvailable(host, store, () => ({ ...SNAPSHOT }), log);
		const recorded = postRoute(routes, { dryRun: false });
		await flush();
		expect(recorded.status).toBe(500);
	});

	it("persists patches in submission order through the config editor", async () => {
		const { log } = makeLog();
		const { routes, webServer } = makeWebServer();
		const committed: unknown[] = [];
		let current: Record<string, unknown> = {};
		const editor = {
			edit: async (_entry: unknown, change: (value: Record<string, unknown>) => Record<string, unknown>) => {
				committed.push(change(current));
			},
		};
		const host = bareHost({
			inject: (_services: string[], callback: (scoped: unknown) => void) => callback({ webServer }),
			get: (name: string) => (name === "configEditor" ? editor : undefined),
			fiber: { entry: { plugin: "continual-evolve" } },
		});
		mountCardWhenAvailable(host, store, () => ({ ...SNAPSHOT }), log);
		const first = postRoute(routes, { dryRun: false });
		const second = postRoute(routes, { staleDays: 7 });
		await flush();
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(committed).toEqual([{ review: { dryRun: false } }, { review: { staleDays: 7 } }]);
		// A non-record review base merges from empty instead of spreading junk.
		current = { review: 42 };
		const third = postRoute(routes, { batchSize: 5 });
		await flush();
		expect(third.status).toBe(200);
		expect(committed[2]).toEqual({ review: { batchSize: 5 } });
	});
});

describe("settings presentation", () => {
	it("stays silent without inject or without the settings service", () => {
		const { events, log } = makeLog();
		mountSettingsPresentation(bareHost(), log);
		const noService = bareHost({
			inject: (_services: string[], callback: (scoped: unknown) => void) => callback({}),
		});
		mountSettingsPresentation(noService, log);
		const noConfigure = bareHost({
			inject: (_services: string[], callback: (scoped: unknown) => void) => callback({ settings: {} }),
			fiber: {},
		});
		mountSettingsPresentation(noConfigure, log);
		const noFiber = bareHost({
			inject: (_services: string[], callback: (scoped: unknown) => void) =>
				callback({ settings: { configure: () => {} } }),
		});
		mountSettingsPresentation(noFiber, log);
		expect(events).toHaveLength(0);
	});

	it("disables the automatic settings page on the owning fiber", () => {
		const { events, log } = makeLog();
		const seen: unknown[][] = [];
		const fiber = { id: "fiber-1" };
		const host = bareHost({
			inject: (_services: string[], callback: (scoped: unknown) => void) =>
				callback({
					settings: {
						configure: (presentation: unknown, owner: unknown) => {
							seen.push([presentation, owner]);
							return () => {};
						},
					},
				}),
			fiber,
		});
		mountSettingsPresentation(host, log);
		expect(seen).toEqual([[{ auto: false }, fiber]]);
		expect(events).toHaveLength(0);
	});

	it("registers through the scoped effect when the host provides one", () => {
		const { events, log } = makeLog();
		const fiber = { id: "fiber-2" };
		let configured = 0;
		const host = bareHost({
			inject: (_services: string[], callback: (scoped: unknown) => void) =>
				callback({
					settings: {
						configure: () => {
							configured++;
							return () => {};
						},
					},
					effect: (callback: () => () => void) => callback(),
				}),
			fiber,
		});
		mountSettingsPresentation(host, log);
		expect(configured).toBe(1);
		expect(events).toHaveLength(0);
	});

	it("warns and keeps the default when configuration throws", () => {
		const { events, log } = makeLog();
		const host = bareHost({
			inject: (_services: string[], callback: (scoped: unknown) => void) =>
				callback({
					settings: {
						configure: () => {
							throw new Error("denied");
						},
					},
				}),
			fiber: {},
		});
		mountSettingsPresentation(host, log);
		expect(events).toEqual(["warn:settings-presentation-kept"]);
	});
});
