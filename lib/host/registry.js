/**
 * dsh-plugin-update-checker — host/registry.js
 *
 * 由 lib/host/update-checker.js 按下述职责拆出（函数体逐字保留）：
 *   resolveRegistries, firstConfiguredRegistry, normalizeRegistry, isPublicDefault, readRegistryFromNpmrc, probeAnyRegistry, probeRegistry, classifyUpdate
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { default as semver } from 'semver'

export function resolveRegistries(profileDir) {
  const MIRROR = 'https://registry.npmmirror.com'
  const PUBLIC = 'https://registry.npmjs.org'

  const configured = firstConfiguredRegistry(profileDir)
  if (configured === undefined) return [MIRROR, PUBLIC]
  if (isPublicDefault(configured)) return [configured, MIRROR]
  return [configured]
}

/** The first registry named by the environment or an .npmrc, most specific first. */
function firstConfiguredRegistry(profileDir) {
  const sources = [
    process.env.npm_config_registry,
    process.env.NPM_CONFIG_REGISTRY,
    readRegistryFromNpmrc(join(profileDir, '.npmrc')),
    readRegistryFromNpmrc(join(homedir(), '.npmrc')),
  ]
  for (const value of sources) {
    const base = normalizeRegistry(value)
    if (base !== undefined) return base
  }
  return undefined
}

/** Trim a registry into a bare base URL, or undefined when it names nothing. */
export function normalizeRegistry(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed === '') return undefined
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** Whether a registry is npm's own public default. */
function isPublicDefault(base) {
  try {
    return new URL(base).hostname.toLowerCase() === 'registry.npmjs.org'
  } catch {
    return false
  }
}

/**
 * Read the default `registry=` out of an .npmrc.
 *
 * Only the unscoped default is taken: a scoped `@scope:registry=` sends one
 * scope elsewhere, which is a per-package decision belonging with that package's
 * manifest rather than with the default this resolves.
 *
 * @param {string} file - path to an .npmrc.
 * @returns {string|undefined} the configured registry, if any.
 */
function readRegistryFromNpmrc(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    // A scoped entry (`@scope:registry=`) is per-scope, not the default.
    if (line.startsWith('@')) continue
    const match = /^registry\s*=\s*(.+)$/.exec(line)
    if (match) {
      const value = match[1].trim().replace(/^["']|["']$/g, '')
      if (value !== '') return value
    }
  }
  return undefined
}

/**
 * Probe the registries concurrently and take the first *successful* answer.
 *
 * A per-registry failure (or a slow one) never blocks the others: the mirror
 * wins even when the public registry was asked first, which is the whole point
 * on a mirror-served host. The winner's base is returned so a caller that needs
 * to install from the same place can pass it along.
 *
 * @param {string} name - package name.
 * @param {string[]} registries - candidate bases, best first.
 * @param {AbortSignal} signal - request deadline.
 * @returns {Promise<{ result: object, registry: string }>} the winning answer.
 */
export async function probeAnyRegistry(name, registries, signal) {
  // Start every candidate at once and settle on the first *successful* answer,
  // in completion order rather than list order. Awaiting in list order would let
  // a slow first registry delay an already-finished mirror — exactly the case
  // this exists to fix.
  if (registries.length === 0) return { result: { error: 'no registry configured' }, registry: undefined }
  return await new Promise((resolve) => {
    let failures = 0
    let lastFailure = null
    let settled = false
    for (const registry of registries) {
      probeRegistry(name, registry, signal).then((result) => {
        if (settled) return
        if (result.error === undefined) {
          settled = true
          resolve({ result, registry })
          return
        }
        lastFailure = { result, registry }
        failures += 1
        if (failures === registries.length) {
          settled = true
          resolve(lastFailure)
        }
      }, (err) => {
        if (settled) return
        lastFailure = { result: { error: `registry unreachable: ${String(err?.message ?? err)}` }, registry }
        failures += 1
        if (failures === registries.length) {
          settled = true
          resolve(lastFailure)
        }
      })
    }
  })
}

/** Probe one npm registry for a package's published versions. */
async function probeRegistry(name, registry, signal) {
  const base = registry && registry.trim() !== '' ? registry.replace(/\/+$/, '') : 'https://registry.npmjs.org'
  const url = `${base}/${encodeURIComponent(name).replace('%40', '@')}`
  try {
    const res = await fetch(url, { method: 'GET', headers: { accept: 'application/json' }, signal })
    if (!res.ok) return { error: `registry responded ${res.status}` }
    const data = await res.json()
    const distTags = data?.['dist-tags']
    const versions = Array.isArray(data?.versions) ? data.versions : Object.keys(data?.versions ?? {})
    if (distTags?.latest === undefined && versions.length === 0) return { error: 'package not found on registry' }
    return { latest: distTags?.latest, versions }
  } catch (err) {
    if (err?.name === 'AbortError') return { error: 'request aborted' }
    return { error: `registry unreachable: ${String(err?.message ?? err)}` }
  }
}

/** Compare installed vs latest into an update verdict. */
export function classifyUpdate(installedVersion, remote) {
  if (remote.error !== undefined) return { status: 'unknown', error: remote.error }
  const latest = remote.latest
  if (latest === undefined) return { status: 'unknown', error: 'no published version' }
  let newer = false
  try {
    newer = semver.gt(latest, installedVersion ?? '0.0.0')
  } catch {
    newer = String(latest) !== String(installedVersion)
  }
  return newer ? { status: 'update-available', latest } : { status: 'up-to-date', latest }
}

/**
 * Check the running DSH *runtime* itself for a newer release.
 *
 * The runtime is not a plugin: it is the @deepseek-ai/dsh* tree the launcher
 * boots, carrying one version. We report it as a single, clearly labelled row
 * ("dsh-runtime") so the panel can answer "is my DSH itself up to date?" — the
 * question the old panel silently left unanswered. We never call it a
 * source-link (the @deepseek-ai/dsh* packages are symlinked from the runtime
 * install, which would otherwise make the scanner mislabel the *entire runtime*
 * as a user-edited source tree and say "update from the repository").
 *
 * Source precedence for the running-runtime comparison:
 *   1. The desktop app's own electron updater feed (app-update.yml's `url` +
 *      `channel`). This is the authoritative channel and the ONLY correct one
 *      for prerelease / nightly users: npm's `latest` dist-tag lags the running
 *      nightly build, so comparing against it would falsely report "up to date".
 *   2. npm's @deepseek-ai/dsh-app-boot `latest` dist-tag — correct for stable
 *      channel users, and used when no updater feed is reachable (e.g. the web
 *      profile, which has no app-update.yml).
 *
 * A probe failure (offline, private registry, ...) is surfaced honestly as
 * status 'unknown' rather than hiding the row.
 *
 * @param {string} dshVersion - the running runtime version.
 * @param {string[]} registries - candidate registry bases, best first.
 * @param {AbortSignal} signal - request deadline.
 * @returns {Promise<object>} a row shaped like scanBundle's output, with
 *   name 'dsh-runtime', so the browser half can render it without special-casing.
 */
