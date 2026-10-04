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
 * It calls only the host route this package ships (`/api/plugin-update-checker/
 * scan`); it renders no local transport. A failed per-bundle lookup is shown as
 * a row-level warning rather than blanking the report.
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
			"update.unknown": "未知",
			"update.unsupported": "不受支持",
			"update.error": "无法检查",
			"compat.peers": "不兼容的 peer 依赖",
			"exempted": "已豁免",
			"updateBtn": "更新",
			"updating": "更新中…",
			"updated": "已更新",
			"updateFailed": "更新失败",
			"linked": "源码链接（请从源码更新）",
			"linkedHint": "该插件以源码软链方式安装，无法一键更新；请到源码目录拉取最新代码后重启 DSH。",
			"sourceLink": "前往源码仓库",
			"sourcePath": "源码路径",
			"restartRequired": "已更新，需重启 DSH 生效",
			"restart": "重启 DSH",
			"restarting": "正在重启 DSH，页面将在服务恢复后自动刷新…",
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
			"update.unknown": "Unknown",
			"update.unsupported": "Unsupported",
			"update.error": "Cannot check",
			"compat.peers": "Incompatible peer dependencies",
			"exempted": "Exempted",
			"updateBtn": "Update",
			"updating": "Updating…",
			"updated": "Updated",
			"updateFailed": "Update failed",
			"linked": "Source-linked (update from source)",
			"linkedHint": "This plugin is installed as a source symlink and cannot be updated in one click. Pull the latest from its source repo, then restart DSH.",
			"sourceLink": "Open source repository",
			"sourcePath": "Source path",
			"restartRequired": "Updated — restart DSH to apply",
			"restart": "Restart DSH",
			"restarting": "Restarting DSH — this page reloads automatically once the service is back…",
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
			bg: "var(--dsw-alias-bg-layer-1)"
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

		function updateBadge(update, t) {
			switch (update.status) {
				case "update-available":
					return badge(t("update.updateAvailable"), COLORS.warning);
				case "up-to-date":
					return badge(t("update.upToDate"), COLORS.ok);
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
					const res = await fetch("/api/plugin-update-checker/scan", { method: "POST" });
					const data = await res.json();
					if (!data.ok) throw new Error(data.error || "scan failed");
					setResult(data);
					setOutcome({});
				} catch (err) {
					setError(String(err?.message ?? err));
				} finally {
					setLoading(false);
				}
			}, []);

			const doUpdate = react.useCallback(async (name, latest, registry) => {
				setUpdating((s) => ({ ...s, [name]: true }));
				setOutcome((s) => { const n = { ...s }; delete n[name]; return n; });
				try {
					const pm = props.remote?.pluginManager;
					if (!pm?.installBundle) throw new Error("plugin manager service unavailable in this client");
					// installBundle defaults to registry.npmjs.org, which is often
					// unreachable here; probe the reachable registry first (mirrors
					// the GUI's own fast-registry selection) and pass it explicitly.
					// fastest() answers a Remote envelope { ok, value } — unwrap it;
					// passing the envelope itself fails wire validation (registry
					// must be null | string).
					let reg = typeof registry === "string" && registry !== "" ? registry : "";
					if (!reg) {
						try {
							const probe = await props.remote?.pluginRegistryProbe?.fastest();
							if (probe?.ok && typeof probe.value === "string" && probe.value !== "") reg = probe.value;
						} catch { /* keep empty */ }
					}
					// Pin to the exact latest version. A bare `name` spec leaves a
					// profile that already pins the exact version (e.g. "0.6.5")
					// unchanged, so installBundle reports a false "restart-required"
					// without actually upgrading — leaving the old version after
					// restart. `name@latest` forces pnpm to swap the version, exactly
					// like the GUI's "Add plugin" dialog (which passes the resolved
					// latest version as the spec).
					const spec = typeof latest === "string" && latest !== "" ? `${name}@${latest}` : name;
					const result = await pm.installBundle(spec, {
						enabled: true,
						requestId: `update-checker:${name}:${Date.now()}`,
						...(reg ? { registry: reg } : {}),
					});
					if (!result?.ok) throw new Error(result?.error?.message || result?.error?.code || "install failed");
					const value = result.value ?? {};
					const application = value.application ?? "applied";
					// `changed` is set by the host when the profile was actually
					// modified (pnpm really swapped the version). installBundle may
					// still report ok without changing anything (e.g. a bare spec
					// against an already-pinned version), so surface that.
					const changed = value.changed === true;
					if (!changed) throw new Error("registry returned no newer version; profile unchanged");
					setOutcome((s) => ({ ...s, [name]: { ok: true, restartRequired: application === "restart-required", application } }));
					// When the change is live immediately, re-scan so the row flips
					// to "up to date" instead of still showing "update available".
					if (application !== "restart-required") { try { await run(); } catch { /* ignore */ } }
				} catch (err) {
					setOutcome((s) => ({ ...s, [name]: { ok: false, error: String(err?.message ?? err) } }));
				} finally {
					setUpdating((s) => ({ ...s, [name]: false }));
				}
			}, []);

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
							react_jsx_runtime.jsx("span", { style: { color: COLORS.label, fontSize: 12 }, children: t("manualRestart") }),
							outcome.__restart?.error ? react_jsx_runtime.jsx("span", { style: { color: COLORS.error, fontSize: 12 }, children: outcome.__restart.error }) : null
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
										react_jsx_runtime.jsx("span", { style: { fontWeight: 600, fontSize: 13 }, children: p.name }),
										react_jsx_runtime.jsxs("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }, children: [compatBadge(p.compatibility, t), updateBadge(p.update, t), (() => {
											if (p.linked) return badge(t("linked"), COLORS.tertiary);
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
											style: { color: COLORS.link ?? "#3b82f6" },
											children: t("sourceLink")
										}) : null
									]
								}) : null,
								outcome[p.name]?.ok === false ? react_jsx_runtime.jsxs("div", { style: { fontSize: 12, color: COLORS.error }, children: [react_jsx_runtime.jsx("span", { children: t("updateFailed") + ": " }), react_jsx_runtime.jsx("span", { children: outcome[p.name].error || "unknown error" })] }) : null
							]
						}, p.name))
					}) : null
				]
			});
		}

		//#region plugin body
		/** Services required by the Settings registration + the update action. */
		const inject = [
			"slots",
			"locale",
			"modules",
			"remote",
			"remote.pluginManager",
			"remote.pluginRegistryProbe"
		];

		/** Register the check-updates tab into the Built-in plugins settings section. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "plugin-update-checker: dictionaries");
			const t = ctx.locale.bind(NS);
			const scan = async () => {
				const res = await fetch("/api/plugin-update-checker/scan", { method: "POST" });
				return res.json();
			};
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "update-checker",
				order: 20,
				label: () => t("tab"),
				locale: NS,
				inject: () => ({ t, scan, remote: ctx.remote })
			}, UpdateCheckerTab), "plugin-update-checker: tab");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
