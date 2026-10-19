/**
 * dsh-plugin-update-checker — host/runtime.js
 *
 * 由 lib/host/update-checker.js 按下述职责拆出（函数体逐字保留）：
 *   APP_UPDATE_YML, readAppUpdateConfig, runtimeFeedFileNames, runtimePlatformKey, runtimeArchKey, fetchRuntimeFeedVersion, checkDshRuntime
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { default as semver } from 'semver'
import { normalizeRegistry, probeAnyRegistry, classifyUpdate } from './registry.js'

const APP_UPDATE_YML = 'app-update.yml'

/**
 * Locate and parse the desktop app's app-update.yml.
 *
 * The Electron host's argv carries the app path (e.g.
 *   DeepSeek Harness --expose-internals <host.js> <app.asar/dsh>
 *     /Users/me/.dsh/profiles/desktop <runtime> ...),
 * so we walk up from that path to find app-update.yml (it sits in
 * .../Contents/Resources/, the parent of app.asar). On the web profile there is
 * no app bundle, so this returns undefined and the runtime check falls back to
 * npm. Returns { url, channel } or undefined.
 */
function readAppUpdateConfig() {
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith('/') || arg.startsWith('-')) continue
    let dir = dirname(arg)
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, APP_UPDATE_YML)
      if (existsSync(candidate)) {
        try {
          const text = readFileSync(candidate, 'utf8')
          const get = (k) => {
            const m = new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, 'm').exec(text)
            return m ? m[1].trim() : undefined
          }
          const url = get('url')
          if (!url) return undefined
          return { url: normalizeRegistry(url).replace(/\/+$/, ''), channel: get('channel') || 'latest' }
        } catch {
          return undefined
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return undefined
}

/** electron-builder's channel file name for the current platform/arch. */
function runtimeFeedFileNames(channel, platform, arch) {
  const base = (channel === 'latest' ? 'latest' : channel) + '-' + platform
  // electron-builder may publish a per-arch file (latest-mac-arm64.yml) in
  // addition to the platform-only file; try the arch-suffixed name first.
  return arch ? [base + '-' + arch + '.yml', base + '.yml'] : [base + '.yml']
}

/** Map node's platform/arch onto electron-builder's feed naming. */
function runtimePlatformKey() {
  const p = process.platform
  if (p === 'darwin') return 'mac'
  if (p === 'win32') return 'win'
  if (p === 'linux') return 'linux'
  return undefined
}
function runtimeArchKey() {
  if (process.arch === 'arm64') return 'arm64'
  if (process.arch === 'x64') return 'x64'
  return undefined
}

/**
 * Fetch the published runtime version from the desktop app's electron updater
 * feed. Returns { version } on success or { error } when every candidate file
 * is missing/unreachable, so the caller can fall back to npm.
 */
async function fetchRuntimeFeedVersion(feedBase, channel, signal) {
  const platform = runtimePlatformKey()
  if (!platform) return { error: 'unsupported platform for feed lookup' }
  const names = runtimeFeedFileNames(channel, platform, runtimeArchKey())
  let lastErr
  for (const name of names) {
    const url = feedBase + '/' + name
    try {
      const res = await fetch(url, { method: 'GET', signal })
      if (!res.ok) { lastErr = `feed responded ${res.status}`; continue }
      const text = await res.text()
      const m = /^version\s*:\s*(\S+)/m.exec(text)
      if (!m) { lastErr = 'feed missing version'; continue }
      return { version: m[1].replace(/['"]/g, '') }
    } catch (err) {
      if (err?.name === 'AbortError') return { error: 'request aborted' }
      lastErr = `feed unreachable: ${String(err?.message ?? err)}`
    }
  }
  return { error: lastErr ?? 'feed not found' }
}

/** Scan one bundle for compatibility + update facts. */
export async function checkDshRuntime(dshVersion, registries, signal) {
  const row = {
    name: 'dsh-runtime',
    installedVersion: dshVersion,
    installed: true,
    linked: false,
    description: 'DSH 运行时（@deepseek-ai/dsh*）',
    compatibility: { status: 'compatible' },
    update: { status: 'unknown', error: 'not scanned' },
  }
  try {
    // 1) Authoritative: the desktop app's own electron updater feed.
    const cfg = readAppUpdateConfig()
    if (cfg) {
      const feed = await fetchRuntimeFeedVersion(cfg.url, cfg.channel, signal)
      if (feed.version !== undefined) {
        let newer = false
        try { newer = semver.gt(feed.version, dshVersion ?? '0.0.0') } catch { newer = String(feed.version) !== String(dshVersion) }
        if (newer) {
          row.update = { status: 'update-available', latest: feed.version, source: 'desktop-updater' }
        } else {
          row.update = { status: 'up-to-date', latest: feed.version }
        }
        return row
      }
      // Feed unreachable -> fall through to npm; its error is non-fatal.
    }
    // 2) Fallback: npm's @deepseek-ai/dsh-app-boot `latest` dist-tag.
    const { result: remote, registry: usedRegistry } = await probeAnyRegistry('@deepseek-ai/dsh-app-boot', registries, signal)
    row.update = classifyUpdate(dshVersion, remote)
    if (row.update.status !== 'unknown' && usedRegistry) row.update.registry = usedRegistry
    if (row.update.status === 'unknown' && remote.error && /not found|404/.test(remote.error)) {
      row.update = { status: 'unsupported', error: 'runtime not published to the configured registry' }
    }
  } catch (err) {
    row.update = { status: 'unknown', error: String(err?.message ?? err) }
  }
  return row
}

/** The electron updater's channel file lives next to the app at app-update.yml. */
