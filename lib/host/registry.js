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
export async function probeAnyRegistry(name, registries, signal, installedVersion) {
  // Start every candidate at once and settle on the first *successful* answer,
  // in completion order rather than list order. Awaiting in list order would let
  // a slow first registry delay an already-finished mirror — exactly the case
  // this exists to fix.
  if (registries.length === 0) return { result: { error: 'no registry configured' }, registry: undefined }

  const probes = registries.map((registry) =>
    probeRegistry(name, registry, signal).then(
      (result) => ({ result, registry }),
      (err) => ({ result: { error: `registry unreachable: ${String(err?.message ?? err)}` }, registry }),
    ),
  )

  // First success wins, so the common case stays as fast as the fastest mirror.
  const first = await new Promise((resolve) => {
    let done = false
    let failures = 0
    for (const probe of probes) {
      probe.then((answer) => {
        if (done) return
        if (answer.result.error === undefined) {
          done = true
          resolve(answer)
          return
        }
        failures += 1
        if (failures === probes.length) {
          done = true
          resolve(undefined)
        }
      })
    }
  })

  if (first === undefined) {
    const all = await Promise.all(probes)
    return all[all.length - 1]
  }

  // A fast mirror can be stale: it may still carry the placeholder version npm
  // creates for a brand-new package, or lag behind the version we already have
  // installed. Taking that at face value reports "up to date" for something a
  // second registry knows better, which is the one verdict this plugin must not
  // get wrong. When the first answer looks like that, wait for the rest (they
  // are already in flight) and keep the highest real version.
  if (!isSuspect(first.result, installedVersion)) return first
  const all = await Promise.all(probes)
  const best = bestAnswer(all.filter((answer) => answer.result.error === undefined))
  return best ?? first
}

/** A placeholder version npm creates while a package has no real release yet. */
function isPlaceholder(version, result) {
  return result?.stubLatest === true && version !== undefined
}

/**
 * Whether an answer should not be trusted as the final word.
 * @param result - one registry's probe result.
 * @param installedVersion - the version on disk, when known.
 */
function isSuspect(result, installedVersion) {
  const latest = result?.latest
  if (latest === undefined) return false
  if (isPlaceholder(latest, result)) return true
  // A registry claiming something older than what is installed is stale by
  // definition; the installed version came from a registry in the first place.
  return installedVersion !== undefined
    && semver.valid(installedVersion) !== null
    && semver.valid(latest) !== null
    && semver.lt(latest, installedVersion)
}

/** Pick the highest real release among several answers, ignoring placeholders. */
function bestAnswer(answers) {
  const real = answers.filter((answer) => !isPlaceholder(answer.result.latest, answer.result))
  const pool = real.length > 0 ? real : answers
  let best
  for (const answer of pool) {
    const latest = answer.result.latest
    if (latest === undefined) continue
    if (best === undefined) { best = answer; continue }
    if (semver.valid(latest) !== null && semver.valid(best.result.latest) !== null) {
      if (semver.gt(latest, best.result.latest)) best = answer
    }
  }
  return best
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
    // npm writes a stub version (0.0.0-stage) for a package whose first real
    // release has not landed yet; it is a placeholder, not a release.
    const stubLatest = distTags?.latest !== undefined && data?.versions?.[distTags.latest]?.stub === true
    return { latest: distTags?.latest, versions, stubLatest }
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
