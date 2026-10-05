import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const BUNDLE_PATH = fileURLToPath(new URL("../client/client.js", import.meta.url));

interface LoadDefinition {
	id: string;
	factory: (require: (name: string) => unknown) => unknown;
}

/** Evaluate the bundle the way the host does: a fake window + module table. */
function loadBundle(
	react: unknown,
	modules: Record<string, unknown> = {},
): { definition: LoadDefinition; exports: Record<string, unknown> } {
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
	const requireImpl = (name: string): unknown => {
		if (name in modules) {
			return modules[name];
		}
		if (name === "react") {
			return react;
		}
		throw new Error("unknown host module " + name);
	};
	const exports = definition.factory(requireImpl) as Record<string, unknown>;
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

interface ElementLike {
	type: unknown;
	props?: Record<string, unknown> | null;
	children?: unknown[];
}

interface HookStore {
	states: unknown[];
	setters: Array<(value: unknown) => void>;
	refs: unknown[];
}

/**
 * A react stub whose hooks really store state, so a test can drive the card
 * from collapsed/loading into the open/ready tree its file list lives in.
 * Stores are keyed per component — real React keys hooks by fiber, and a test
 * that renders the card and then a nested component in the same pass would
 * otherwise reuse the card's slots. `begin(name)` selects the component whose
 * hooks the next render call consumes (default `card`); `states`/`setters`
 * read the selected one.
 */
function makeHookReact() {
	const stores = new Map<string, HookStore>();
	let key = "card";
	let cursor = 0;
	const store = (): HookStore => {
		const existing = stores.get(key);
		if (existing !== undefined) {
			return existing;
		}
		const created: HookStore = { states: [], setters: [], refs: [] };
		stores.set(key, created);
		return created;
	};
	return {
		begin(name?: string) {
			key = name ?? "card";
			cursor = 0;
		},
		get states(): unknown[] {
			return store().states;
		},
		get setters(): Array<(value: unknown) => void> {
			return store().setters;
		},
		react: {
			createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
			useState: (initial: unknown) => {
				const target = store();
				const slot = cursor++;
				if (target.setters[slot] === undefined) {
					target.states[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial;
					target.setters[slot] = (value: unknown) => {
						target.states[slot] =
							typeof value === "function" ? (value as (current: unknown) => unknown)(target.states[slot]) : value;
					};
				}
				return [target.states[slot], target.setters[slot]];
			},
			useEffect: () => undefined,
			useRef: (initial: unknown) => {
				const target = store();
				const slot = cursor++;
				if (target.refs[slot] === undefined) {
					target.refs[slot] = { current: initial };
				}
				return target.refs[slot];
			},
		},
	};
}

/** Every element in the tree whose component function carries this name. */
function findAllByName(node: unknown, name: string): ElementLike[] {
	const found: ElementLike[] = [];
	const walk = (current: unknown): void => {
		if (Array.isArray(current)) {
			for (const child of current) {
				walk(child);
			}
			return;
		}
		if (current === null || typeof current !== "object") {
			return;
		}
		const element = current as ElementLike;
		if (typeof element.type === "function" && (element.type as { name?: string }).name === name) {
			found.push(element);
		}
		walk(element.children);
	};
	walk(node);
	return found;
}

/** Every element in the tree carrying this ARIA role. */
function findAllByRole(node: unknown, role: string): ElementLike[] {
	const found: ElementLike[] = [];
	const walk = (current: unknown): void => {
		if (Array.isArray(current)) {
			for (const child of current) {
				walk(child);
			}
			return;
		}
		if (current === null || typeof current !== "object") {
			return;
		}
		const element = current as ElementLike;
		if (element.props?.role === role) {
			found.push(element);
		}
		walk(element.children);
	};
	walk(node);
	return found;
}

function makeCtx(locale?: {
	register: (ns: string, dicts: unknown) => unknown;
	bind: (ns: string) => (key: string) => string;
}) {
	const registrations: Array<{ meta: Record<string, unknown>; render: (ownerProps: unknown) => unknown }> = [];
	const injectedSlots: string[] = [];
	const effects: string[] = [];
	const ctx: Record<string, unknown> = {
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
		effect: (fn: () => unknown, label: string) => {
			effects.push(label);
			return fn();
		},
	};
	if (locale !== undefined) {
		ctx.locale = locale;
	}
	return { ctx, registrations, injectedSlots, effects };
}

function jsonResponse(body: unknown, status = 200): { ok: boolean; status: number; json: () => Promise<unknown> } {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("client bundle", () => {
	it("loads through __ModuleLoader__ with market-parity inject and core exports", () => {
		const { definition, exports } = loadBundle(makeReact());
		expect(definition.id).toBe("dsh-continual-evolve");
		expect(exports.name).toBe("dsh-continual-evolve");
		expect(exports.inject).toEqual(["slots", "locale", "theme"]);
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
		expect(registrations[0].meta.locale).toBe("dsh-continual-evolve");
		// The list row's one-liner comes from the package description; the card is the page.
		expect(registrations[0].render({ view: "summary" })).toBeNull();
		expect(registrations[0].render({})).not.toBeNull();
	});

	it("registers zh/en dictionaries and binds the host locale when available", () => {
		const registered: Array<{ ns: string; dicts: Record<string, Record<string, string>> }> = [];
		let boundNs = "";
		const locale = {
			register: (ns: string, dicts: Record<string, Record<string, string>>) => {
				registered.push({ ns, dicts });
				return () => undefined;
			},
			bind: (ns: string) => {
				boundNs = ns;
				return (key: string) => "en:" + key;
			},
		};
		const { exports } = loadBundle(makeReact());
		const { ctx, effects } = makeCtx(locale);
		(exports.apply as (ctx: unknown) => void)(ctx);
		expect(registered).toHaveLength(1);
		expect(registered[0].ns).toBe("dsh-continual-evolve");
		expect(registered[0].dicts.zh.title).toBe("工作区记忆");
		expect(registered[0].dicts.en.title).toBe("Workspace Memory");
		expect(registered[0].dicts.zh.localeTag).toBe("zh-CN");
		expect(registered[0].dicts.en.localeTag).toBe("en-US");
		expect(boundNs).toBe("dsh-continual-evolve");
		expect(effects).toContain("dsh-continual-evolve: dictionaries");
	});

	it("degrades to themed plain elements when primitives and locale are absent", () => {
		const { exports } = loadBundle(makeReact());
		const { ctx, registrations } = makeCtx();
		(exports.apply as (ctx: unknown) => void)(ctx);
		expect(registrations).toHaveLength(1);
		// Loading state renders without throwing: fallback t + fallback button.
		const element = registrations[0].render({}) as { props: { t: (key: string) => string } };
		expect(element.props.t("title")).toContain("工作区记忆");
	});

	it("uses the host Button primitive for refresh when the host provides it", () => {
		const created: unknown[] = [];
		const reactWithSpy = {
			...makeReact(),
			createElement: (type: unknown, props: unknown, ...children: unknown[]) => {
				created.push(type);
				return { type, props, children };
			},
		};
		const FakeButton = function FakeButton(): null {
			return null;
		};
		const { exports } = loadBundle(reactWithSpy, {
			"@deepseek-ai/dsh-client-ui-primitives": { Button: FakeButton },
		});
		const { ctx, registrations } = makeCtx();
		(exports.apply as (ctx: unknown) => void)(ctx);
		expect(registrations).toHaveLength(1);
		const card = registrations[0].render({}) as { type: (props: never) => unknown; props: Record<string, unknown> };
		// The card element targets the MemoryCard component with a UI handle.
		expect(typeof card.type).toBe("function");
		expect(card.props.UI).toMatchObject({ Button: FakeButton });
		expect(created).not.toHaveLength(0);
	});

	it("ships the dshmarket SettingsCard shape and the ZCode viewer content surface", () => {
		const code = readFileSync(BUNDLE_PATH, "utf8");
		expect(code).toContain('title: "工作区记忆"');
		expect(code).toContain('title: "Workspace Memory"');
		// SettingsCard form: collapsed-by-default framed disclosure with a
		// rotating chevron, hover/open states, one injected stylesheet.
		expect(code).toContain('"dsh-continual-evolve-card-css"');
		expect(code).toContain("style.id = STYLE_ID");
		expect(code).toContain('.dce-card[data-open="true"]');
		expect(code).toContain(".dce-card:hover");
		expect(code).toContain('.dce-chevron[data-open="true"]');
		expect(code).toContain("aria-expanded");
		expect(code).toContain("IconChevronDownOutlineRegular");
		expect(code).toContain('"▾"');
		// ZCode memory viewer content: a workspace scope selector, file search,
		// relative updated time, click-to-preview with the deleted/too-large states.
		expect(code).toContain("searchPlaceholder");
		expect(code).toContain("function formatRelative");
		expect(code).toContain("previewTooLarge");
		expect(code).toContain("previewDeleted");
		expect(code).toContain("/memory/file?root=");
		expect(code).toContain("workspaceLabel");
		// The scope selector is a dropdown, not the chip row it replaced.
		expect(code).toContain("scopeLabel");
		expect(code).toContain('className: "dce-scope"');
		expect(code).toContain('role: "menu"');
		expect(code).toContain('role: "menuitemradio"');
		expect(code).not.toContain("dce-chip");
		// The list is the host Menu primitive when available, and the old-host
		// fallback closes on pointerdown outside its wrapper — never on a click
		// listener, which the opening click itself would trigger.
		expect(code).toContain("UI.Menu");
		expect(code).toContain("dce-scope-pill");
		expect(code).toContain("IconFolderOpenOutlineRegular");
		expect(code).toContain("FileTypeIcon");
		expect(code).toContain('addEventListener("pointerdown"');
		expect(code).not.toContain('addEventListener("click"');
		// Theme tokens still route through the alias layer.
		expect(code).toContain("var(--dsw-alias-bg-layer-1");
		expect(code).toContain("UI.Button");
		// The v0.12.1 [object Object] shape must not return.
		expect(code).not.toMatch(/createElement\("strong"[^)]*\)\s*\+/);
	});

	it("exposes the locale meta files the host plugin metadata reader consumes", () => {
		const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
			exports: Record<string, string>;
			files: string[];
			description: string;
		};
		expect(packageJson.exports["./locale/*.json"]).toBe("./locale/*.json");
		expect(packageJson.files).toContain("locale/*.json");
		// npm sees English only; the localized strings live in the locale files.
		expect(packageJson.description).not.toMatch(/[／/]/);
		for (const language of ["en", "zh"]) {
			const meta = JSON.parse(
				readFileSync(fileURLToPath(new URL(`../locale/${language}.json`, import.meta.url)), "utf8"),
			) as { meta: { title: string; description: string } };
			expect(meta.meta.title.length).toBeGreaterThan(0);
			expect(meta.meta.description.length).toBeGreaterThan(0);
		}
	});
});

describe("card refresh wiring", () => {
	// Hook order in the card: 0 open, 1 model, 2 reload counter, 3 selection, 4 preview, 5 now.
	it("wires the file-list refresh button to the card's own reload", () => {
		const harness = makeHookReact();
		const { exports } = loadBundle(harness.react);
		const { ctx, registrations } = makeCtx();
		(exports.apply as (ctx: unknown) => void)(ctx);
		const card = registrations[0].render({}) as ElementLike;
		const render = (): ElementLike => {
			harness.begin();
			return (card.type as (props: unknown) => ElementLike)(card.props);
		};
		// Collapsed by default: the viewer — and its refresh button — is not in the tree yet.
		expect(findAllByName(render(), "WorkspaceBlock")).toHaveLength(0);
		harness.setters[0](true);
		harness.setters[1]({ status: "ready", model: { workspaces: [{ root: "/ws/a" }] }, message: "" });
		const blocks = findAllByName(render(), "WorkspaceBlock");
		expect(blocks).toHaveLength(1);
		const onRefresh = blocks[0].props?.onRefresh;
		expect(typeof onRefresh).toBe("function");
		// Clicking it must put the card back into loading and bump the reload
		// counter the snapshot effect depends on; an inert button leaves both alone.
		(onRefresh as () => void)();
		expect(harness.states[1]).toMatchObject({ status: "loading", model: null });
		expect(harness.states[2]).toBe(1);
	});
});

describe("workspace scope selector", () => {
	/** Render the open card over the given workspace entries, down to the block. */
	function renderBlockTree(
		harness: ReturnType<typeof makeHookReact>,
		entries: Array<Record<string, unknown>>,
		modules: Record<string, unknown> = {},
	): ElementLike {
		const { exports } = loadBundle(harness.react, modules);
		const { ctx, registrations } = makeCtx();
		(exports.apply as (ctx: unknown) => void)(ctx);
		const card = registrations[0].render({}) as ElementLike;
		const render = (): ElementLike => {
			harness.begin();
			return (card.type as (props: unknown) => ElementLike)(card.props);
		};
		render();
		harness.setters[0](true);
		harness.setters[1]({ status: "ready", model: { workspaces: entries }, message: "" });
		const tree = render();
		// The scope menu lives inside the block component, one level below the
		// element tree; render that level explicitly.
		const block = findAllByName(tree, "WorkspaceBlock")[0] as ElementLike;
		harness.begin("block");
		return (block.type as (props: unknown) => ElementLike)(block.props);
	}

	/** Render the scope menu component itself, closed or open. */
	function renderMenu(harness: ReturnType<typeof makeHookReact>, tree: ElementLike, open: boolean): ElementLike {
		const menu = findAllByName(tree, "WorkspaceScopeMenu")[0] as ElementLike;
		const render = (): ElementLike => {
			harness.begin("menu");
			return (menu.type as (props: unknown) => ElementLike)(menu.props);
		};
		render();
		if (open) {
			harness.setters[0](true);
			return render();
		}
		return render();
	}

	it("offers the selector even for a single workspace", () => {
		const harness = makeHookReact();
		const tree = renderBlockTree(harness, [{ root: "/ws/a", label: "A", snapshot: null, error: null }]);
		const menus = findAllByName(tree, "WorkspaceScopeMenu");
		expect(menus).toHaveLength(1);
		expect(menus[0].props?.workspaces).toEqual([{ root: "/ws/a", label: "A" }]);
		// Closed: a trigger is visible, no menu surface yet. A chip row used to
		// render nothing here, which is why the capability looked missing.
		const closed = renderMenu(harness, tree, false);
		expect(findAllByRole(closed, "menu")).toHaveLength(0);
		expect(closed.children?.[0]).toMatchObject({
			props: { "aria-haspopup": "menu", "aria-expanded": "false" },
		});
	});

	it("switches the selected workspace when another option is clicked", () => {
		const harness = makeHookReact();
		const tree = renderBlockTree(harness, [
			{ root: "/ws/a", label: "A", snapshot: null, error: null },
			{ root: "/ws/b", label: "B", snapshot: null, error: null },
		]);
		const openTree = renderMenu(harness, tree, true);
		const options = findAllByRole(openTree, "menuitemradio");
		expect(options.map((option) => option.props?.["aria-checked"])).toEqual(["true", "false"]);
		// Clicking the other workspace routes through the card's selection state.
		const click = options[1].props?.onClick as (() => void) | undefined;
		expect(typeof click).toBe("function");
		(click as () => void)();
		harness.begin();
		expect(harness.states[3]).toMatchObject({ root: "/ws/b", query: "", expandedFile: null });
	});

	it("draws the list with the host Menu primitive when the host provides it", () => {
		const harness = makeHookReact();
		const FakeMenu = function FakeMenu(): null {
			return null;
		};
		const FakeButton = function FakeButton(): null {
			return null;
		};
		const FakeFolder = function FakeFolder(): null {
			return null;
		};
		const FakeFileIcon = function FakeFileIcon(): null {
			return null;
		};
		const snapshot = {
			exists: true,
			fileCount: 1,
			files: [{ id: "note", title: "note", description: "", type: "user", status: "active", updatedAt: Date.now() }],
			quarantined: [],
			lastPatrol: null,
			readError: null,
		};
		const tree = renderBlockTree(
			harness,
			[
				{ root: "/ws/a", label: "A", snapshot: snapshot, error: null },
				{ root: "/ws/b", label: "B", snapshot: snapshot, error: null },
			],
			{
				"@deepseek-ai/dsh-client-ui-primitives": {
					Button: FakeButton,
					Menu: FakeMenu,
					IconFolderOpenOutlineRegular: FakeFolder,
					FileTypeIcon: FakeFileIcon,
				},
			},
		);
		const scope = findAllByName(tree, "WorkspaceScopeMenu")[0] as ElementLike;
		harness.begin("menu");
		const rendered = (scope.type as (props: unknown) => ElementLike)(scope.props);
		// The list is the host's own menu surface (it owns outside-click and
		// Escape), anchored on the host Button carrying the folder marker.
		expect(rendered.type).toBe(FakeMenu);
		const anchor = rendered.props?.anchor as ElementLike;
		expect(anchor.type).toBe(FakeButton);
		// The Button's leading icon resolves to the host's folder glyph.
		const iconElement = anchor.props?.icon as ElementLike;
		harness.begin("folder");
		const icon = (iconElement.type as (props: unknown) => ElementLike)(iconElement.props);
		expect(icon.type).toBe(FakeFolder);
		expect(rendered.props?.selectedId).toBe("/ws/a");
		expect(rendered.props?.items).toEqual([
			{ id: "/ws/a", label: "A", icon: expect.anything() },
			{ id: "/ws/b", label: "B", icon: expect.anything() },
		]);
		// Row activation is the host menu's own path and must switch scope.
		const activate = rendered.props?.onSelect as ((id: string) => void) | undefined;
		expect(typeof activate).toBe("function");
		(activate as (id: string) => void)("/ws/b");
		harness.begin();
		expect(harness.states[3]).toMatchObject({ root: "/ws/b" });
		// File rows open with the host's category tile, like ZCode's viewer.
		const row = findAllByName(tree, "FileRow")[0] as ElementLike;
		harness.begin("row");
		const rowTree = (row.type as (props: unknown) => ElementLike)(row.props);
		// FileRow renders an <li> whose first child array holds the row button.
		const rowButton = ((rowTree.children as unknown[])[0] as ElementLike[])[0];
		const cells = (rowButton.children as unknown[])[0] as ElementLike[];
		expect(cells[0].props?.className).toBe("dce-file-icon");
		expect(((cells[0].children as ElementLike[])[0] as ElementLike).type).toBe(FakeFileIcon);
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
				return jsonResponse({ workspaces: [{ root: "/ws/a", label: "A" }] });
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

describe("loadFileContent", () => {
	const ROOT = "/ws/a";
	const FILE = "note.md";

	function makeLoad(): (fetchImpl: typeof fetch) => Promise<unknown> {
		const { exports } = loadBundle(makeReact());
		return exports.loadFileContent as (fetchImpl: typeof fetch) => Promise<unknown>;
	}

	it("requests the content endpoint with encoded root and file and returns the body", async () => {
		const calls: string[] = [];
		const load = makeLoad();
		const fetchImpl = (async (url: string | URL) => {
			calls.push(String(url));
			return jsonResponse({ file: FILE, content: "正文", changed: false });
		}) as unknown as typeof fetch;
		const result = (await load(fetchImpl, ROOT, FILE)) as { status: string; content: string };
		expect(result).toEqual({ status: "ready", content: "正文", message: "" });
		expect(calls[0]).toContain("/memory/file?root=" + encodeURIComponent(ROOT) + "&id=" + encodeURIComponent(FILE));
	});

	it("maps 404 to deleted and 413 to tooLarge without messages", async () => {
		const load = makeLoad();
		let status = 404;
		const fetchImpl = (async () => jsonResponse({ error: "x" }, status)) as unknown as typeof fetch;
		expect(await load(fetchImpl, ROOT, FILE)).toEqual({ status: "deleted", content: "", message: "" });
		status = 413;
		expect(await load(fetchImpl, ROOT, FILE)).toEqual({ status: "tooLarge", content: "", message: "" });
	});

	it("degrades other statuses and network errors to failed with a message", async () => {
		const load = makeLoad();
		const failing = (async () => jsonResponse({}, 500)) as unknown as typeof fetch;
		expect(await load(failing, ROOT, FILE)).toEqual({ status: "failed", content: "", message: "HTTP 500" });
		const throwing = (async () => {
			throw new Error("socket down");
		}) as unknown as typeof fetch;
		expect(await load(throwing, ROOT, FILE)).toEqual({ status: "failed", content: "", message: "socket down" });
	});
});
