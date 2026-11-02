/**
 * dsh-plugin-update-checker — Browser half.
 *
 * Registers a "Check updates" tab into the Built-in plugins settings section
 * (`settings.plugins.tab`), sitting beside the read-only inventory. The tab
 * shows the running DSH runtime version, a prominent "Check updates" button,
 * and — after the check — one row per installed plugin bundle reporting both:
 *
 *   - compatibility with the current DSH runtime (peer-dependency verdict), and
 *   - update availability (published registry version vs the installed one).
 *
 * It calls only the host routes this package ships
 * (`/api/plugin-update-checker/scan` and `/api/plugin-update-checker/update`);
 * it renders no local transport. A failed per-bundle lookup is shown as a
 * row-level warning rather than blanking the report.
 *
 * Bundle id MUST equal package.json `name` (the dsh-client-modules Loader row
 * resolver matches the registered module id to the package name).
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-update-checker",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		//#region dictionaries
		const NS = "pluginUpdateChecker";
		const zh = {
			"tab": "检查更新",
			"title": "插件更新与兼容性检查",
			"intro": "一键检查所有已安装插件的最新版本，以及它们与当前 DSH 运行时的兼容性。",
			"dshVersion": "当前 DSH 版本",
			"check": "检查更新",
			"checking": "检查中…",
			"lastChecked": "上次检查",
			"never": "尚未检查",
			"error": "检查失败",
			"retry": "重试",
			"noPlugins": "没有检测到任何已安装的插件包。",
			"col.plugin": "插件",
			"col.installed": "已安装版本",
			"col.latest": "最新版本",
			"col.compat": "兼容性",
			"col.update": "更新",
			"compat.compatible": "兼容",
			"compat.incompatible": "不兼容",
			"compat.unknown": "未知",
			"update.upToDate": "已是最新",
			"update.updateAvailable": "有更新",
			"update.appManaged": "由 App 更新",
			"update.unknown": "未知",
			"update.unsupported": "不受支持",
			"update.partOfRuntime": "运行时的一部分",
			"update.error": "无法检查",
			"compat.peers": "不兼容的 peer 依赖",
			"exempted": "已豁免",
			"updateBtn": "更新",
			"updating": "更新中…",
			"updated": "已更新",
			"updateFailed": "更新失败",
			"update.selfUpdate": "不能在这里更新它：桌面端更新要先卸载已装版本，而卸载会把正在执行这次更新的面板一起卸载。请退出应用后在终端执行",
			"update.unchanged": "插件管理器没有改动 profile，版本仍停留在原处。请手动安装",
			"update.removedThenFailed": "旧版本已卸载，但新版本没有装上。请用下面的命令恢复",
			"update.noManager": "这个宿主没有提供插件管理器服务，请用终端安装",
			"update.failedUnknown": "插件管理器没有说明失败原因",
			"update.code.notRemovable": "桌面端不允许卸载这个插件",
			"update.code.bundleInUse": "这个插件正在被使用，桌面端不允许现在卸载",
			"update.code.stopProfile": "卸载这个插件需要先停止当前 profile",
			"update.code.incompatible": "这个版本与当前 DSH 运行时不兼容，宿主拒绝安装",
			"linked": "源码链接（请从源码更新）",
			"linkedHint": "该插件以源码软链方式安装，无法一键更新；请到源码目录拉取最新代码后重启 DSH。",
			"sourceLink": "前往源码仓库",
			"runtimeName": "DSH 运行时",
			"runtimeUpdateAvailable": "有可用更新（通过 DSH 自带更新器升级）",
			"runtimeUpdateHint": "DSH 运行时由应用自带的更新器管理，无法在此一键更新。请在菜单中检查更新，或重新启动应用以应用更新。",
			"runtimeUpdateHintNpm": "DSH 运行时通过 npm 安装更新：`npm install -g @deepseek-ai/dsh@{version}`，然后重启 DSH。",
			"sourcePath": "源码路径",
			"restartRequired": "已更新，需重启 DSH 生效",
			"manualRestart": "请手动重启：先停止 3080 端口上的 DSH 进程，再运行 `dsh restart` 或重新启动 DSH（也可在终端执行 `dsh stop && dsh restart`）。重启后更新才会生效。",
			"summary": "共 {total} 个插件：{incompatible} 个不兼容，{available} 个有可用更新。"
		};
		const en = {
			"tab": "Check updates",
			"title": "Plugin update & compatibility check",
			"intro": "Check every installed plugin for the latest published version and its compatibility with the running DSH runtime in one click.",
			"dshVersion": "Running DSH version",
			"check": "Check updates",
			"checking": "Checking…",
			"lastChecked": "Last checked",
			"never": "Not checked yet",
			"error": "Check failed",
			"retry": "Retry",
			"noPlugins": "No installed plugin bundles detected.",
			"col.plugin": "Plugin",
			"col.installed": "Installed",
			"col.latest": "Latest",
			"col.compat": "Compatibility",
			"col.update": "Update",
			"compat.compatible": "Compatible",
			"compat.incompatible": "Incompatible",
			"compat.unknown": "Unknown",
			"update.upToDate": "Up to date",
			"update.updateAvailable": "Update available",
			"update.appManaged": "Updated by the app",
			"update.unknown": "Unknown",
			"update.unsupported": "Unsupported",
			"update.partOfRuntime": "Part of the runtime",
			"update.error": "Cannot check",
			"compat.peers": "Incompatible peer dependencies",
			"exempted": "Exempted",
			"updateBtn": "Update",
			"updating": "Updating…",
			"updated": "Updated",
			"updateFailed": "Update failed",
			"update.selfUpdate": "This one cannot update itself here: the desktop app updates by removing the installed copy first, and removing it would also unload the panel running this update. Quit the app and run",
			"update.unchanged": "the plugin manager changed nothing, so the version stayed where it was. Install it by hand with",
			"update.removedThenFailed": "the old version is removed but the new one did not install. Restore it with",
			"update.noManager": "this host exposes no plugin manager; install from a terminal with",
			"update.failedUnknown": "the plugin manager did not explain the failure",
			"update.code.notRemovable": "the desktop app does not allow removing this plugin",
			"update.code.bundleInUse": "the plugin is in use, so the desktop app will not remove it now",
			"update.code.stopProfile": "removing it requires stopping the current profile first",
			"update.code.incompatible": "this version is incompatible with the running DSH, so the host refused it",
			"linked": "Source-linked (update from source)",
			"linkedHint": "This plugin is installed as a source symlink and cannot be updated in one click. Pull the latest from its source repo, then restart DSH.",
			"sourceLink": "Open source repository",
			"runtimeName": "DSH runtime",
			"runtimeUpdateAvailable": "Update available (upgrade via the app's own updater)",
			"runtimeUpdateHint": "The DSH runtime is managed by the app's built-in updater and cannot be updated here. Check for updates from the menu, or restart the app to apply an update.",
			"runtimeUpdateHintNpm": "The DSH runtime is updated through npm: `npm install -g @deepseek-ai/dsh@{version}`, then restart DSH.",
			"sourcePath": "Source path",
			"restartRequired": "Updated — restart DSH to apply",
			"manualRestart": "Restart DSH manually: stop the DSH process on port 3080, then run `dsh restart` (or `dsh stop && dsh restart`) from a terminal. The update takes effect only after the restart.",
			"summary": "{total} plugins: {incompatible} incompatible, {available} with an update available."
		};
		//#endregion

		const COLORS = {
			primary: "var(--dsw-alias-state-business-primary)",
			error: "var(--dsw-alias-state-error-primary)",
			warning: "var(--dsw-alias-state-warning-primary, #c9851f)",
			ok: "var(--dsw-alias-state-success-primary, #1f9d55)",
			label: "var(--dsw-alias-label-primary)",
			tertiary: "var(--dsw-alias-label-tertiary)",
			border: "var(--dsw-alias-border-l4)",
			bg: "var(--dsw-alias-bg-layer-1)",
			// Referenced by the source-repository link. It used to be missing, so
			// the literal fallback fired on every render and the link ignored the
			// theme; declare the token so the link follows the palette.
			link: "var(--dsw-alias-label-primary-bluish, #3b82f6)"
		};

		function badge(text, color) {
			return react_jsx_runtime.jsx("span", {
				style: {
					display: "inline-flex",
					alignItems: "center",
					height: 18,
					padding: "0 7px",
					fontSize: 10,
					fontWeight: 600,
					lineHeight: 1,
					borderRadius: "var(--dsw-radius-sm)",
					color: color,
					background: "color-mix(in srgb, " + color + " 14%, transparent)",
					whiteSpace: "nowrap"
				},
				children: text
			});
		}

		function compatBadge(compat, t) {
			if (compat.status === "incompatible") {
				return badge(compat.exempted ? t("compat.incompatible") + " · " + t("exempted") : t("compat.incompatible"), COLORS.error);
			}
			if (compat.status === "unknown") return badge(t("compat.unknown"), COLORS.tertiary);
			return badge(t("compat.compatible"), COLORS.ok);
		}

		/**
		 * What the update route answered, in the user's words.
		 *
		 * The route reports machine codes, never sentences: the same codes are
		 * what a test asserts, and the dictionary here is the only place the two
		 * languages live. Known codes get the reason a person can act on; the
		 * manager's own message is appended when it says something specific
		 * (a pnpm error line, an incompatibility), because inventing a cause is
		 * what produced the old "release-age policy" guess.
		 */
		function describeUpdateFailure(data, t, name, latest) {
			const spec = `${name}@${latest}`;
			const command = `dsh install-plugin ${spec}`;
			const code = typeof data?.code === "string" ? data.code : "";
			const detail = typeof data?.message === "string" && data.message !== "" ? data.message : "";
			if (code === "self-update") return `${t("update.selfUpdate")} \`${command}\``;
			if (code === "unchanged") return `${t("update.unchanged")} \`${command}\``;
			if (data?.removed === true) return `${t("update.removedThenFailed")} \`${command}\`${detail ? " — " + detail : ""}`;
			const known = {
				"no-plugin-manager": "update.noManager",
				"not-removable": "update.code.notRemovable",
				"bundle-in-use": "update.code.bundleInUse",
				"stop-profile": "update.code.stopProfile",
				"incompatible-version": "update.code.incompatible"
			};
			if (known[code] !== undefined) return `${t(known[code])}${detail ? " — " + detail : ""}`;
			return detail || t("update.failedUnknown");
		}

		function updateBadge(update, t, name) {
			// The runtime is the one row this panel can never update: the desktop
			// app's own updater delivers it (source 'desktop-updater'). A plain
			// "Update available" on a row with no button reads as a broken control,
			// so name the actor instead and leave the explanation to the hint line.
			// The npm fallback (a CLI/web host, no app feed) keeps the old wording:
			// there the runtime is updated with npm, not by an app.
			if (name === "dsh-runtime" && update.status === "update-available" && update.source === "desktop-updater") {
				return badge(t("update.appManaged"), COLORS.tertiary);
			}
			switch (update.status) {
				case "update-available":
					return badge(t("update.updateAvailable"), COLORS.warning);
				case "up-to-date":
					return badge(t("update.upToDate"), COLORS.ok);
				case "part-of-runtime":
					return badge(t("update.partOfRuntime"), COLORS.tertiary);
				case "unsupported":
					return badge(t("update.unsupported"), COLORS.tertiary);
				case "unknown":
				default:
					return update.error ? badge(t("update.error"), COLORS.tertiary) : badge(t("update.unknown"), COLORS.tertiary);
			}
		}

		function UpdateCheckerTab(props) {
			const { t, scan } = props;
			const [loading, setLoading] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [result, setResult] = react.useState(null);
			// Per-plugin update state keyed by bundle name.
			const [updating, setUpdating] = react.useState({});
			const [outcome, setOutcome] = react.useState({});

			const run = react.useCallback(async () => {
				setLoading(true);
				setError(null);
				try {
					// Use the `scan` handed in by the tab registration instead of a
					// second fetch here: one transport, one place to change it.
					const data = await scan();
					if (!data || data.ok !== true) throw new Error(data?.error || "scan failed");
					setResult(data);
					setOutcome({});
				} catch (err) {
					setError(String(err?.message ?? err));
				} finally {
					setLoading(false);
				}
			}, [scan]);

			const doUpdate = react.useCallback(async (name, latest, registry) => {
				// The runtime ('dsh-runtime') is not installed via pnpm and must not
				// be updated; its upgrade is delivered by the app's own updater. The
				// compute below already hides the button for any non-"update-available"
				// row, but guard anyway so a future change cannot route a runtime
				// upgrade into a pnpm install.
				if (name === "dsh-runtime") return;
				setUpdating((s) => ({ ...s, [name]: true }));
				setOutcome((s) => { const n = { ...s }; delete n[name]; return n; });
				try {
					// The host half owns the update: the desktop plugin manager refuses
					// `add` for a dependency that is already declared, so an update has
					// to be remove-then-install, and only the host can do that against
					// the manager service. This used to call
					// `remote.pluginManager.installBundle` directly, which came back
					// "failed/already-installed" with an untouched profile; that showed
					// up here as "profile 未变更" and was misread as the release-age
					// policy. The pinned exact version matters: a bare name leaves an
					// already-pinned dependency alone, so pnpm would install nothing.
					const res = await fetch("/api/plugin-update-checker/update", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							name,
							version: latest,
							...(typeof registry === "string" && registry !== "" ? { registry } : {})
						})
					});
					const data = await res.json();
					if (!data || data.ok !== true) throw new Error(describeUpdateFailure(data, t, name, latest));
					const restartRequired = data.restartRequired === true;
					setOutcome((s) => ({ ...s, [name]: { ok: true, restartRequired, application: data.application } }));
					// When the change is live immediately, re-scan so the row flips
					// to "up to date" instead of still showing "update available".
					if (!restartRequired) { try { await run(); } catch { /* ignore */ } }
				} catch (err) {
					setOutcome((s) => ({ ...s, [name]: { ok: false, error: String(err?.message ?? err) } }));
				} finally {
					setUpdating((s) => ({ ...s, [name]: false }));
				}
			}, [run, t]);

			const plugins = result?.plugins ?? [];
			const incompatible = plugins.filter((p) => p.compatibility?.status === "incompatible").length;
			const available = plugins.filter((p) => p.update?.status === "update-available").length;

			return react_jsx_runtime.jsxs("div", {
				style: { width: "100%", maxWidth: 760, display: "flex", flexDirection: "column", gap: 14, color: COLORS.label },
				children: [
					react_jsx_runtime.jsxs("div", {
						style: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" },
						children: [
							react_jsx_runtime.jsx("h3", { style: { margin: 0, fontSize: 13, fontWeight: 600 }, children: t("dshVersion") }),
							react_jsx_runtime.jsx("code", { style: { fontSize: 13, color: COLORS.tertiary }, children: result?.dshVersion ?? (loading ? "…" : "—") })
						]
					}),
					react_jsx_runtime.jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: 12 },
						children: [
							react_jsx_runtime.jsx("button", {
								type: "button",
								disabled: loading,
								onClick: () => run(),
								style: {
									appearance: "none",
									cursor: loading ? "default" : "pointer",
									border: "none",
									borderRadius: "var(--dsw-radius-md)",
									background: COLORS.primary,
									color: "var(--dsw-alias-on-state-business, #fff)",
									font: "inherit",
									fontWeight: 600,
									height: 36,
									padding: "0 18px"
								},
								children: loading ? t("checking") : t("check")
							}),
							result ? react_jsx_runtime.jsx("span", { style: { fontSize: 13, color: COLORS.tertiary }, children: t("lastChecked") + ": " + new Date(result.checkedAt).toLocaleString() }) : null
						]
					}),
					error ? react_jsx_runtime.jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: 10, color: COLORS.error, fontSize: 13 },
						children: [
							react_jsx_runtime.jsx("span", { children: t("error") + ": " + error }),
							react_jsx_runtime.jsx("button", {
								type: "button",
								onClick: () => run(),
								style: { border: "0.5px solid " + COLORS.border, borderRadius: "var(--dsw-radius-sm)", background: "transparent", color: COLORS.label, font: "inherit", cursor: "pointer", padding: "4px 10px" },
								children: t("retry")
							})
						]
					}) : null,
					result && plugins.length > 0 ? react_jsx_runtime.jsx("p", {
						style: { margin: 0, fontSize: 13, color: COLORS.tertiary },
						children: t("summary", { total: plugins.length, incompatible, available })
					}) : null,
					!loading && result && plugins.length === 0 ? react_jsx_runtime.jsx("p", { style: { margin: 0, fontSize: 13, color: COLORS.tertiary }, children: t("noPlugins") }) : null,
					Object.values(outcome).some((o) => o?.restartRequired === true) ? react_jsx_runtime.jsxs("div", {
						style: { display: "flex", flexDirection: "column", gap: 6, border: "0.5px solid " + COLORS.warning, borderRadius: "var(--dsw-radius-md)", background: "color-mix(in srgb, " + COLORS.warning + " 10%, transparent)", padding: "10px 12px", fontSize: 13, color: COLORS.warning },
						children: [
							react_jsx_runtime.jsx("span", { style: { fontWeight: 600 }, children: t("restartRequired") }),
							react_jsx_runtime.jsx("span", { style: { color: COLORS.label, fontSize: 12 }, children: t("manualRestart") })
						]
					}) : null,
					result && plugins.length > 0 ? react_jsx_runtime.jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: 10 },
						children: plugins.map((p) => react_jsx_runtime.jsxs("div", {
							key: p.name,
							style: { border: "0.5px solid " + COLORS.border, borderRadius: "var(--dsw-radius-md)", background: COLORS.bg, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 },
							children: [
								react_jsx_runtime.jsxs("div", {
									style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
									children: [
										react_jsx_runtime.jsx("span", { style: { fontWeight: 600, fontSize: 13 }, children: p.name === "dsh-runtime" ? t("runtimeName") : p.name }),
										react_jsx_runtime.jsxs("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }, children: [compatBadge(p.compatibility, t), updateBadge(p.update, t, p.name), (() => {
											if (p.linked) return badge(t("linked"), COLORS.tertiary);
											// The runtime is never updated through installBundle, in either
											// carrier: the desktop app delivers it, a CLI host gets it from
											// npm. So this row never gets a button — a button here would
											// call doUpdate, which refuses the runtime and would look dead.
											// The desktop feed adds "check the menu"; the npm hint lives
											// below the row.
											if (p.name === "dsh-runtime") {
												return p.update?.status === "update-available" && p.update.source === "desktop-updater"
													? react_jsx_runtime.jsx("span", { style: { fontSize: 12, color: COLORS.warning }, children: t("runtimeUpdateAvailable") })
													: null;
											}
											if (p.update?.status !== "update-available") return null;
											const busy = updating[p.name] === true;
											const o = outcome[p.name];
											if (o?.ok) return badge(o.restartRequired ? t("restartRequired") : t("updated"), COLORS.ok);
											return react_jsx_runtime.jsx("button", {
												type: "button",
												disabled: busy,
												onClick: () => doUpdate(p.name, p.update?.latest, p.update?.registry ?? p.registry),
												style: { appearance: "none", cursor: busy ? "default" : "pointer", border: "none", borderRadius: "var(--dsw-radius-sm)", background: COLORS.warning, color: "#fff", font: "inherit", fontWeight: 600, fontSize: 12, height: 24, padding: "0 12px" },
												children: busy ? t("updating") : t("updateBtn")
											});
										})()] })
									]
								}),
								react_jsx_runtime.jsxs("div", {
									style: { display: "flex", gap: 16, fontSize: 12, color: COLORS.tertiary, flexWrap: "wrap" },
									children: [
										react_jsx_runtime.jsxs("span", { children: [t("col.installed") + ": ", react_jsx_runtime.jsx("code", { children: p.installedVersion ?? "—" })] }),
										react_jsx_runtime.jsxs("span", { children: [t("col.latest") + ": ", react_jsx_runtime.jsx("code", { children: p.linked ? t("linked") : (p.update?.latest ?? "—") })] })
									]
								}),
								p.compatibility?.status === "incompatible" && p.compatibility.peers ? react_jsx_runtime.jsxs("div", {
									style: { fontSize: 12, color: COLORS.error },
									children: [
										react_jsx_runtime.jsx("span", { children: t("compat.peers") + ": " }),
										react_jsx_runtime.jsxs("code", { children: Object.entries(p.compatibility.peers).map((e, _i) => react_jsx_runtime.jsx("div", { children: e[0] + " " + e[1] }, e[0])) })
									]
								}) : null,
								p.update?.status === "unknown" && p.update.error ? react_jsx_runtime.jsx("div", { style: { fontSize: 12, color: COLORS.tertiary }, children: p.update.error }) : null,
								p.update?.status === "unsupported" && p.update.error ? react_jsx_runtime.jsx("div", { style: { fontSize: 12, color: COLORS.tertiary }, children: p.update.error }) : null,
								p.linked ? react_jsx_runtime.jsxs("div", {
									style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: COLORS.tertiary },
									children: [
										react_jsx_runtime.jsx("span", { children: t("linkedHint") }),
										react_jsx_runtime.jsx("span", { children: [t("sourcePath") + ": ", react_jsx_runtime.jsx("code", { children: p.source?.dir ?? "—" })] }),
										p.source?.link ? react_jsx_runtime.jsx("a", {
											href: p.source.link,
											target: "_blank",
											rel: "noreferrer",
											style: { color: COLORS.link },
											children: t("sourceLink")
										}) : null
									]
								}) : null,
								outcome[p.name]?.ok === false ? react_jsx_runtime.jsxs("div", { style: { fontSize: 12, color: COLORS.error }, children: [react_jsx_runtime.jsx("span", { children: t("updateFailed") + ": " }), react_jsx_runtime.jsx("span", { children: outcome[p.name].error || "unknown error" })] }) : null,
								p.name === "dsh-runtime" && p.update?.status === "update-available" ? react_jsx_runtime.jsx("div", {
									style: { fontSize: 12, color: COLORS.warning },
									children: p.update.source === "desktop-updater"
										? t("runtimeUpdateHint")
										: t("runtimeUpdateHintNpm", { version: p.update.latest ?? "" })
								}) : null
							]
						}, p.name))
					}) : null
				]
			});
		}

		//#region plugin body
		/**
		 * Services required by the Settings registration.
		 *
		 * `remote` is deliberately absent: both the scan and the update are the
		 * host's own routes, and the update used to reach `remote.pluginManager`
		 * from here only to be refused with `already-installed`. Keeping the
		 * browser half off the plugin-manager service means it cannot install
		 * anything the host's update route would not.
		 */
		const inject = [
			"slots",
			"locale",
			"modules"
		];

		/**
		 * The running Host's own release version, read back off the boot graph the
		 * Host composed and injected as `window.__DSH_BOOT__`.
		 *
		 * The host half cannot always work this out by itself: inside the desktop
		 * app the runtime lives in `app.asar`, while its module lookups find the
		 * npm-installed CLI — it reported 0.2.1-rc.2 while running under rc.5. The
		 * page, by contrast, was handed the true release by the Host that serves it,
		 * so relaying it is both cheap and exact. Undefined when the graph carries
		 * no release (older Hosts) — the host half then keeps its own resolution.
		 */
		function bootRuntimeVersion() {
			try {
				const release = window.__DSH_BOOT__ && window.__DSH_BOOT__.release;
				return release && typeof release.version === "string" ? release.version : undefined;
			} catch {
				return undefined;
			}
		}

		/** The scan route, with the boot release attached when the graph carries one. */
		function scanUrl() {
			const version = bootRuntimeVersion();
			return version === undefined
				? "/api/plugin-update-checker/scan"
				: "/api/plugin-update-checker/scan?runtime=" + encodeURIComponent(version);
		}

		/** Register the check-updates tab into the Built-in plugins settings section. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "plugin-update-checker: dictionaries");
			const t = ctx.locale.bind(NS);
			const scan = async () => {
				const res = await fetch(scanUrl(), { method: "POST" });
				return res.json();
			};
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "update-checker",
				order: 20,
				label: () => t("tab"),
				locale: NS,
				inject: () => ({ t, scan })
			}, UpdateCheckerTab), "plugin-update-checker: tab");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
