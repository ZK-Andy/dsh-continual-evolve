import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
	if (workspace) {
		rmSync(workspace, { recursive: true, force: true });
		workspace = "";
	}
});

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

	it("the registered provider renders a section for an agent in a workspace", () => {
		workspace = mkdtempSync(join(tmpdir(), "evolve-plugin-"));
		const { sections, host } = makeCtx();
		apply(host, fullConfig);
		const render = sections[0].text as (context: { agent: unknown }) => string;
		const agent = { id: "s1", session: { header: { cwd: workspace } } };
		const text = render({ agent });
		expect(text).toContain("# 持久记忆");
		expect(text).toContain("<memories>");
		// First render in a fresh workspace bootstraps its store.
		expect(text).not.toBe("");
	});
});

describe("apply card wiring", () => {
	function makeCtxWithWebServer(): {
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
			inject: (services: string[], callback: (scoped: unknown) => void) => {
				callback(services.includes("webServer") ? { webServer } : {});
			},
		}) as Parameters<typeof apply>[0];
		return { sections: base.sections, routes, host };
	}

	it("mounts the card routes on webServer by default", () => {
		const { routes, host } = makeCtxWithWebServer();
		apply(host, fullConfig);
		expect([...routes.keys()]).toEqual([
			"/dsh-continual-evolve/api/v1/workspaces",
			"/dsh-continual-evolve/api/v1/memory",
			"/dsh-continual-evolve/api/v1/memory/file",
		]);
	});

	it("skips card wiring when memoryCard is disabled", () => {
		const { routes, host } = makeCtxWithWebServer();
		apply(host, { ...fullConfig, memoryCard: { enabled: false } });
		expect(routes.size).toBe(0);
	});

	it("feeds served workspaces into the card allowlist", () => {
		workspace = mkdtempSync(join(tmpdir(), "evolve-plugin-card-"));
		const { sections, routes, host } = makeCtxWithWebServer();
		apply(host, fullConfig);
		const render = sections[0].text as (context: { agent: unknown }) => string;
		render({ agent: { id: "s1", session: { header: { cwd: workspace } } } });
		const memoryRoute = routes.get("/dsh-continual-evolve/api/v1/memory") as {
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
		memoryRoute.handler(
			{ method: "GET", url: `/dsh-continual-evolve/api/v1/memory?root=${encodeURIComponent(workspace)}` },
			{
				writeHead: (code) => {
					status = code;
				},
				end: (text) => {
					body = text ?? "";
				},
			},
		);
		expect(status).toBe(200);
		expect(JSON.parse(body).root).toBe(workspace);
	});
});
