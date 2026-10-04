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
 * Card form (v0.14): the dshmarket SettingsCard shape, one for one — a
 * collapsed-by-default framed card whose header is the toggle button
 * (name + one-liner + rotating chevron), body rendered only when open, hover
 * and open states on the frame (see that bundle's "why the chrome is
 * hand-built" note: a flat, always-expanded box next to rows that collapse
 * reads as another product). The stylesheet is injected once, like the
 * host's own CSS-module tags.
 *
 * Content (v0.14, scope selector v0.15): aligned with ZCode's Settings → Memory
 * viewer, which the .evolve store shape was itself aligned with — one workspace
 * selected at a time behind a dropdown scope selector (workspaces come from the
 * host registry, so the selector lists the same workspaces the workspace picker
 * does), a file search box, per-file relative updated times, and a
 * click-to-preview body served by the host's content endpoint (5 MiB cap,
 * deleted/changed guards). The drift warnings (dangling index rows / unindexed
 * files) stay: they are this plugin's OBSERVATION surface and a deliberate
 * superset of ZCode's viewer.
 * Locale/theme/primitives wiring unchanged from v0.13: `ctx.locale.register`
 * + `bind`, `var(--dsw-alias-*)` tokens, primitives with plain-element
 * fallbacks so an old host never blanks the settings dialog. Read-only
 * projection, fetched at render time from this plugin's host routes
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
		var STYLE_ID = "dsh-continual-evolve-card-css";

		var zh = {
			title: "工作区记忆",
			desc: "各工作区 .evolve/memory/ 的只读投影。",
			refresh: "刷新",
			hint: "事实源是各工作区 .evolve/memory/ 下的 markdown 文件——模型原生读写；本卡片只展示，编辑请直接改文件。",
			loading: "读取中…",
			loadFailed: "卡片数据加载失败：",
			empty: "还没有任何工作区有记忆库——在某个工作区开一次会话后回来刷新。",
			absent: "该工作区尚无记忆库（开一次会话自动创建）。",
			readFailed: "记忆库读取失败：",
			stats: "{files} 条记忆 · 索引 {index} 行",
			filesHeading: "文件",
			scopeLabel: "选择工作区",
			searchPlaceholder: "搜索记忆文件…",
			searchEmpty: "没有匹配的记忆文件。",
			missing: "索引失联（索引引用但文件已删）：",
			unindexed: "未入索引（文件存在但索引没有行）：",
			readError: "读取失败：",
			previewLoading: "正在加载文件…",
			previewTooLarge: "该记忆文件超过 5 MiB 预览上限。",
			previewDeleted: "该记忆文件已被删除，请刷新文件列表。",
			previewFailed: "内容读取失败：",
			justNow: "刚刚",
			minutesAgo: "{count} 分钟前",
			today: "今天 {time}",
			yesterday: "昨天 {time}",
			localeTag: "zh-CN",
		};
		var en = {
			title: "Workspace Memory",
			desc: "Read-only projection of each workspace's .evolve/memory/.",
			refresh: "Refresh",
			hint: "The source of truth is the markdown files under each workspace's .evolve/memory/ — read and written by the model; this card only displays them, edit the files directly.",
			loading: "Loading…",
			loadFailed: "Failed to load card data: ",
			empty: "No workspace has a memory store yet — open a session in a workspace, then come back and refresh.",
			absent: "No memory store in this workspace yet (one is created when you open a session).",
			readFailed: "Failed to read the memory store: ",
			stats: "{files} memories · {index} index rows",
			filesHeading: "Files",
			scopeLabel: "Choose workspace",
			searchPlaceholder: "Search memory files…",
			searchEmpty: "No matching memory files.",
			missing: "Dangling index (indexed but deleted): ",
			unindexed: "Unindexed (on disk, missing from the index): ",
			readError: "Read failed: ",
			previewLoading: "Loading file…",
			previewTooLarge: "This memory file exceeds the 5 MiB preview limit.",
			previewDeleted: "This memory file has been deleted — refresh the file list.",
			previewFailed: "Failed to read the content: ",
			justNow: "Just now",
			minutesAgo: "{count} min ago",
			today: "Today {time}",
			yesterday: "Yesterday {time}",
			localeTag: "en-US",
		};

		function format(template, params) {
			return String(template).replace(/\{(\w+)\}/g, function (match, key) {
				var value = params[key];
				return value === undefined || value === null ? match : String(value);
			});
		}

		/**
		 * Relative updated time, ZCode viewer style: just now / N minutes ago /
		 * today / yesterday, then a calendar rendering via Intl in the active
		 * language (the `localeTag` dictionary key carries that language out).
		 */
		function formatRelative(updatedAt, now, t) {
			if (typeof updatedAt !== "number" || !isFinite(updatedAt) || updatedAt <= 0) {
				return "";
			}
			var minute = 60000;
			var diff = now - updatedAt;
			if (diff < minute) {
				return t("justNow");
			}
			if (diff < 60 * minute) {
				return t("minutesAgo", { count: Math.floor(diff / minute) });
			}
			var date = new Date(updatedAt);
			var time = new Intl.DateTimeFormat(t("localeTag"), { hour: "2-digit", minute: "2-digit" }).format(date);
			var startOfDay = new Date(now);
			startOfDay.setHours(0, 0, 0, 0);
			if (updatedAt >= startOfDay.getTime()) {
				return t("today", { time: time });
			}
			if (updatedAt >= startOfDay.getTime() - 24 * 60 * 60 * 1000) {
				return t("yesterday", { time: time });
			}
			var sameYear = date.getFullYear() === new Date(now).getFullYear();
			return new Intl.DateTimeFormat(t("localeTag"), {
				month: "numeric",
				day: "numeric",
				year: sameYear ? undefined : "numeric",
			}).format(date);
		}

		/**
		 * Assemble the card's view model: the workspace catalogue, then one
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
					var label =
						typeof workspace.label === "string" && workspace.label.trim().length > 0
							? workspace.label
							: workspaceLabel(root);
					try {
						var snapshotResponse = await fetchImpl(API_ROOT + "/memory?root=" + encodeURIComponent(root));
						if (!snapshotResponse.ok) {
							return { root: root, label: label, snapshot: null, error: "HTTP " + snapshotResponse.status };
						}
						return { root: root, label: label, snapshot: await snapshotResponse.json(), error: null };
					} catch (error) {
						return {
							root: root,
							label: label,
							snapshot: null,
							error: error instanceof Error ? error.message : String(error),
						};
					}
				}),
			);
			return { workspaces: entries };
		}

		/**
		 * Fetch one memory file's body for the preview. Outcomes mirror the
		 * endpoint's status mapping so the card can show the ZCode viewer's
		 * deleted / too-large / failed states instead of a raw error.
		 *
		 * @param {typeof fetch} fetchImpl - injectable for tests.
		 * @param {string} root - known workspace root.
		 * @param {string} file - plain .md file name inside that memory store.
		 * @returns {Promise<{status: "ready"|"deleted"|"tooLarge"|"failed", content: string, message: string}>}
		 */
		async function loadFileContent(fetchImpl, root, file) {
			var url = API_ROOT + "/memory/file?root=" + encodeURIComponent(root) + "&file=" + encodeURIComponent(file);
			try {
				var response = await fetchImpl(url);
				if (response.ok) {
					var body = await response.json();
					return {
						status: "ready",
						content: typeof body.content === "string" ? body.content : "",
						message: "",
					};
				}
				if (response.status === 404) {
					return { status: "deleted", content: "", message: "" };
				}
				if (response.status === 413) {
					return { status: "tooLarge", content: "", message: "" };
				}
				return { status: "failed", content: "", message: "HTTP " + response.status };
			} catch (error) {
				return {
					status: "failed",
					content: "",
					message: error instanceof Error ? error.message : String(error),
				};
			}
		}

		/** Display label for a workspace: its directory name (ZCode shows a project name, not a path). */
		function workspaceLabel(root) {
			var normalized = String(root).replace(/[\\/]+$/, "");
			var index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
			return index >= 0 ? normalized.slice(index + 1) : normalized;
		}

		/**
		 * Inject the card stylesheet once, the way the host's own CSS-module
		 * tags work. The classes are prefixed `dce-` and every value falls back
		 * to a fixed color after the token, so an old theme never blanks text.
		 */
		function injectCardStyle() {
			if (typeof document === "undefined") {
				return;
			}
			if (document.getElementById(STYLE_ID) !== null) {
				return;
			}
			var style = document.createElement("style");
			style.id = STYLE_ID;
			style.dataset.plugin = NS;
			style.textContent = [
				".dce-card{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-3,#fff);border-radius:12px;transition:border-color .16s,background .16s}",
				".dce-card:hover{border-color:var(--dsw-alias-label-dimmed,#c8ccd4)}",
				'.dce-card[data-open="true"]{background:var(--dsw-alias-bg-layer-2,#f7f8fa);border-color:var(--dsw-alias-label-dimmed,#c8ccd4)}',
				".dce-head{appearance:none;-webkit-appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
				".dce-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:-2px}",
				".dce-head-text{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
				".dce-name{color:var(--dsw-alias-label-primary,#1f2328);font-size:15px;font-weight:600;line-height:1.4}",
				".dce-desc{color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:13px;line-height:1.5}",
				".dce-chevron{color:var(--dsw-alias-label-tertiary,#8b93a1);flex:none;transition:transform .16s;display:inline-flex}",
				'.dce-chevron[data-open="true"]{transform:rotate(180deg)}',
				".dce-body{border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb);margin:0 16px;padding:12px 0 14px;display:flex;flex-direction:column;gap:10px}",
				".dce-hint{color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:12px;line-height:18px}",
				".dce-empty{border:1px dashed var(--dsw-alias-border-l3,#d1d9e0);border-radius:10px;padding:16px;text-align:center;color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:13px;line-height:20px}",
				".dce-scope-wrap{position:relative;display:inline-flex;min-width:0;max-width:100%;align-self:flex-start}",
				".dce-scope{display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;line-height:18px;cursor:pointer}",
				".dce-scope:hover{border-color:var(--dsw-alias-label-dimmed,#c8ccd4)}",
				".dce-scope:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:1px}",
				".dce-scope-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".dce-scope-caret{display:inline-flex;color:var(--dsw-alias-label-tertiary,#8b93a1)}",
				".dce-menu{position:absolute;top:calc(100% + 6px);left:0;z-index:20;min-width:240px;max-width:min(420px,80vw);max-height:320px;overflow:auto;padding:4px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 8px 24px rgba(0,0,0,.12)}",
				".dce-menu-item{display:flex;flex-direction:column;gap:2px;width:100%;padding:6px 10px;border:0;border-radius:8px;background:0 0;font:inherit;color:inherit;text-align:left;cursor:pointer}",
				".dce-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.03))}",
				'.dce-menu-item[data-active="true"]{background:var(--dsw-alias-bg-module-platform,#eef1f4)}',
				".dce-menu-label{color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".dce-menu-path{color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".dce-search{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l4,#d8dee4);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff);height:32px;color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;padding:0 10px;outline:none}",
				".dce-search::placeholder{color:var(--dsw-alias-label-tertiary,#8b93a1)}",
				".dce-search:focus-visible{border-color:var(--dsw-alias-brand-primary,#4f6ef7)}",
				".dce-files-head{display:flex;align-items:center;gap:10px;min-height:28px}",
				".dce-files-title{color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;font-weight:600;line-height:18px}",
				".dce-files-count{color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:12px;line-height:18px}",
				".dce-spacer{flex:1}",
				".dce-list{margin:0;padding:0;list-style:none;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff)}",
				".dce-item+.dce-item{border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb)}",
				".dce-row{display:flex;width:100%;align-items:center;gap:10px;padding:8px 12px;background:0 0;border:0;font:inherit;color:inherit;text-align:left;cursor:pointer}",
				".dce-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.03))}",
				".dce-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:-2px}",
				".dce-file-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;font-weight:500;line-height:18px}",
				".dce-file-time{flex:none;color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:11px;line-height:16px}",
				".dce-preview{margin:0;padding:8px 12px 10px;background:var(--dsw-alias-bg-module-platform,#eef1f4);border-top:1px solid var(--dsw-alias-border-l2,#e5e7eb)}",
				".dce-pre{margin:0;max-height:240px;overflow:auto;font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11px;line-height:17px;color:var(--dsw-alias-label-primary,#1f2328);white-space:pre-wrap;word-break:break-word}",
				".dce-workspace{display:flex;flex-direction:column;gap:10px}",
				".dce-stats{color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;line-height:18px}",
				".dce-warn{color:var(--dsw-alias-state-warn-primary,#b45309);font-size:12px;line-height:18px}",
				".dce-error{color:var(--dsw-alias-state-error-primary,#dc2626);font-size:12px;line-height:18px}",
				".dce-fallback-btn{background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-primary,#1f2328);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:6px;padding:3px 10px;font-size:12px;line-height:18px;cursor:pointer}",
			].join("\n");
			document.head.appendChild(style);
		}

		/** Chevron from the host primitives, or a plain glyph when they are absent. */
		function Chevron() {
			if (
				primitives !== undefined &&
				primitives !== null &&
				typeof primitives.IconChevronDownOutlineRegular !== "undefined" &&
				primitives.IconChevronDownOutlineRegular !== null
			) {
				return createElement(primitives.IconChevronDownOutlineRegular, { size: 14, "aria-hidden": "true" });
			}
			return createElement("span", { "aria-hidden": "true" }, "▾");
		}

		function RefreshButton(props) {
			var UI = props.UI;
			var t = props.t;
			var onClick = props.onClick;
			if (UI !== null && UI !== undefined && typeof UI.Button !== "undefined" && UI.Button !== null) {
				return createElement(UI.Button, { variant: "outline", size: "sm", onClick: onClick }, t("refresh"));
			}
			return createElement(
				"button",
				{ type: "button", className: "dce-fallback-btn", onClick: onClick },
				t("refresh"),
			);
		}

		/** One memory file row: name + relative updated time, click toggles the body preview. */
		function FileRow(props) {
			var file = props.file;
			var now = props.now;
			var t = props.t;
			var expanded = props.expanded;
			var preview = props.preview;
			var onToggle = props.onToggle;
			var rowChildren = [
				createElement("span", { key: "name", className: "dce-file-name" }, file.file),
			];
			var time = formatRelative(file.updatedAt, now, t);
			if (time !== "") {
				rowChildren.push(createElement("span", { key: "time", className: "dce-file-time" }, time));
			}
			var children = [
				createElement(
					"button",
					{
						key: "row",
						type: "button",
						className: "dce-row",
						"aria-expanded": expanded ? "true" : "false",
						onClick: onToggle,
					},
					rowChildren,
				),
			];
			if (expanded) {
				var body = null;
				if (preview === null || preview.file !== file.file) {
					body = createElement("div", { className: "dce-hint" }, t("previewLoading"));
				} else if (preview.status === "loading") {
					body = createElement("div", { className: "dce-hint" }, t("previewLoading"));
				} else if (preview.status === "ready") {
					body = createElement("pre", { className: "dce-pre" }, preview.content);
				} else if (preview.status === "deleted") {
					body = createElement("div", { className: "dce-hint" }, t("previewDeleted"));
				} else if (preview.status === "tooLarge") {
					body = createElement("div", { className: "dce-hint" }, t("previewTooLarge"));
				} else {
					body = createElement("div", { className: "dce-error" }, t("previewFailed") + preview.message);
				}
				children.push(createElement("div", { key: "preview", className: "dce-preview" }, body));
			}
			return createElement("li", { className: "dce-item" }, children);
		}

		/** Leading "switch scope" marker from the host primitives, or nothing. */
		function ScopeMark() {
			if (
				primitives !== undefined &&
				primitives !== null &&
				typeof primitives.IconChevronsUpDownOutlineRegular !== "undefined" &&
				primitives.IconChevronsUpDownOutlineRegular !== null
			) {
				return createElement(primitives.IconChevronsUpDownOutlineRegular, { size: 14, "aria-hidden": "true" });
			}
			return null;
		}

		/**
		 * The workspace scope selector, ZCode's Settings → Memory shape: one
		 * scope at a time behind a dropdown (leading marker + current workspace
		 * label + chevron), never a row of chips. A chip row can only render
		 * when several workspaces are known, so in the common single-workspace
		 * case it renders nothing at all and the capability reads as missing.
		 * The menu closes on select, on Escape and on a click outside.
		 */
		function WorkspaceScopeMenu(props) {
			var workspaces = props.workspaces;
			var selected = props.selected;
			var onSelect = props.onSelect;
			var t = props.t;
			var UI = props.UI;
			var openState = useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			useEffect(
				function () {
					if (!open || typeof document === "undefined") {
						return undefined;
					}
					var close = function () {
						setOpen(false);
					};
					var onKeyDown = function (event) {
						if (event.key === "Escape") {
							close();
						}
					};
					document.addEventListener("click", close);
					document.addEventListener("keydown", onKeyDown);
					return function () {
						document.removeEventListener("click", close);
						document.removeEventListener("keydown", onKeyDown);
					};
				},
				[open],
			);
			var current = null;
			for (var index = 0; index < workspaces.length; index++) {
				if (workspaces[index].root === selected) {
					current = workspaces[index];
					break;
				}
			}
			if (current === null && workspaces.length > 0) {
				current = workspaces[0];
			}
			var label = current === null ? "" : current.label || workspaceLabel(current.root);
			var scopeChildren = [
				createElement(ScopeMark, { key: "mark" }),
				createElement("span", { key: "label", className: "dce-scope-label" }, label),
				createElement("span", { key: "caret", className: "dce-scope-caret" }, createElement(Chevron, null)),
			];
			var triggerProps = {
				type: "button",
				"aria-haspopup": "menu",
				"aria-expanded": open ? "true" : "false",
				"aria-label": t("scopeLabel"),
				onClick: function () {
					setOpen(!open);
				},
			};
			var trigger = null;
			if (UI !== null && UI !== undefined && typeof UI.Button !== "undefined" && UI.Button !== null) {
				trigger = createElement(
					UI.Button,
					{
						key: "trigger",
						variant: "outline",
						size: "sm",
						type: triggerProps.type,
						"aria-haspopup": triggerProps["aria-haspopup"],
						"aria-expanded": triggerProps["aria-expanded"],
						"aria-label": triggerProps["aria-label"],
						onClick: triggerProps.onClick,
					},
					scopeChildren,
				);
			} else {
				trigger = createElement(
					"button",
					{
						key: "trigger",
						type: triggerProps.type,
						className: "dce-scope",
						"aria-haspopup": triggerProps["aria-haspopup"],
						"aria-expanded": triggerProps["aria-expanded"],
						"aria-label": triggerProps["aria-label"],
						onClick: triggerProps.onClick,
					},
					scopeChildren,
				);
			}
			var menu = null;
			if (open) {
				menu = createElement(
					"div",
					{ key: "menu", className: "dce-menu", role: "menu", "aria-label": t("scopeLabel") },
					workspaces.map(function (workspace) {
						return createElement(
							"button",
							{
								key: workspace.root,
								type: "button",
								role: "menuitemradio",
								"aria-checked": workspace.root === selected ? "true" : "false",
								className: "dce-menu-item",
								"data-active": workspace.root === selected ? "true" : "false",
								onClick: function () {
									setOpen(false);
									if (workspace.root !== selected) {
										onSelect(workspace.root);
									}
								},
							},
							// The registry allows duplicate titles, so the root
							// disambiguates two workspaces that read the same.
							createElement("span", { key: "label", className: "dce-menu-label" }, workspace.label || workspaceLabel(workspace.root)),
							createElement("span", { key: "root", className: "dce-menu-path" }, workspace.root),
						);
					}),
				);
			}
			return createElement("div", { key: "scope", className: "dce-scope-wrap" }, trigger, menu);
		}

		/** One workspace's memory store: stats, drift warnings, searchable file list with previews. */
		function WorkspaceBlock(props) {
			var entry = props.entry;
			var selected = props.selected;
			var onSelect = props.onSelect;
			var t = props.t;
			var UI = props.UI;
			var now = props.now;
			var expandedFile = props.expandedFile;
			var preview = props.preview;
			var onToggleFile = props.onToggleFile;
			var onRefresh = props.onRefresh;
			var query = props.query;
			var onQueryChange = props.onQueryChange;
			var scope = createElement(WorkspaceScopeMenu, {
				key: "scope",
				workspaces: entry.workspaces.map(function (workspace) {
					return { root: workspace.root, label: workspace.label };
				}),
				selected: selected,
				onSelect: onSelect,
				t: t,
				UI: UI,
			});
			var active = entry.workspaces.find(function (workspace) {
				return workspace.root === selected;
			});
			if (active === undefined) {
				return createElement("div", { key: "block", className: "dce-workspace" }, scope);
			}
			var body = null;
			if (active.error !== null && active.error !== undefined) {
				body = [
					createElement("div", { key: "root", className: "dce-stats" }, active.root),
					createElement("div", { key: "err", className: "dce-error" }, t("readError") + active.error),
				];
			} else if (active.snapshot === null || active.snapshot === undefined || !active.snapshot.exists) {
				body = createElement("div", { className: "dce-empty" }, t("absent"));
			} else if (active.snapshot.readError !== null && active.snapshot.readError !== undefined) {
				body = [
					createElement("div", { key: "root", className: "dce-stats" }, active.root),
					createElement("div", { key: "err", className: "dce-error" }, t("readFailed") + active.snapshot.readError),
				];
			} else {
				var snapshot = active.snapshot;
				var normalizedQuery = String(query).trim().toLocaleLowerCase();
				var files = snapshot.files.filter(function (file) {
					if (normalizedQuery.length === 0) {
						return true;
					}
					return [file.file, file.name, file.description, file.type]
						.filter(function (value) {
							return typeof value === "string";
						})
						.some(function (value) {
							return value.toLocaleLowerCase().includes(normalizedQuery);
						});
				});
				var parts = [
					createElement(
						"div",
						{ key: "stats", className: "dce-stats" },
						t("stats", { files: snapshot.fileCount, index: snapshot.indexEntryCount }),
					),
				];
				if (snapshot.missingFiles.length > 0) {
					parts.push(
						createElement("div", { key: "missing", className: "dce-warn" }, t("missing") + snapshot.missingFiles.join("、")),
					);
				}
				if (snapshot.unindexedFiles.length > 0) {
					parts.push(
						createElement(
							"div",
							{ key: "unindexed", className: "dce-warn" },
							t("unindexed") + snapshot.unindexedFiles.join("、"),
						),
					);
				}
				parts.push(
					createElement("input", {
						key: "search",
						type: "search",
						className: "dce-search",
						value: query,
						placeholder: t("searchPlaceholder"),
						"aria-label": t("searchPlaceholder"),
						onChange: function (event) {
							onQueryChange(event.currentTarget.value);
						},
					}),
				);
				parts.push(
					createElement(
						"div",
						{ key: "head", className: "dce-files-head" },
						createElement("span", { className: "dce-files-title" }, t("filesHeading")),
						createElement("span", { className: "dce-files-count" }, String(files.length)),
						createElement("span", { className: "dce-spacer" }),
						createElement(RefreshButton, {
							UI: UI,
							t: t,
							onClick: onRefresh,
						}),
					),
				);
				if (files.length === 0) {
					parts.push(createElement("div", { key: "none", className: "dce-empty" }, t("searchEmpty")));
				} else {
					parts.push(
						createElement(
							"ul",
							{ key: "files", className: "dce-list" },
							files.map(function (file) {
								return createElement(FileRow, {
									key: file.file,
									file: file,
									now: now,
									t: t,
									expanded: expandedFile === file.file,
									preview: preview,
									onToggle: function () {
										onToggleFile(file.file);
									},
								});
							}),
						),
					);
				}
				body = parts;
			}
			return createElement("div", { key: "block", className: "dce-workspace" }, scope, body);
		}

		/**
		 * The card: a collapsed-by-default framed disclosure (dshmarket
		 * SettingsCard shape) whose open body is the ZCode-memory-viewer-shaped
		 * read-only projection.
		 */
		function MemoryCard(props) {
			var t = props.t;
			var UI = props.UI;
			injectCardStyle();
			var openState = useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			var state = useState({ status: "loading", model: null, message: "" });
			var model = state[0];
			var setModel = state[1];
			var reloadState = useState(0);
			var reload = reloadState[1];
			var selectionState = useState({ root: null, query: "", expandedFile: null });
			var selection = selectionState[0];
			var setSelection = selectionState[1];
			var previewState = useState({ file: null, status: "loading", content: "", message: "" });
			var preview = previewState[0];
			var setPreview = previewState[1];
			var nowState = useState(Date.now());
			var now = nowState[0];
			var setNow = nowState[1];
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
			useEffect(
				function () {
					if (open) setNow(Date.now());
				},
				[open],
			);
			var refresh = function () {
				setModel({ status: "loading", model: null, message: "" });
				setSelection(function (current) {
					return { root: current.root, query: "", expandedFile: null };
				});
				setPreview({ file: null, status: "loading", content: "", message: "" });
				reload(function (n) {
					return n + 1;
				});
			};
			var header = createElement(
				"button",
				{
					type: "button",
					className: "dce-head",
					"aria-expanded": open ? "true" : "false",
					onClick: function () {
						setOpen(!open);
					},
				},
				createElement(
					"div",
					{ className: "dce-head-text" },
					createElement("div", { className: "dce-name" }, t("title")),
					createElement("div", { className: "dce-desc" }, t("desc")),
				),
				createElement(
					"span",
					{ className: "dce-chevron", "data-open": open ? "true" : "false" },
					createElement(Chevron, null),
				),
			);
			var body = null;
			if (!open) {
				return createElement("div", { className: "dce-card", "data-open": "false" }, header);
			}
			var inner = null;
			if (model.status === "loading") {
				inner = createElement("div", { key: "inner", className: "dce-hint" }, t("loading"));
			} else if (model.status === "error") {
				inner = createElement("div", { key: "inner", className: "dce-error" }, t("loadFailed") + model.message);
			} else if (model.model.workspaces.length === 0) {
				inner = createElement("div", { key: "inner", className: "dce-empty" }, t("empty"));
			} else {
				var selected = selection.root;
				if (
					selected === null ||
					!model.model.workspaces.some(function (workspace) {
						return workspace.root === selected;
					})
				) {
					selected = model.model.workspaces[0].root;
				}
				inner = createElement(WorkspaceBlock, {
					key: "inner",
					entry: model.model,
					selected: selected,
					onSelect: function (root) {
						setSelection({ root: root, query: "", expandedFile: null });
						setPreview({ file: null, status: "loading", content: "", message: "" });
					},
					onRefresh: refresh,
					t: t,
					UI: UI,
					now: now,
					expandedFile: selection.expandedFile,
					preview: preview,
					onToggleFile: function (file) {
						if (selection.expandedFile === file) {
							setSelection(function (current) {
								return { root: current.root, query: current.query, expandedFile: null };
							});
							return;
						}
						setSelection(function (current) {
							return { root: current.root, query: current.query, expandedFile: file };
						});
						setPreview({ file: file, status: "loading", content: "", message: "" });
						loadFileContent(fetch, selected, file).then(function (result) {
							setPreview(function (current) {
								if (current.file !== file) {
									return current;
								}
								return { file: file, status: result.status, content: result.content, message: result.message };
							});
						});
					},
					query: selection.query,
					onQueryChange: function (value) {
						setSelection(function (current) {
							return { root: current.root, query: value, expandedFile: current.expandedFile };
						});
					},
				});
			}
			body = createElement(
				"div",
				{ key: "body", className: "dce-body" },
				createElement("div", { className: "dce-hint" }, t("hint")),
				inner,
			);
			return createElement(
				"div",
				{ className: "dce-card", "data-open": "true" },
				header,
				body,
			);
		}

		exports.name = NS;
		exports.inject = ["slots", "locale", "theme"];
		exports.loadCardModel = loadCardModel;
		exports.loadFileContent = loadFileContent;
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
