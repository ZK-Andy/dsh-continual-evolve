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

/** Every element in the tree whose props carry this className. */
function findAllByClassName(node: unknown, className: string): ElementLike[] {
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
		if (element.props?.className === className) {
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
		expect(typeof exports.loadReviewSettings).toBe("function");
		expect(typeof exports.saveReviewSettings).toBe("function");
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
		expect(registered[0].dicts.zh.settingsTitle).toBe("评审设置");
		expect(registered[0].dicts.en.settingsTitle).toBe("Review settings");
		expect(boundNs).toBe("dsh-continual-evolve");
		expect(effects).toContain("dsh-continual-evolve: dictionaries");
	});

	it("degrades to themed plain elements when primitives and locale are absent", () => {
		const { exports } = loadBundle(makeReact());
		const { ctx, registrations } = makeCtx();
		(exports.apply as (ctx: unknown) => void)(ctx);
		expect(registrations).toHaveLength(1);
		// Loading state renders without throwing: fallback t + fallback button.
		const page = registrations[0].render({}) as { children: Array<{ props: { t: (key: string) => string } }> };
		const element = page.children[1];
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
		const page = registrations[0].render({}) as { type: string; props: Record<string, unknown>; children: unknown[] };
		// One entry, two stacked cards: the global settings card above the memory card.
		expect(page.type).toBe("div");
		expect(page.props.className).toBe("dce-page");
		expect(page.children).toHaveLength(2);
		const [settingsCard, memoryCard] = page.children as Array<{ type: (props: never) => unknown; props: Record<string, unknown> }>;
		expect(typeof settingsCard.type).toBe("function");
		expect((settingsCard.type as { name?: string }).name).toBe("SettingsCard");
		expect(typeof memoryCard.type).toBe("function");
		expect((memoryCard.type as { name?: string }).name).toBe("MemoryCard");
		expect(memoryCard.props.UI).toMatchObject({ Button: FakeButton });
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
		// The settings card shares the entry: same disclosure chrome, its own
		// global endpoint, hidden on 404 instead of erroring.
		expect(code).toContain("settingsTitle");
		expect(code).toContain("/review-settings");
		expect(code).toContain("unavailable");
		expect(code).toContain('className: "dce-page"');
		expect(code).toContain('className: "dce-setting"');
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
		// The settings switches ride the host Switch (dshmarket contract),
		// falling back to the themed checkbox on old hosts.
		expect(code).toContain("UI.Switch");
		expect(code).toContain("primitives.Switch");
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

describe("settings switch rows", () => {
	const SETTINGS = { enabled: true, dryRun: true, dailyBudget: 100, batchSize: 10, staleDays: 30 };
	const FORM = { enabled: true, dryRun: false, dailyBudget: "100", batchSize: "10", staleDays: "30" };

	/** Render the settings card with a preset open+ready hook state. */
	function renderSettingsForm(
		harness: ReturnType<typeof makeHookReact>,
		modules: Record<string, unknown>,
	): { settingsCard: ElementLike; harness: ReturnType<typeof makeHookReact> } {
		const { exports } = loadBundle(harness.react, modules);
		const { ctx, registrations } = makeCtx();
		(exports.apply as (ctx: unknown) => void)(ctx);
		const page = registrations[0].render({}) as ElementLike;
		const settingsCard = (page.children as ElementLike[])[0];
		harness.begin("settings");
		(settingsCard.type as (props: never) => unknown)(settingsCard.props as never);
		const setters = harness.setters;
		(setters[0] as (value: unknown) => void)(true);
		(setters[1] as (value: unknown) => void)({ status: "ready", settings: SETTINGS, message: "" });
		(setters[2] as (value: unknown) => void)({ ...FORM });
		harness.begin("settings");
		const rendered = (settingsCard.type as (props: never) => unknown)(settingsCard.props as never) as ElementLike;
		return { settingsCard: rendered, harness };
	}

	/** Every label.dce-setting row in the rendered form. */
	function settingRows(node: ElementLike): ElementLike[] {
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
			if (element.type === "label" && element.props?.className === "dce-setting") {
				found.push(element);
			}
			walk(element.children);
		};
		walk(node);
		return found;
	}

	it("passes UI through to the settings card", () => {
		const FakeButton = function FakeButton(): null {
			return null;
		};
		const FakeSwitch = function FakeSwitch(): null {
			return null;
		};
		const harness = makeHookReact();
		const { exports } = loadBundle(harness.react, {
			"@deepseek-ai/dsh-client-ui-primitives": { Button: FakeButton, Switch: FakeSwitch },
		});
		const { ctx, registrations } = makeCtx();
		(exports.apply as (ctx: unknown) => void)(ctx);
		const page = registrations[0].render({}) as ElementLike;
		const [settingsCard] = page.children as Array<{ props: Record<string, unknown> }>;
		expect(settingsCard.props.UI).toMatchObject({ Button: FakeButton, Switch: FakeSwitch });
	});

	it("renders the host Switch with the dshmarket contract when available", () => {
		const FakeButton = function FakeButton(): null {
			return null;
		};
		const FakeSwitch = function FakeSwitch(): null {
			return null;
		};
		const harness = makeHookReact();
		const { settingsCard } = renderSettingsForm(harness, {
			"@deepseek-ai/dsh-client-ui-primitives": { Button: FakeButton, Switch: FakeSwitch },
		});
		const rows = settingRows(settingsCard);
		const switches = rows
			.map((row) => (row.children as ElementLike[])[1])
			.filter((element) => element.type === FakeSwitch);
		expect(switches).toHaveLength(2);
		const props = switches.map((element) => element.props as Record<string, unknown>);
		expect(props.map((entry) => entry.checked)).toEqual([true, false]);
		expect(props.map((entry) => entry.disabled)).toEqual([false, false]);
		expect(typeof props[0].label).toBe("string");
		expect(typeof props[1].label).toBe("string");
		expect(props[0].label).not.toBe(props[1].label);
		// Toggling flips the form field through the row callback.
		(props[0].onChange as () => void)();
		const form = harness.states[2] as Record<string, unknown>;
		expect(form.enabled).toBe(false);
	});

	it("falls back to the themed checkbox when the host has no Switch", () => {
		const FakeButton = function FakeButton(): null {
			return null;
		};
		const harness = makeHookReact();
		const { settingsCard } = renderSettingsForm(harness, {
			"@deepseek-ai/dsh-client-ui-primitives": { Button: FakeButton },
		});
		const rows = settingRows(settingsCard);
		const boxes = rows
			.map((row) => (row.children as ElementLike[])[1])
			.filter((element) => element.type === "input" && element.props?.type === "checkbox");
		expect(boxes).toHaveLength(2);
		for (const element of boxes) {
			expect(element.type).toBe("input");
			expect(element.props?.type).toBe("checkbox");
			expect(element.props?.className).toBe("dce-check");
		}
		expect(boxes.map((element) => element.props?.checked)).toEqual([true, false]);
	});
});

describe("card refresh wiring", () => {
	// Hook order in the card: 0 open, 1 model, 2 reload counter, 3 selection, 4 preview, 5 now.
	it("wires the file-list refresh button to the card's own reload", () => {
		const harness = makeHookReact();
		const { exports } = loadBundle(harness.react);
		const { ctx, registrations } = makeCtx();
		(exports.apply as (ctx: unknown) => void)(ctx);
		const page = registrations[0].render({}) as ElementLike;
		// One entry, two stacked cards — drive the memory card below the global settings card.
		const card = (page.children?.[1] ?? page) as ElementLike;
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

/** Render the open card over the given workspace entries, down to the block. */
function renderBlockTree(
	harness: ReturnType<typeof makeHookReact>,
	entries: Array<Record<string, unknown>>,
	modules: Record<string, unknown> = {},
	defaultRoot: string | null = null,
): ElementLike {
	const { exports } = loadBundle(harness.react, modules);
	const { ctx, registrations } = makeCtx();
	(exports.apply as (ctx: unknown) => void)(ctx);
	const page = registrations[0].render({}) as ElementLike;
	// One entry, two stacked cards — drive the memory card below the global settings card.
	const card = (page.children?.[1] ?? page) as ElementLike;
	const render = (): ElementLike => {
		harness.begin();
		return (card.type as (props: unknown) => ElementLike)(card.props);
	};
	render();
	harness.setters[0](true);
	harness.setters[1]({ status: "ready", model: { workspaces: entries, defaultRoot: defaultRoot }, message: "" });
	const tree = render();
	// The scope menu lives inside the block component, one level below the
	// element tree; render that level explicitly.
	const block = findAllByName(tree, "WorkspaceBlock")[0] as ElementLike;
	harness.begin("block");
	return (block.type as (props: unknown) => ElementLike)(block.props);
}

describe("workspace scope selector", () => {
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

	it("opens on the server's default workspace instead of the first row", () => {
		const harness = makeHookReact();
		const tree = renderBlockTree(
			harness,
			[
				{ root: "/ws/a", label: "A", snapshot: null, error: null },
				{ root: "/ws/b", label: "B", snapshot: null, error: null },
			],
			{},
			"/ws/b",
		);
		expect(findAllByName(tree, "WorkspaceScopeMenu")[0].props?.selected).toBe("/ws/b");
		// A hand-picked workspace still outranks the default afterwards.
		const openTree = renderMenu(harness, tree, true);
		const options = findAllByRole(openTree, "menuitemradio");
		expect(options.map((option) => option.props?.["aria-checked"])).toEqual(["false", "true"]);
		const back = options[0].props?.onClick as (() => void) | undefined;
		expect(typeof back).toBe("function");
		(back as () => void)();
		harness.begin();
		expect(harness.states[3]).toMatchObject({ root: "/ws/a" });
	});

	it("ignores a default workspace the list does not contain", () => {
		const harness = makeHookReact();
		const tree = renderBlockTree(
			harness,
			[
				{ root: "/ws/a", label: "A", snapshot: null, error: null },
				{ root: "/ws/b", label: "B", snapshot: null, error: null },
			],
			{},
			"/ws/gone",
		);
		expect(findAllByName(tree, "WorkspaceScopeMenu")[0].props?.selected).toBe("/ws/a");
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

describe("memory row badges", () => {
	/** A snapshot with one local row, one promoted (global) row, and a global quarantine. */
	function snapshotWithScopes(): Record<string, unknown> {
		return {
			exists: true,
			fileCount: 2,
			files: [
				{ id: "local", title: "local", description: "", type: "user", status: "active", scope: "project", updatedAt: Date.now(), suggestExport: false },
				{ id: "person", title: "person", description: "", type: "user", status: "active", scope: "global", updatedAt: Date.now(), suggestExport: true },
			],
			quarantined: [{ id: "leak", scope: "global", reason: "x" }],
			lastPatrol: null,
			readError: null,
		};
	}

	it("marks the global row and folds the export advice into the same badge", () => {
		const harness = makeHookReact();
		const tree = renderBlockTree(harness, [{ root: "/ws/a", label: "A", snapshot: snapshotWithScopes(), error: null }]);
		const rows = findAllByName(tree, "FileRow");
		expect(rows.map((row) => row.props?.badge)).toEqual(["", "全局 · 建议入仓文档"]);
	});

	it("tags a quarantined global row in the patrol line", () => {
		const harness = makeHookReact();
		const tree = renderBlockTree(harness, [{ root: "/ws/a", label: "A", snapshot: snapshotWithScopes(), error: null }]);
		const warn = findAllByClassName(tree, "dce-warn")[0] as ElementLike;
		const text = (warn.children as unknown[])[0];
		expect(String(text)).toContain("leak · 全局");
	});
});

describe("injection readings (P1)", () => {
	function snapshotWithInjection(injection: Record<string, unknown>, fileCount = 20): Record<string, unknown> {
		return {
			exists: true,
			fileCount,
			files: [
				{ id: "a", title: "a", description: "", type: "user", status: "active", scope: "project", updatedAt: Date.now(), suggestExport: false },
			],
			quarantined: [],
			lastPatrol: null,
			readError: null,
			build: null,
			injection,
		};
	}

	function statsLines(tree: ElementLike): string[] {
		return findAllByClassName(tree, "dce-stats").map((el) => String((el.children as unknown[])[0]));
	}

	function renderInjection(injection: Record<string, unknown>): string[] {
		const harness = makeHookReact();
		const tree = renderBlockTree(harness, [
			{ root: "/ws/a", label: "A", snapshot: snapshotWithInjection(injection), error: null },
		]);
		return statsLines(tree);
	}

	it("renders index recall N/M plus text reads, with the rate at enough sessions", () => {
		const lines = renderInjection({
			days: 7, sessions: 12, injected: 14, read: 3, readThrough: 0.25, rate: 0.25, latestInjected: 5, tokens: 100,
		});
		expect(lines.some((line) => line.includes("索引召回 5/20"))).toBe(true);
		expect(lines.some((line) => line.includes("正文取回 3"))).toBe(true);
		expect(lines.some((line) => line.includes("25%"))).toBe(true);
	});

	it("hides the rate below ten sessions (P1 sample guard)", () => {
		const lines = renderInjection({
			days: 7, sessions: 3, injected: 4, read: 1, readThrough: 0.25, rate: 0.25, latestInjected: 2, tokens: 10,
		});
		expect(lines.some((line) => line.includes("索引召回 2/20"))).toBe(true);
		expect(lines.some((line) => line.includes("样本不足"))).toBe(true);
		expect(lines.every((line) => !line.includes("%"))).toBe(true);
	});

	it("hides the line when nothing was injected", () => {
		const lines = renderInjection({
			days: 7, sessions: 0, injected: 0, read: 0, readThrough: 0, rate: 0, latestInjected: 0, tokens: 0,
		});
		expect(lines.some((line) => line.includes("索引召回"))).toBe(false);
	});

	it("ships both templates in zh and en dictionaries", () => {
		const registered: Array<{ ns: string; dicts: Record<string, Record<string, string>> }> = [];
		const locale = {
			register: (ns: string, dicts: Record<string, Record<string, string>>) => {
				registered.push({ ns, dicts });
				return () => undefined;
			},
			bind: (_ns: string) => (key: string) => `en:${key}`,
		};
		const { exports } = loadBundle(makeReact());
		const { ctx } = makeCtx(locale);
		(exports.apply as (ctx: unknown) => void)(ctx);
		const { zh, en } = registered[0].dicts;
		expect(zh.injectionLine).toContain("索引召回");
		expect(zh.injectionLineSmall).toContain("样本不足");
		expect(en.injectionLine).toContain("index recall");
		expect(en.injectionLineSmall).toContain("too few sessions");
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

	it("carries the server's default workspace through, and null when absent", async () => {
		const { exports } = loadBundle(makeReact());
		const loadCardModel = exports.loadCardModel as (fetchImpl: typeof fetch) => Promise<{ defaultRoot: unknown }>;
		const withHint = (async (url: string | URL) => {
			if (String(url).endsWith("/workspaces")) {
				return jsonResponse({ workspaces: [{ root: "/ws/a", label: "A" }], defaultRoot: "/ws/b" });
			}
			return jsonResponse({ root: "/ws/a", exists: true, fileCount: 0 });
		}) as unknown as typeof fetch;
		expect((await loadCardModel(withHint)).defaultRoot).toBe("/ws/b");
		const withoutHint = (async (url: string | URL) => {
			if (String(url).endsWith("/workspaces")) {
				return jsonResponse({ workspaces: [{ root: "/ws/a", label: "A" }] });
			}
			return jsonResponse({ root: "/ws/a", exists: true, fileCount: 0 });
		}) as unknown as typeof fetch;
		expect((await loadCardModel(withoutHint)).defaultRoot).toBeNull();
	});

	it("degrades a failing workspace snapshot to an error entry", async () => {		const { exports } = loadBundle(makeReact());
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

describe("loadCardModel skills", () => {
	it("fetches one skill snapshot per workspace alongside the memory snapshot", async () => {
		const { exports } = loadBundle(makeReact());
		const loadCardModel = exports.loadCardModel as (fetchImpl: typeof fetch) => Promise<{
			workspaces: Array<{ root: string; skillSnapshot: { exists: boolean } | null; skillError: string | null }>;
		}>;
		const calls: string[] = [];
		const fetchImpl = (async (url: string | URL) => {
			calls.push(String(url));
			if (String(url).endsWith("/workspaces")) {
				return jsonResponse({ workspaces: [{ root: "/ws/a", label: "A" }] });
			}
			if (String(url).includes("/skills?root=")) {
				return jsonResponse({ root: "/ws/a", exists: true, fileCount: 1 });
			}
			return jsonResponse({ root: "/ws/a", exists: true, fileCount: 2 });
		}) as unknown as typeof fetch;
		const model = await loadCardModel(fetchImpl);
		expect(model.workspaces[0].skillSnapshot).toMatchObject({ exists: true });
		expect(model.workspaces[0].skillError).toBeNull();
		expect(calls.some((url) => url.includes("/skills?root=" + encodeURIComponent("/ws/a")))).toBe(true);
	});

	it("degrades a failing skill snapshot without failing the workspace entry", async () => {
		const { exports } = loadBundle(makeReact());
		const loadCardModel = exports.loadCardModel as (fetchImpl: typeof fetch) => Promise<{
			workspaces: Array<{ root: string; snapshot: unknown; error: string | null; skillSnapshot: unknown; skillError: string | null }>;
		}>;
		const fetchImpl = (async (url: string | URL) => {
			if (String(url).endsWith("/workspaces")) {
				return jsonResponse({ workspaces: [{ root: "/ws/a", label: "A" }] });
			}
			if (String(url).includes("/skills?root=")) {
				return jsonResponse({ error: "unknown workspace root" }, 404);
			}
			return jsonResponse({ root: "/ws/a", exists: true, fileCount: 0 });
		}) as unknown as typeof fetch;
		const model = await loadCardModel(fetchImpl);
		expect(model.workspaces[0].error).toBeNull();
		expect(model.workspaces[0].snapshot).toMatchObject({ exists: true });
		expect(model.workspaces[0].skillSnapshot).toBeNull();
		expect(model.workspaces[0].skillError).toBe("HTTP 404");
	});
});

describe("loadSkillContent", () => {
	const ROOT = "/ws/a";
	const ID = "deploy";

	function makeLoad(): (fetchImpl: typeof fetch, root: string, id: string) => Promise<unknown> {
		const { exports } = loadBundle(makeReact());
		return exports.loadSkillContent as (fetchImpl: typeof fetch, root: string, id: string) => Promise<unknown>;
	}

	it("requests the skill content endpoint and returns the body", async () => {
		const calls: string[] = [];
		const load = makeLoad();
		const fetchImpl = (async (url: string | URL) => {
			calls.push(String(url));
			return jsonResponse({ id: ID, scope: "project", content: "技能正文" });
		}) as unknown as typeof fetch;
		expect(await load(fetchImpl, ROOT, ID)).toEqual({ status: "ready", content: "技能正文", message: "" });
		expect(calls[0]).toContain("/skills/file?root=" + encodeURIComponent(ROOT) + "&id=" + encodeURIComponent(ID));
	});

	it("maps 404 to deleted, 413 to tooLarge, and the rest to failed", async () => {
		const load = makeLoad();
		let status = 404;
		const fetchImpl = (async () => jsonResponse({ error: "x" }, status)) as unknown as typeof fetch;
		expect(await load(fetchImpl, ROOT, ID)).toEqual({ status: "deleted", content: "", message: "" });
		status = 413;
		expect(await load(fetchImpl, ROOT, ID)).toEqual({ status: "tooLarge", content: "", message: "" });
		status = 500;
		expect(await load(fetchImpl, ROOT, ID)).toEqual({ status: "failed", content: "", message: "HTTP 500" });
	});
});

describe("review settings helpers", () => {
	const SETTINGS = { enabled: true, dryRun: true, dailyBudget: 100, batchSize: 10, staleDays: 30 };

	it("loads the global snapshot and hides the card on 404", async () => {
		const { exports } = loadBundle(makeReact());
		const load = exports.loadReviewSettings as (fetchImpl: typeof fetch) => Promise<unknown>;
		const ok = (async (url: string | URL) => {
			expect(String(url).endsWith("/review-settings")).toBe(true);
			return jsonResponse(SETTINGS);
		}) as unknown as typeof fetch;
		expect(await load(ok)).toEqual({ status: "ready", settings: SETTINGS, message: "" });
		const missing = (async () => jsonResponse({ error: "x" }, 404)) as unknown as typeof fetch;
		expect(await load(missing)).toEqual({ status: "unavailable", settings: null, message: "" });
		const down = (async () => {
			throw new Error("socket down");
		}) as unknown as typeof fetch;
		expect(await load(down)).toEqual({ status: "failed", settings: null, message: "socket down" });
	});

	it("posts a patch as JSON and surfaces server errors", async () => {
		const { exports } = loadBundle(makeReact());
		const save = exports.saveReviewSettings as (fetchImpl: typeof fetch, patch: unknown) => Promise<unknown>;
		const calls: Array<{ url: unknown; init: { body: string } }> = [];
		const ok = (async (url: unknown, init: { body: string }) => {
			calls.push({ url, init });
			return jsonResponse({ ...SETTINGS, dryRun: false });
		}) as unknown as typeof fetch;
		expect(await save(ok, { dryRun: false })).toEqual({
			status: "ready",
			settings: { ...SETTINGS, dryRun: false },
			message: "",
		});
		expect(String(calls[0].url).endsWith("/review-settings")).toBe(true);
		expect(JSON.parse(calls[0].init.body)).toEqual({ dryRun: false });
		const rejected = (async () => ({
			ok: false,
			status: 400,
			json: async () => ({ error: 'field "batchSize" must be an integer >= 1' }),
		})) as unknown as typeof fetch;
		expect(await save(rejected, { batchSize: 0 })).toEqual({
			status: "failed",
			settings: null,
			message: 'field "batchSize" must be an integer >= 1',
		});
	});
});

describe("settings form helpers", () => {
	const SETTINGS = { enabled: true, dryRun: true, dailyBudget: 100, batchSize: 10, staleDays: 30 };

	it("converts a snapshot to an editable form and detects dirtiness", async () => {
		const { exports } = loadBundle(makeReact());
		const toForm = exports.settingsFormOf as (settings: typeof SETTINGS) => Record<string, unknown>;
		const isDirty = exports.isSettingsDirty as (form: Record<string, unknown>, saved: typeof SETTINGS) => boolean;
		const form = toForm(SETTINGS);
		expect(form).toEqual({ enabled: true, dryRun: true, dailyBudget: "100", batchSize: "10", staleDays: "30" });
		expect(isDirty(form, SETTINGS)).toBe(false);
		expect(isDirty({ ...form, dryRun: false }, SETTINGS)).toBe(true);
		expect(isDirty({ ...form, batchSize: "0" }, SETTINGS)).toBe(true);
	});

	it("validates the form into a POST patch", async () => {
		const { exports } = loadBundle(makeReact());
		const validate = exports.validateSettingsForm as (form: Record<string, unknown>) => { ok: boolean; patch?: unknown };
		const toForm = exports.settingsFormOf as (settings: typeof SETTINGS) => Record<string, unknown>;
		const good = validate(toForm(SETTINGS));
		expect(good).toEqual({ ok: true, patch: SETTINGS });
		expect(validate({ ...toForm(SETTINGS), batchSize: "0" }).ok).toBe(false);
		expect(validate({ ...toForm(SETTINGS), dailyBudget: "1.5" }).ok).toBe(false);
		expect(validate({ ...toForm(SETTINGS), staleDays: "-1" }).ok).toBe(false);
	});
});

describe("workspace selection and query helpers", () => {
	it("prefers the selected workspace, then the server hint, then the first row", async () => {
		const { exports } = loadBundle(makeReact());
		const resolveSelected = exports.resolveSelectedWorkspace as (
			model: { workspaces: Array<{ root: string }>; defaultRoot: string | null },
			root: string | null,
		) => string;
		const model = { workspaces: [{ root: "/ws/a" }, { root: "/ws/b" }], defaultRoot: "/ws/b" };
		expect(resolveSelected(model, "/ws/a")).toBe("/ws/a");
		expect(resolveSelected(model, null)).toBe("/ws/b");
		expect(resolveSelected(model, "/ws/gone")).toBe("/ws/b");
		expect(resolveSelected({ workspaces: [{ root: "/ws/a" }], defaultRoot: null }, null)).toBe("/ws/a");
	});

	it("resolves the scope label target the same way", async () => {
		const { exports } = loadBundle(makeReact());
		const resolveCurrent = exports.resolveScopeCurrent as (
			workspaces: Array<{ root: string }>,
			selected: string | null,
		) => { root: string } | null;
		expect(resolveCurrent([{ root: "/ws/a" }], "/ws/a")).toEqual({ root: "/ws/a" });
		expect(resolveCurrent([], null)).toBeNull();
	});

	it("matches rows case-insensitively over text fields only", async () => {
		const { exports } = loadBundle(makeReact());
		const match = exports.matchQueryFields as (row: Record<string, unknown>, fields: string[], query: string) => boolean;
		const row = { id: "Fedora", title: "桌面环境", count: 3 };
		expect(match(row, ["id", "title"], "")).toBe(true);
		expect(match(row, ["id", "title"], "fed")).toBe(true);
		expect(match(row, ["id", "title"], "桌面")).toBe(true);
		expect(match(row, ["id", "title"], "missing")).toBe(false);
		expect(match(row, ["count"], "3")).toBe(false);
	});
});
