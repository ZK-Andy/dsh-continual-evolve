/**
 * dsh-continual-evolve — client bundle for the official plugin manager card.
 *
 * Hand-written (no bundler: docs/coding-standard.md forbids a second one) in
 * the host loader's factory shape, verified against dshmarket's built
 * bundle: `window.__ModuleLoader__.load({ id, factory })`, where the factory
 * resolves host-provided modules through the passed `require` (here: react
 * plus, optionally, the UI primitives) and returns its `module.exports`.
 * The host mounts the bundle via package.json `dsh.client` + the `./client`
 * export.
 *
 * The card registers one slot, `plugins.bundle.config` — the seat the 0.1.7+
 * plugin manager declares for a bundle's own page. Slot detection is the
 * compatibility contract: a host that never declares the slot never runs the
 * registration, so the card is silently absent while the memory section is
 * unaffected. The render function answers the host's `view === "summary"`
 * call with null (the bundle list row shows the package description; the
 * card is the page).
 *
 * Market parity (v0.13): locale/theme/primitives wiring copied from
 * dshmarket's client — `ctx.locale.register(NS, { zh, en })` + `bind`,
 * `var(--dsw-alias-*)` theme tokens, `Button` primitive for the refresh
 * control. Missing primitives/locale degrade to themed plain elements, so an
 * old host never blanks the settings dialog. The card stays a read-only
 * projection: fetched at render time from this plugin's host routes
 * (same-origin). No editor, no write path, no cached state.
 */
window.__ModuleLoader__.load({
	id: "dsh-continual-evolve",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		var react = undefined;
		try {
			react = require("react");
		} catch (error) {
			// Browser side: this runs before any cordis logger exporter exists,
			// so console is the only outlet (same escape hatch dshmarket uses).
			console.warn(
				"[dsh-continual-evolve] host react module unavailable — card disabled: " +
					(error instanceof Error ? error.message : String(error)),
			);
			return module.exports;
		}
		if (react === undefined || typeof react.createElement !== "function") {
			// A module table that resolves react to nothing is the same downgrade:
			// render would throw and blank the whole settings dialog (dshmarket #671 shape).
			console.warn("[dsh-continual-evolve] host react module has no createElement — card disabled");
			return module.exports;
		}

		var primitives = undefined;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (error) {
			// Old host without the primitives package: themed plain elements below.
			void error;
			primitives = undefined;
		}

		var createElement = react.createElement;
		var useState = react.useState;
		var useEffect = react.useEffect;

		var NS = "dsh-continual-evolve";
		var SLOT = "plugins.bundle.config";
		var API_ROOT = "/dsh-continual-evolve/api/v1";

		var zh = {
			title: "工作区记忆（只读投影）",
			refresh: "刷新",
			hint: "事实源是各工作区 .evolve/memory/ 下的 markdown 文件——模型原生读写；本卡片只展示，编辑请直接改文件。",
			loading: "读取中…",
			loadFailed: "卡片数据加载失败：",
			empty: "本进程还没有服务过任何工作区会话——在某个工作区开一次会话后回来刷新。",
			absent: "该工作区尚无记忆库（开一次会话自动创建）。",
			readFailed: "记忆库读取失败：",
			stats: "{files} 条记忆 · 索引 {index} 行",
			missing: "索引失联（索引引用但文件已删）：",
			unindexed: "未入索引（文件存在但索引没有行）：",
			readError: "读取失败：",
		};
		var en = {
			title: "Workspace memory (read-only)",
			refresh: "Refresh",
			hint: "The source of truth is the markdown files under each workspace's .evolve/memory/ — read and written by the model; this card only displays them, edit the files directly.",
			loading: "Loading…",
			loadFailed: "Failed to load card data: ",
			empty: "This process has not served any workspace session yet — open a session in a workspace, then come back and refresh.",
			absent: "No memory store in this workspace yet (one is created when you open a session).",
			readFailed: "Failed to read the memory store: ",
			stats: "{files} memories · {index} index rows",
			missing: "Dangling index (indexed but deleted): ",
			unindexed: "Unindexed (on disk, missing from the index): ",
			readError: "Read failed: ",
		};

		function format(template, params) {
			return String(template).replace(/\{(\w+)\}/g, function (match, key) {
				var value = params[key];
				return value === undefined || value === null ? match : String(value);
			});
		}

		/**
		 * Assemble the card's view model: the workspace allowlist, then one
		 * snapshot per workspace. Network or API failure per workspace degrades
		 * to an `error` string on that workspace's entry — one bad store never
		 * blanks the whole card.
		 *
		 * @param {typeof fetch} fetchImpl - injectable for tests.
		 * @returns {Promise<{workspaces: Array<object>}>}
		 */
		async function loadCardModel(fetchImpl) {
			var listResponse = await fetchImpl(API_ROOT + "/workspaces");
			if (!listResponse.ok) {
				throw new Error("HTTP " + listResponse.status);
			}
			var listBody = await listResponse.json();
			var workspaces = Array.isArray(listBody.workspaces) ? listBody.workspaces : [];
			var entries = await Promise.all(
				workspaces.map(async function (workspace) {
					var root = typeof workspace.root === "string" ? workspace.root : "";
					var lastSeen = typeof workspace.lastSeen === "string" ? workspace.lastSeen : "";
					try {
						var snapshotResponse = await fetchImpl(API_ROOT + "/memory?root=" + encodeURIComponent(root));
						if (!snapshotResponse.ok) {
							return { root: root, lastSeen: lastSeen, snapshot: null, error: "HTTP " + snapshotResponse.status };
						}
						return { root: root, lastSeen: lastSeen, snapshot: await snapshotResponse.json(), error: null };
					} catch (error) {
						return {
							root: root,
							lastSeen: lastSeen,
							snapshot: null,
							error: error instanceof Error ? error.message : String(error),
						};
					}
				}),
			);
			return { workspaces: entries };
		}

		var CARD_STYLE = {
			background: "var(--dsw-alias-bg-layer-1,#fff)",
			border: "1px solid var(--dsw-alias-border-l2,#e5e7eb)",
			borderRadius: "12px",
			padding: "12px 14px",
			display: "flex",
			flexDirection: "column",
			gap: "12px",
		};
		var TITLE_STYLE = {
			color: "var(--dsw-alias-label-primary,#1f2328)",
			fontSize: "15px",
			fontWeight: 600,
			lineHeight: "22px",
		};
		var HINT_STYLE = {
			color: "var(--dsw-alias-label-tertiary,#8b93a1)",
			fontSize: "12px",
			lineHeight: "18px",
		};
		var SECTION_STYLE = {
			borderTop: "1px solid var(--dsw-alias-border-l2,#f0f1f3)",
			paddingTop: "8px",
			display: "flex",
			flexDirection: "column",
			gap: "6px",
		};
		var ROOT_STYLE = {
			fontFamily: "ui-monospace,Menlo,monospace",
			fontSize: "11px",
			color: "var(--dsw-alias-label-secondary,#6b7280)",
			wordBreak: "break-all",
		};
		var STATS_STYLE = {
			fontSize: "12px",
			lineHeight: "18px",
			color: "var(--dsw-alias-label-secondary,#6b7280)",
		};
		var WARN_STYLE = {
			fontSize: "12px",
			lineHeight: "18px",
			color: "var(--dsw-alias-state-warn-primary,#b45309)",
		};
		var ERROR_STYLE = {
			fontSize: "12px",
			lineHeight: "18px",
			color: "var(--dsw-alias-state-error-primary,#dc2626)",
		};
		var LIST_STYLE = { margin: "4px 0 0", paddingLeft: "18px", fontSize: "12px", lineHeight: "18px" };
		var FALLBACK_BUTTON_STYLE = {
			background: "var(--dsw-alias-bg-layer-2,#f3f4f6)",
			color: "var(--dsw-alias-label-primary,#1f2328)",
			border: "1px solid var(--dsw-alias-border-l2,#e5e7eb)",
			borderRadius: "6px",
			padding: "3px 10px",
			fontSize: "12px",
			lineHeight: "18px",
			cursor: "pointer",
		};

		function RefreshButton(props) {
			var UI = props.UI;
			var t = props.t;
			var onClick = props.onClick;
			if (UI !== null && UI !== undefined && typeof UI.Button !== "undefined" && UI.Button !== null) {
				return createElement(
					UI.Button,
					{ variant: "outline", size: "sm", onClick: onClick },
					t("refresh"),
				);
			}
			return createElement("button", { type: "button", style: FALLBACK_BUTTON_STYLE, onClick: onClick }, t("refresh"));
		}

		/** One workspace block: root, stats, drift warnings, per-file lines. */
		function WorkspaceBlock(props) {
			var entry = props.entry;
			var t = props.t;
			if (entry.error !== null && entry.error !== undefined) {
				return createElement(
					"div",
					{ style: SECTION_STYLE },
					createElement("div", { style: ROOT_STYLE }, entry.root),
					createElement("div", { style: ERROR_STYLE }, t("readError") + entry.error),
				);
			}
			var snapshot = entry.snapshot;
			if (snapshot === null || snapshot === undefined || !snapshot.exists) {
				return createElement(
					"div",
					{ style: SECTION_STYLE },
					createElement("div", { style: ROOT_STYLE }, entry.root),
					createElement("div", { style: HINT_STYLE }, t("absent")),
				);
			}
			if (snapshot.readError !== null && snapshot.readError !== undefined) {
				return createElement(
					"div",
					{ style: SECTION_STYLE },
					createElement("div", { style: ROOT_STYLE }, entry.root),
					createElement("div", { style: ERROR_STYLE }, t("readFailed") + snapshot.readError),
				);
			}
			var children = [
				createElement("div", { key: "root", style: ROOT_STYLE }, entry.root),
				createElement(
					"div",
					{ key: "stats", style: STATS_STYLE },
					t("stats", { files: snapshot.fileCount, index: snapshot.indexEntryCount }),
				),
			];
			if (snapshot.missingFiles.length > 0) {
				children.push(
					createElement("div", { key: "missing", style: WARN_STYLE }, t("missing") + snapshot.missingFiles.join("、")),
				);
			}
			if (snapshot.unindexedFiles.length > 0) {
				children.push(
					createElement(
						"div",
						{ key: "unindexed", style: WARN_STYLE },
						t("unindexed") + snapshot.unindexedFiles.join("、"),
					),
				);
			}
			children.push(
				createElement(
					"ul",
					{ key: "files", style: LIST_STYLE },
					snapshot.files.map(function (file) {
						return createElement(
							"li",
							{ key: file.file },
							createElement("strong", null, file.file),
							file.description !== "" ? " — " + file.description : "",
						);
					}),
				),
			);
			return createElement("div", { style: SECTION_STYLE }, children);
		}

		/** The card page: refresh control + one block per known workspace. */
		function MemoryCard(props) {
			var t = props.t;
			var UI = props.UI;
			var state = useState({ status: "loading", model: null, message: "" });
			var model = state[0];
			var setModel = state[1];
			var reloadState = useState(0);
			var reload = reloadState[1];
			useEffect(
				function () {
					var alive = true;
					loadCardModel(fetch).then(
						function (data) {
							if (alive) setModel({ status: "ready", model: data, message: "" });
						},
						function (error) {
							if (alive) {
								setModel({ status: "error", model: null, message: error instanceof Error ? error.message : String(error) });
							}
						},
					);
					return function () {
						alive = false;
					};
				},
				[reloadState[0]],
			);
			var body = null;
			if (model.status === "loading") {
				body = createElement("div", { key: "body", style: HINT_STYLE }, t("loading"));
			} else if (model.status === "error") {
				body = createElement("div", { key: "body", style: ERROR_STYLE }, t("loadFailed") + model.message);
			} else if (model.model.workspaces.length === 0) {
				body = createElement("div", { key: "body", style: HINT_STYLE }, t("empty"));
			} else {
				body = createElement(
					"div",
					{ key: "body" },
					model.model.workspaces.map(function (entry) {
						return createElement(WorkspaceBlock, { key: entry.root, entry: entry, t: t, UI: UI });
					}),
				);
			}
			return createElement(
				"div",
				{ style: CARD_STYLE },
				createElement(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: "12px" } },
					createElement("div", { style: TITLE_STYLE }, t("title")),
					createElement("span", { style: { flex: 1 } }),
					createElement(RefreshButton, {
						UI: UI,
						t: t,
						onClick: function () {
							setModel({ status: "loading", model: null, message: "" });
							reload(function (n) {
								return n + 1;
							});
						},
					}),
				),
				createElement("div", { style: HINT_STYLE }, t("hint")),
				body,
			);
		}

		exports.name = NS;
		exports.inject = ["slots", "locale", "theme"];
		exports.loadCardModel = loadCardModel;
		exports.apply = function apply(ctx) {
			var tRaw = null;
			try {
				if (ctx.locale !== undefined && ctx.locale !== null) {
					var register = function () {
						return ctx.locale.register(NS, { zh: zh, en: en });
					};
					if (typeof ctx.effect === "function") {
						ctx.effect(register, "dsh-continual-evolve: dictionaries");
					} else if (typeof ctx.locale.register === "function") {
						register();
					}
					if (typeof ctx.locale.bind === "function") {
						tRaw = ctx.locale.bind(NS);
					}
				}
			} catch (error) {
				void error;
				tRaw = null;
			}
			var fallbackT = function (key, params) {
				var template = Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key;
				if (params !== undefined) {
					return format(template, params);
				}
				return template;
			};
			var t = fallbackT;
			if (typeof tRaw === "function") {
				t = function (key, params) {
					var rendered = null;
					try {
						rendered = tRaw(key);
					} catch (error) {
						void error;
						rendered = null;
					}
					if (typeof rendered !== "string") {
						return fallbackT(key, params);
					}
					if (params !== undefined) {
						return format(rendered, params);
					}
					return rendered;
				};
			}
			var UI = null;
			if (primitives !== undefined && primitives !== null && typeof primitives.Button !== "undefined") {
				UI = { Button: primitives.Button };
			}
			ctx.slots.inject(SLOT, function () {
				return ctx.slots.register(
					{
						name: SLOT,
						key: NS,
						locale: NS,
						inject: function () {
							return { t: typeof tRaw === "function" ? tRaw : fallbackT };
						},
					},
					function (ownerProps) {
						return ownerProps && ownerProps.view === "summary" ? null : createElement(MemoryCard, { t: t, UI: UI });
					},
				);
			});
		};
		return module.exports;
	},
});
