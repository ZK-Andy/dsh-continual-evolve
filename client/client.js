/**
 * dsh-continual-evolve — client bundle for the official plugin manager card.
 *
 * Hand-written (no bundler: docs/coding-standard.md forbids a second one) in
 * the host loader's factory shape, verified against dshmarket's built
 * bundle: `window.__ModuleLoader__.load({ id, factory })`, where the factory
 * resolves host-provided modules through the passed `require` (here: only
 * react) and returns its `module.exports`. The host mounts the bundle via
 * package.json `dsh.client` + the `./client` export.
 *
 * The card registers one slot, `plugins.bundle.config` — the seat the 0.1.7+
 * plugin manager declares for a bundle's own page. Slot detection is the
 * compatibility contract: a host that never declares the slot never runs the
 * registration, so the card is silently absent while the memory section is
 * unaffected. The render function answers the host's `view === "summary"`
 * call with null (the bundle list row shows the package description; the
 * card is the page).
 *
 * The card is a read-only projection of the workspace memory store, fetched
 * at render time from this plugin's host routes (same-origin). No editor, no
 * write path, no cached state — refresh refetches everything.
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

		var createElement = react.createElement;
		var useState = react.useState;
		var useEffect = react.useEffect;

		var NS = "dsh-continual-evolve";
		var SLOT = "plugins.bundle.config";
		var API_ROOT = "/dsh-continual-evolve/api/v1";

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
				throw new Error("workspaces API answered HTTP " + listResponse.status);
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

		/** One workspace block: root, stats, drift warnings, per-file lines. */
		function WorkspaceBlock(props) {
			var entry = props.entry;
			var snapshot = entry.snapshot;
			var children = [
				createElement("div", { key: "root", style: { fontFamily: "monospace", wordBreak: "break-all" } }, entry.root),
			];
			if (entry.error !== null) {
				children.push(createElement("div", { key: "error" }, "读取失败：" + entry.error));
				return createElement("div", { style: { marginBottom: "12px" } }, children);
			}
			if (snapshot === null || !snapshot.exists) {
				children.push(createElement("div", { key: "absent" }, "该工作区尚无记忆库（开一次会话自动创建）。"));
				return createElement("div", { style: { marginBottom: "12px" } }, children);
			}
			if (snapshot.readError !== null) {
				children.push(createElement("div", { key: "readError" }, "记忆库读取失败：" + snapshot.readError));
				return createElement("div", { style: { marginBottom: "12px" } }, children);
			}
			children.push(
				createElement(
					"div",
					{ key: "stats" },
					snapshot.fileCount + " 条记忆 · 索引 " + snapshot.indexEntryCount + " 行",
				),
			);
			if (snapshot.missingFiles.length > 0) {
				children.push(
					createElement(
						"div",
						{ key: "missing" },
						"索引失联（索引引用但文件已删）：" + snapshot.missingFiles.join("、"),
					),
				);
			}
			if (snapshot.unindexedFiles.length > 0) {
				children.push(
					createElement(
						"div",
						{ key: "unindexed" },
						"未入索引（文件存在但索引没有行）：" + snapshot.unindexedFiles.join("、"),
					),
				);
			}
			children.push(
				createElement(
					"ul",
					{ key: "files", style: { margin: "4px 0 0", paddingLeft: "18px" } },
					snapshot.files.map(function (file) {
						return createElement(
							"li",
							{ key: file.file },
							createElement("strong", null, file.file) +
								(file.description !== "" ? " — " + file.description : ""),
						);
					}),
				),
			);
			return createElement("div", { style: { marginBottom: "12px" } }, children);
		}

		/** The card page: refresh control + one block per known workspace. */
		function MemoryCard() {
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
			var children = [
				createElement(
					"div",
					{ key: "head", style: { display: "flex", alignItems: "baseline", gap: "12px" } },
					createElement("strong", null, "工作区记忆（只读投影）"),
					createElement(
						"button",
						{
							type: "button",
							onClick: function () {
								setModel({ status: "loading", model: null, message: "" });
								reload(function (n) {
									return n + 1;
								});
							},
						},
						"刷新",
					),
				),
				createElement(
					"div",
					{ key: "hint" },
					"事实源是各工作区 .evolve/memory/ 下的 markdown 文件——模型原生读写；本卡片只展示，编辑请直接改文件。",
				),
			];
			if (model.status === "loading") {
				children.push(createElement("div", { key: "body" }, "读取中…"));
			} else if (model.status === "error") {
				children.push(createElement("div", { key: "body" }, "卡片数据加载失败：" + model.message));
			} else if (model.model.workspaces.length === 0) {
				children.push(
					createElement(
						"div",
						{ key: "body" },
						"本进程还没有服务过任何工作区会话——在某个工作区开一次会话后回来刷新。",
					),
				);
			} else {
				children.push(
					createElement(
						"div",
						{ key: "body" },
						model.model.workspaces.map(function (entry) {
							return createElement(WorkspaceBlock, { key: entry.root, entry: entry });
						}),
					),
				);
			}
			return createElement("div", null, children);
		}

		exports.name = NS;
		exports.inject = ["slots"];
		exports.loadCardModel = loadCardModel;
		exports.apply = function apply(ctx) {
			ctx.slots.inject(SLOT, function () {
				return ctx.slots.register(
					{
						name: SLOT,
						key: NS,
						inject: function () {
							return {};
						},
					},
					function (ownerProps) {
						return ownerProps && ownerProps.view === "summary" ? null : createElement(MemoryCard);
					},
				);
			});
		};
		return module.exports;
	},
});
