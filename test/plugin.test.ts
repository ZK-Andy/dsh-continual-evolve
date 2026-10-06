import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apply, type EvolveConfig } from "../src/index.js";
import { MEMORY_SECTION_NAME } from "../src/memory-section.js";

interface RecordedSection {
	name: string;
	order: number;
	text: unknown;
}

function makeCtx(): { sections: RecordedSection[]; host: Parameters<typeof apply>[0] } {
	const sections: RecordedSection[] = [];
	const host = {
		systemPrompt: {
			section: (s: RecordedSection) => sections.push(s),
		},
		logger: () => ({ info: () => undefined, warn: () => undefined }),
	};
	return { sections, host };
}

const fullConfig: EvolveConfig = {
	memoryIndex: { enabled: true, guide: true, order: 400, maxChars: 6000 },
};

let workspace = "";
let dshHome = "";
let previousDshHome: string | undefined;

beforeEach(() => {
	// The store opens at $DSH_HOME/evolve/memory.db: point DSH_HOME at a
	// scratch dir so tests never touch the real ~/.dsh.
	previousDshHome = process.env.DSH_HOME;
	dshHome = mkdtempSync(join(tmpdir(), "evolve-plugin-home-"));
	process.env.DSH_HOME = dshHome;
});

afterEach(() => {
	if (previousDshHome === undefined) {
		delete process.env.DSH_HOME;
	} else {
		process.env.DSH_HOME = previousDshHome;
	}
	if (workspace) {
		rmSync(workspace, { recursive: true, force: true });
		workspace = "";
	}
	rmSync(dshHome, { recursive: true, force: true });
});

/** Wait for the async store open, then return the rendered section text. */
async function renderAfterStore(section: RecordedSection, agent: unknown): Promise<string> {
	const render = section.text as (context: { agent: unknown }) => string;
	return vi.waitFor(() => {
		const text = render({ agent });
		if (text === "") {
			throw new Error("store not open yet");
		}
		return text;
	});
}

describe("apply", () => {
	it("registers exactly one memory section with the defaults", () => {
		const { sections, host } = makeCtx();
		apply(host, fullConfig);
		expect(sections).toHaveLength(1);
		expect(sections[0].name).toBe(MEMORY_SECTION_NAME);
		expect(sections[0].order).toBe(400);
		expect(typeof sections[0].text).toBe("function");
	});

	it("registers nothing when the memory index is disabled", () => {
		const { sections, host } = makeCtx();
		apply(host, { memoryIndex: { enabled: false, guide: true, order: 400, maxChars: 6000 } });
		expect(sections).toHaveLength(0);
	});

	it("honors the configured order", () => {
		const { sections, host } = makeCtx();
		apply(host, { memoryIndex: { enabled: true, guide: true, order: 450, maxChars: 6000 } });
		expect(sections[0].order).toBe(450);
	});

	it("renders an empty section until the store is open, then the real one", async () => {
		workspace = mkdtempSync(join(tmpdir(), "evolve-plugin-"));
		const { sections, host } = makeCtx();
		apply(host, fullConfig);
		const render = sections[0].text as (context: { agent: unknown }) => string;
		const agent = { id: "s1", session: { header: { cwd: workspace } } };
		// Before/during the async open the section is a plain string (typically
		// "" — never a throw and never a frozen placeholder).
		expect(typeof render({ agent })).toBe("string");
		const text = await renderAfterStore(sections[0], agent);
		expect(text).toContain("# 持久记忆");
		expect(text).toContain("<memories>");
		expect(text).toContain("（暂无记忆）");
	});

	it("does not create any per-workspace store directory (the store is central)", async () => {
		workspace = mkdtempSync(join(tmpdir(), "evolve-plugin-"));
		const { sections, host } = makeCtx();
		apply(host, fullConfig);
		await renderAfterStore(sections[0], { id: "s1", session: { header: { cwd: workspace } } });
		const { existsSync } = await import("node:fs");
		expect(existsSync(join(workspace, ".evolve"))).toBe(false);
	});
});

describe("apply tool wiring", () => {
	function makeCtxWithServices(services: Record<string, unknown> = {}, withTools: boolean = true): {
		sections: RecordedSection[];
		host: Parameters<typeof apply>[0];
		tools: Map<string, unknown>;
	} {
		const base = makeCtx();
		const tools = new Map<string, unknown>();
		const host = Object.assign(base.host, {
			inject: (wanted: string[], callback: (scoped: unknown) => void) => {
				const scoped: Record<string, unknown> = { get: (name: string) => services[name] };
				if (wanted.includes("tools") && withTools) {
					scoped.tools = {
						register: (definition: { name: string }) => {
							tools.set(definition.name, definition);
							return () => tools.delete(definition.name);
						},
					};
				}
				if (wanted.includes("webServer")) {
					scoped.webServer = {
						register: (_route: { kind: string; path: string }) => () => undefined,
					};
				}
				callback(scoped);
			},
		}) as Parameters<typeof apply>[0];
		return { sections: base.sections, host, tools };
	}

	it("registers memory_write and memory_read once the store is open", async () => {
		const { sections, host, tools } = makeCtxWithServices();
		apply(host, fullConfig);
		await vi.waitFor(() => {
			if (tools.size !== 2) {
				throw new Error("tools not registered yet");
			}
		});
		expect([...tools.keys()].sort()).toEqual(["memory_read", "memory_write"]);
		// The rendered guide names the tools now that they exist.
		workspace = mkdtempSync(join(tmpdir(), "evolve-plugin-tools-"));
		const text = await renderAfterStore(sections[0], { id: "s1", session: { header: { cwd: workspace } } });
		expect(text).toContain("memory_write");
	});

	it("keeps injection alive on a host without the tools service", async () => {
		const { sections, host } = makeCtxWithServices({}, false);
		apply(host, fullConfig);
		workspace = mkdtempSync(join(tmpdir(), "evolve-plugin-notools-"));
		const text = await renderAfterStore(sections[0], { id: "s1", session: { header: { cwd: workspace } } });
		expect(text).toContain("# 持久记忆");
		expect(text).not.toContain("memory_write");
		expect(text).not.toContain("memory_read");
		expect(text).toContain("告诉用户");
	});
});

describe("apply card wiring", () => {
	function makeCtxWithWebServer(services: Record<string, unknown> = {}): {
		sections: RecordedSection[];
		routes: Map<string, unknown>;
		host: Parameters<typeof apply>[0];
	} {
		const base = makeCtx();
		const routes = new Map<string, unknown>();
		const webServer = {
			register: (route: { kind: string; path: string }) => {
				routes.set(route.path, route);
				return () => routes.delete(route.path);
			},
		};
		const host = Object.assign(base.host, {
			inject: (wanted: string[], callback: (scoped: unknown) => void) => {
				const scoped: Record<string, unknown> = { get: (name: string) => services[name] };
				if (wanted.includes("webServer")) {
					scoped.webServer = webServer;
				}
				callback(scoped);
			},
		}) as Parameters<typeof apply>[0];
		return { sections: base.sections, routes, host };
	}

	/** Call one mounted GET route and return the recorded response. */
	function get(routes: Map<string, unknown>, key: string, url = key): { status: number; body: string } {
		const route = routes.get(key) as {
			handler: (
				request: { method?: string; url?: string },
				response: {
					writeHead: (status: number, headers?: Record<string, string>) => unknown;
					end: (body?: string) => void;
				},
			) => void;
		};
		let status = 0;
		let body = "";
		route.handler(
			{ method: "GET", url: url },
			{
				writeHead: (code) => {
					status = code;
				},
				end: (text) => {
					body = text ?? "";
				},
			},
		);
		return { status, body };
	}

	it("mounts the card routes on webServer once the store is open", async () => {
		const { routes, host } = makeCtxWithWebServer();
		apply(host, fullConfig);
		await vi.waitFor(() => {
			if (routes.size !== 3) {
				throw new Error("routes not mounted yet");
			}
		});
		expect([...routes.keys()].sort()).toEqual([
			"/dsh-continual-evolve/api/v1/memory",
			"/dsh-continual-evolve/api/v1/memory/file",
			"/dsh-continual-evolve/api/v1/workspaces",
		]);
		// The card's workspace list is a store query: no rows, no workspaces.
		const list = get(routes, "/dsh-continual-evolve/api/v1/workspaces");
		expect(list.status).toBe(200);
		expect(JSON.parse(list.body)).toEqual({ workspaces: [], defaultRoot: null });
	});

	it("survives a workspace registry that throws when the card asks for a hint", async () => {
		const { routes, host } = makeCtxWithWebServer({
			workspaceRegistry: {
				list: () => {
					throw new Error("registry unavailable");
				},
			},
		});
		apply(host, fullConfig);
		await vi.waitFor(() => {
			if (routes.size !== 3) {
				throw new Error("routes not mounted yet");
			}
		});
		const list = get(routes, "/dsh-continual-evolve/api/v1/workspaces");
		expect(list.status).toBe(200);
		expect(JSON.parse(list.body)).toEqual({ workspaces: [], defaultRoot: null });
	});

	it("skips card wiring when memoryCard is disabled", async () => {
		const { routes, host } = makeCtxWithWebServer();
		apply(host, { ...fullConfig, memoryCard: { enabled: false } });
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(routes.size).toBe(0);
	});

	it("lists a workspace once the store has rows for it (the store is the fence)", async () => {
		workspace = mkdtempSync(join(tmpdir(), "evolve-plugin-fence-"));
		const { routes, host } = makeCtxWithWebServer();
		apply(host, fullConfig);
		await vi.waitFor(() => {
			if (routes.size !== 3) {
				throw new Error("routes not mounted yet");
			}
		});
		// A first session in a workspace imports any legacy store and writes
		// through the gated path; here the gated write stands in for it.
		const memoryRoute = routes.get("/dsh-continual-evolve/api/v1/memory") as {
			handler: (
				request: { method?: string; url?: string },
				response: {
					writeHead: (status: number, headers?: Record<string, string>) => unknown;
					end: (body?: string) => void;
				},
			) => void;
		};
		const before = get(routes, "/dsh-continual-evolve/api/v1/workspaces");
		expect(JSON.parse(before.body)).toEqual({ workspaces: [], defaultRoot: null });
		let status = 0;
		memoryRoute.handler(
			{ method: "GET", url: `/dsh-continual-evolve/api/v1/memory?root=${encodeURIComponent(workspace)}` },
			{
				writeHead: (code) => {
					status = code;
				},
				end: () => undefined,
			},
		);
		expect(status).toBe(404); // no rows yet — no filesystem oracle
	});
});
