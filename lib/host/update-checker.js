/**
 * dsh-plugin-update-checker — host half entry.
 *
 * 这里只做装配：解析运行时版本 → 枚举 profile 的 bundles → 逐包扫描 → 回一行 JSON。
 * 具体职责见同目录：dsh.js（DSH 适配）、profile.js（目录与清单）、registry.js（源与探测）、
 * runtime.js（运行时更新源）、scan.js（单包扫描）。
 */
import { getDshRuntimeVersion, readProfileVersionExemptions } from './dsh.js'
import { activeProfileDir, KNOWN_REPOS, listBundles } from './profile.js'
import { resolveRegistries } from './registry.js'
import { checkDshRuntime } from './runtime.js'
import { scanBundle } from './scan.js'

// 对外导出面保持不变：evaluatePluginCompatibility 随拆分搬到了 dsh.js，
// 但测试与外部调用方一直从入口取它，所以在这里再导出一次。
export { evaluatePluginCompatibility } from './dsh.js'

export function apply(ctx, _config = {}) {
  const { webServer } = ctx
  const dshVersion = getDshRuntimeVersion()
  const repositories = { ...KNOWN_REPOS, ...(_config?.repositories ?? {}) }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/plugin-update-checker/scan',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      const profileDir = activeProfileDir()
      const exemptions = (() => { try { return readProfileVersionExemptions(profileDir) } catch { return {} } })()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20000)

      try {
        // Enumerate from the profile's dsh.profile.bundles on disk. The host
        // half used to try `ctx.remote.pluginManager.listBundles()` first, but
        // `remote` is a browser-side service: on the host that access throws
        // "cannot get property ... without inject", the catch swallowed it, and
        // the disk scan ran anyway. The throw was dead weight, not a fallback.
        const bundles = await listBundles(profileDir)

        // Resolve registries once per scan, not once per bundle, and racing them
        // keeps a slow public registry from dominating a mirror-served host.
        // NOTE: reads configuration, never ctx.remote — that is a browser-side
        // service, and touching it here throws "cannot get property ... without
        // inject" (the host half declares only webServer).
        const registries = resolveRegistries(profileDir)

        const plugins = await Promise.all(
          bundles.map((b) => scanBundle(b, profileDir, dshVersion, exemptions, controller.signal, repositories, registries)
            .catch((err) => ({
              name: b.name,
              installedVersion: b.version ?? null,
              compatibility: { status: 'unknown', error: String(err?.message ?? err) },
              update: { status: 'unknown', error: String(err?.message ?? err) },
            })))
        )

        // The runtime is not a bundle in the profile, so it is never in
        // `bundles`. Check it explicitly as one unit so the panel can answer
        // "is my DSH itself up to date?" — the question the old panel silently
        // left unanswered. It is appended, never merged into a plugin row.
        const runtimeRow = await checkDshRuntime(dshVersion, registries, controller.signal)
          .catch((err) => ({ name: 'dsh-runtime', installedVersion: dshVersion, compatibility: { status: 'compatible' }, update: { status: 'unknown', error: String(err?.message ?? err) } }))
        plugins.push(runtimeRow)

        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, dshVersion, checkedAt: new Date().toISOString(), plugins }))
      } catch (err) {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
      } finally {
        clearTimeout(timeout)
      }
    },
  }), 'plugin-update-checker: scan route')

  // NOTE: There is deliberately NO restart route here. DSH's own plugin
  // manager never restarts the app (a "restart-required" install result merely
  // means "takes effect at next start"); restarting on this machine is a
  // manual operator action (stop the :3080 listeners, then `dsh restart` or
  // re-launch). The browser half surfaces that as a manual prompt instead of
  // trying to detach-kill its own host process, which proved unreliable.
}
