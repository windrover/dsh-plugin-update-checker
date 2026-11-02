/**
 * dsh-plugin-update-checker — host half entry.
 *
 * 这里只做装配：解析运行时版本 → 枚举 profile 的 bundles → 逐包扫描 → 回一行 JSON；
 * 另外把「一键更新」做成一条宿主路由，交给 update.js 编排。具体职责见同目录：
 * dsh.js（DSH 适配）、profile.js（目录与清单）、registry.js（源与探测）、
 * runtime.js（运行时更新源）、scan.js（单包扫描）、update.js（更新编排）。
 */
import { join } from 'node:path'
import { getDshRuntimeVersion, readProfileVersionExemptions, runtimeVersionFromRequest } from './dsh.js'
import { activeProfileDir, findBundleDir, KNOWN_REPOS, listBundles, readManifest } from './profile.js'
import { resolveRegistries } from './registry.js'
import { checkDshRuntime } from './runtime.js'
import { scanBundle } from './scan.js'
import { parseUpdateRequest, performUpdate } from './update.js'

// 对外导出面保持不变：evaluatePluginCompatibility 随拆分搬到了 dsh.js，
// 但测试与外部调用方一直从入口取它，所以在这里再导出一次。
export { evaluatePluginCompatibility } from './dsh.js'

/** This package's own name: the one bundle the update route must never remove. */
const SELF = 'dsh-plugin-update-checker'
const MAX_BODY_BYTES = 16 * 1024

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

/** Read a small JSON request body; the web server hands the raw stream. */
async function readJson(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text === '' ? {} : JSON.parse(text)
}

/** The version actually on disk, so a manager that reported success can be checked. */
async function installedVersion(profileDir, name) {
  const dir = findBundleDir(name, profileDir)
  if (dir === undefined) return undefined
  const manifest = await readManifest(join(dir, 'package.json'))
  return typeof manifest?.version === 'string' ? manifest.version : undefined
}

export function apply(ctx, _config = {}) {
  const { webServer } = ctx
  // Resolved once: the env var / desktop descriptor / CLI tree do not change
  // between requests. The browser half may still know better per request (see
  // runtimeVersionFromRequest) and that value wins for that one scan.
  const resolvedDshVersion = getDshRuntimeVersion()
  const repositories = { ...KNOWN_REPOS, ...(_config?.repositories ?? {}) }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/plugin-update-checker/scan',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      // The page relays the Host release it booted from
      // (`window.__DSH_BOOT__.release.version`): inside the desktop app that is the
      // only value equal to the runtime actually serving this request.
      const relayedDshVersion = runtimeVersionFromRequest(req)
      const dshVersion = relayedDshVersion ?? resolvedDshVersion
      const dshVersionSource = relayedDshVersion === undefined ? 'host' : 'client'
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

        sendJson(res, 200, { ok: true, dshVersion, dshVersionSource, checkedAt: new Date().toISOString(), plugins })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
      } finally {
        clearTimeout(timeout)
      }
    },
  }), 'plugin-update-checker: scan route')

  // The update route drives the host's own plugin manager instead of the
  // browser's `remote.pluginManager`. Both reach the same service, but the
  // manager refuses `add` for an already-declared dependency and an update has
  // to become remove+install; doing that here keeps the two steps in one place,
  // on the side that has the service and can be tested with a fake manager.
  // See update.js for why the browser half's single `installBundle` never
  // changed the profile.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/plugin-update-checker/update',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body
      try {
        body = await readJson(req)
      } catch (err) {
        sendJson(res, 400, { ok: false, error: `bad request body: ${String(err?.message ?? err)}` })
        return
      }
      const request = parseUpdateRequest(body)
      if (request.error !== undefined) {
        sendJson(res, 400, { ok: false, error: request.error })
        return
      }
      const manager = (() => { try { return ctx.get('pluginManager') } catch { return undefined } })()
      if (manager === undefined) {
        sendJson(res, 503, {
          ok: false,
          code: 'no-plugin-manager',
          message: 'this host exposes no pluginManager service; install the update with dsh install-plugin from a terminal',
        })
        return
      }
      try {
        // The page relays the Host release it booted from
      // (`window.__DSH_BOOT__.release.version`): inside the desktop app that is the
      // only value equal to the runtime actually serving this request.
      const relayedDshVersion = runtimeVersionFromRequest(req)
      const dshVersion = relayedDshVersion ?? resolvedDshVersion
      const dshVersionSource = relayedDshVersion === undefined ? 'host' : 'client'
      const profileDir = activeProfileDir()
        const result = await performUpdate(manager, request, { selfName: SELF })
        if (!result.ok) {
          sendJson(res, 200, result)
          return
        }
        // A manager can report `applied` while writing nothing (that is the
        // `changed: false` shape the browser half used to misread). The version
        // on disk is the authority, so check it before calling this a success.
        const onDisk = await installedVersion(profileDir, request.name)
        if (onDisk !== undefined && onDisk !== request.version) {
          sendJson(res, 200, {
            ok: false,
            stage: result.steps[result.steps.length - 1],
            code: 'unchanged',
            message: `the plugin manager reported "${result.application}" but ${request.name} is still ${onDisk} on disk`,
            steps: result.steps,
            ...(result.removed === true ? { removed: true } : {}),
          })
          return
        }
        sendJson(res, 200, { ...result, installedVersion: onDisk ?? result.installedVersion ?? request.version })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
      }
    },
  }), 'plugin-update-checker: update route')

  // NOTE: There is deliberately NO restart route here. DSH's own plugin
  // manager never restarts the app (a "restart-required" install result merely
  // means "takes effect at next start"); restarting on this machine is a
  // manual operator action (stop the :3080 listeners, then `dsh restart` or
  // re-launch). The browser half surfaces that as a manual prompt instead of
  // trying to detach-kill its own host process, which proved unreliable.
}
