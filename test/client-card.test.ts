import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const BUNDLE_PATH = fileURLToPath(new URL("../client/client.js", import.meta.url));

interface LoadDefinition {
	id: string;
	factory: (require: (name: string) => unknown) => unknown;
}

/** Evaluate the bundle the way the host does: a fake window + module table. */
function loadBundle(react: unknown): { definition: LoadDefinition; exports: Record<string, unknown> } {
	let definition: LoadDefinition | undefined;
	const window = {
		__ModuleLoader__: {
			load: (loaded: LoadDefinition) => {
				definition = loaded;
			},
		},
	};
	const code = readFileSync(BUNDLE_PATH, "utf8");
	new Function("window", code)(window);
	if (definition === undefined) {
		throw new Error("client bundle never called __ModuleLoader__.load");
	}
	const exports = definition.factory(() => react) as Record<string, unknown>;
	return { definition, exports };
}

/** A react stub: elements are plain descriptors, hooks are unused here. */
function makeReact(): Record<string, unknown> {
	return {
		createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
		useState: () => [{ status: "loading" }, () => undefined],
		useEffect: () => undefined,
	};
}

function makeCtx() {
	const registrations: Array<{ meta: Record<string, unknown>; render: (ownerProps: unknown) => unknown }> = [];
	const injectedSlots: string[] = [];
	const ctx = {
		slots: {
			inject: (slot: string, register: () => unknown) => {
				injectedSlots.push(slot);
				return register();
			},
			register: (meta: Record<string, unknown>, render: (ownerProps: unknown) => unknown) => {
				registrations.push({ meta, render });
				return () => undefined;
			},
		},
	};
	return { ctx, registrations, injectedSlots };
}

function jsonResponse(body: unknown, status = 200): { ok: boolean; status: number; json: () => Promise<unknown> } {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("client bundle", () => {
	it("loads through __ModuleLoader__ with the package id and core exports", () => {
		const { definition, exports } = loadBundle(makeReact());
		expect(definition.id).toBe("dsh-continual-evolve");
		expect(exports.name).toBe("dsh-continual-evolve");
		expect(exports.inject).toEqual(["slots"]);
		expect(typeof exports.apply).toBe("function");
		expect(typeof exports.loadCardModel).toBe("function");
	});

	it("disables itself with a warning when the host react module is missing", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const { exports } = loadBundle(undefined);
			expect(exports.name).toBeUndefined();
			expect(exports.apply).toBeUndefined();
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("registers one plugins.bundle.config slot whose summary view is null", () => {
		const { exports } = loadBundle(makeReact());
		const { ctx, registrations, injectedSlots } = makeCtx();
		(exports.apply as (ctx: unknown) => void)(ctx);
		expect(injectedSlots).toEqual(["plugins.bundle.config"]);
		expect(registrations).toHaveLength(1);
		expect(registrations[0].meta.name).toBe("plugins.bundle.config");
		expect(registrations[0].meta.key).toBe("dsh-continual-evolve");
		// The list row's one-liner comes from the package description; the card is the page.
		expect(registrations[0].render({ view: "summary" })).toBeNull();
		expect(registrations[0].render({})).not.toBeNull();
	});
});

describe("loadCardModel", () => {
	it("assembles one snapshot entry per known workspace", async () => {
		const { exports } = loadBundle(makeReact());
		const loadCardModel = exports.loadCardModel as (fetchImpl: typeof fetch) => Promise<{
			workspaces: Array<{ root: string; snapshot: { root: string } | null; error: string | null }>;
		}>;
		const calls: string[] = [];
		const fetchImpl = (async (url: string | URL) => {
			calls.push(String(url));
			if (String(url).endsWith("/workspaces")) {
				return jsonResponse({ workspaces: [{ root: "/ws/a", lastSeen: "t1" }] });
			}
			return jsonResponse({ root: "/ws/a", exists: true, fileCount: 2 });
		}) as unknown as typeof fetch;
		const model = await loadCardModel(fetchImpl);
		expect(model.workspaces).toHaveLength(1);
		expect(model.workspaces[0].root).toBe("/ws/a");
		expect(model.workspaces[0].error).toBeNull();
		expect(model.workspaces[0].snapshot).toMatchObject({ exists: true });
		expect(calls.some((url) => url.includes("/memory?root=" + encodeURIComponent("/ws/a")))).toBe(true);
	});

	it("degrades a failing workspace snapshot to an error entry", async () => {
		const { exports } = loadBundle(makeReact());
		const loadCardModel = exports.loadCardModel as (fetchImpl: typeof fetch) => Promise<{
			workspaces: Array<{ root: string; snapshot: unknown; error: string | null }>;
		}>;
		const fetchImpl = (async (url: string | URL) => {
			if (String(url).endsWith("/workspaces")) {
				return jsonResponse({ workspaces: [{ root: "/ws/bad", lastSeen: "t2" }] });
			}
			return jsonResponse({ error: "unknown workspace root" }, 404);
		}) as unknown as typeof fetch;
		const model = await loadCardModel(fetchImpl);
		expect(model.workspaces[0].error).toBe("HTTP 404");
		expect(model.workspaces[0].snapshot).toBeNull();
	});

	it("treats a non-array allowlist as an empty card", async () => {
		const { exports } = loadBundle(makeReact());
		const loadCardModel = exports.loadCardModel as (fetchImpl: typeof fetch) => Promise<{
			workspaces: unknown[];
		}>;
		const fetchImpl = (async () => jsonResponse({ workspaces: "garbage" })) as unknown as typeof fetch;
		const model = await loadCardModel(fetchImpl);
		expect(model.workspaces).toEqual([]);
	});

	it("rejects when the allowlist API itself fails", async () => {
		const { exports } = loadBundle(makeReact());
		const loadCardModel = exports.loadCardModel as (fetchImpl: typeof fetch) => Promise<unknown>;
		const fetchImpl = (async () => jsonResponse({}, 500)) as unknown as typeof fetch;
		await expect(loadCardModel(fetchImpl)).rejects.toThrow("HTTP 500");
	});
});
