/**
 * dsh-plugin-update-checker — host/dsh.js
 *
 * 由 lib/host/update-checker.js 按下述职责拆出（函数体逐字保留）：
 *   require, isRuntimePackage, getDshRuntimeVersion, evaluatePluginCompatibility, readProfileVersionExemptions
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { default as semver } from 'semver'
import { activeProfileDir } from './profile.js'

const require = createRequire(import.meta.url)

/**
 * Whether a bundle name belongs to the DSH *runtime* itself (as opposed to a
 * user-installed plugin).
 *
 * Every @deepseek-ai/dsh* package is part of the runtime the launcher boots
 * (dsh-base, dsh-web-app, dsh-app-boot, ...). The launcher symlinks them (it
 * does not copy them) into the shared profiles tree from the runtime install,
 * so the bundle scanner must NOT treat them as user source-links or as
 * independently updatable plugins. The runtime carries a single version, which
 * is checked as one unit (see checkDshRuntime), not bundle by bundle.
 */
export function isRuntimePackage(name) {
  return name === '@deepseek-ai/dsh' || (typeof name === 'string' && name.startsWith('@deepseek-ai/dsh-'))
}

/**
 * Running DSH runtime version.
 *
 * The launcher ships "@deepseek-ai/dsh-app-boot" whose own "version" equals the
 * running runtime. We read that JSON (never execute the module, because a
 * link-installed plugin cannot resolve "@deepseek-ai/*" from its own tree).
 *
 * Resolution strategy, most to least reliable:
 *   1. require.resolve("@deepseek-ai/dsh-app-boot/package.json") - works when the
 *      plugin is hoisted into the profile tree (the normal link case).
 *   2. Walk UP from this file's real path's directory ancestors for
 *      node_modules/@deepseek-ai/dsh-app-boot/package.json. Note we must convert
 *      import.meta.url (a file:// URL) with fileURLToPath first, otherwise the
 *      ancestor walk starts from a "file://..." string and never matches.
 *   3. Walk UP from the active profile's node_modules/@deepseek-ai/dsh-app-boot/
 *      package.json. The profile's shared tree is a DSH-maintained symlink that
 *      always points at the current runtime, so this is a reliable fallback for
 *      link:-installed plugins whose real path lives outside the profile tree.
 *   4. DSH_VERSION env (some launchers set it).
 */
export function getDshRuntimeVersion() {
  try {
    return JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh-app-boot/package.json'), 'utf8')).version
  } catch { /* fall through */ }

  const anchors = [
    dirname(fileURLToPath(import.meta.url)),
    activeProfileDir(),
  ]
  for (const start of anchors) {
    let dir = start
    for (;;) {
      const candidate = join(dir, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json')
      if (existsSync(candidate)) {
        try { return JSON.parse(readFileSync(candidate, 'utf8')).version } catch { /* keep walking */ }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return process.env.DSH_VERSION || '0.0.0'
}

/**
 * Reimplementation of @deepseek-ai/dsh-app-boot's evaluatePluginCompatibility
 * (read-only, no shared-state side effects). Returns undefined when compatible,
 * otherwise the { name, version, runtimeVersion, peers, exempted } shape the
 * browser half renders.
 */
export function evaluatePluginCompatibility(manifest, exemptions, runtimeVersion) {
  if (!manifest) return undefined

  // engines.dsh decides ALONE: when it is present the launcher ignores
  // peerDependencies entirely (dsh-app-boot's unmetRequirements returns the
  // engines verdict and never reaches the peer loop). Mirroring only the peer
  // branch made this checker disagree with the launcher for any plugin that
  // moved its requirement onto engines.dsh - it reported "compatible" for a
  // bundle the launcher would skip.
  const engines = manifest.engines
  if (engines !== null && typeof engines === 'object'
    && Object.prototype.hasOwnProperty.call(engines, 'dsh')) {
    const range = engines.dsh
    if (typeof range !== 'string') throw new Error('engines.dsh must be a string')
    const met = range.trim() !== ''
      && semver.satisfies(runtimeVersion, range, { includePrerelease: true })
    if (met) return undefined
    return {
      name: manifest.name,
      version: manifest.version,
      runtimeVersion,
      peers: { 'engines.dsh': range },
      exempted: false,
    }
  }

  if (!Object.prototype.hasOwnProperty.call(manifest, 'peerDependencies')) return undefined
  const dependencies = manifest.peerDependencies
  const peers = {}
  for (const [name, range] of Object.entries(dependencies)) {
    if (typeof range !== 'string') throw new Error(`peerDependencies[${JSON.stringify(name)}] must be a string`)
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtimeVersion : range
    if (requirement.trim() === '' || !semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) {
      peers[name] = range
    }
  }
  if (Object.keys(peers).length === 0) return undefined
  const name = manifest.name
  const version = manifest.version
  const key = `${name}@${version}`
  return {
    name,
    version,
    runtimeVersion,
    peers,
    exempted: (Object.prototype.hasOwnProperty.call(exemptions, key) ? exemptions[key] : undefined)?.includes(runtimeVersion) === true,
  }
}

/** Read the profile's version-exemption map from compatibility.json. */
export function readProfileVersionExemptions(profileDir) {
  try {
    const raw = JSON.parse(readFileSync(join(profileDir, 'compatibility.json'), 'utf8'))
    return raw?.exemptions ?? {}
  } catch {
    return {}
  }
}

/**
 * The profile directory the launcher passed on the command line, when we can
 * recognize it.
 *
 * The Electron desktop host does NOT export DSH_PROFILE into the host process
 * (only DSH_CLIENT_VERSION), so the old `process.env.DSH_PROFILE || 'web'`
 * fell back to 'web' and the scan silently reported the *web* profile's
 * plugins while the app was actually running *desktop*. The launcher does pass
 * the profile as an absolute path in argv (e.g.
 *   DeepSeek Harness --expose-internals <host.js> <app.asar/dsh>
 *     /Users/me/.dsh/profiles/desktop <runtime> ...),
 * so argv is the authoritative source: it is the same value the launcher used
 * to boot the runtime, not a guess.
 *
 * We only accept a candidate that (a) is absolute, (b) is not a flag, and
 * (c) sits directly under a `profiles` directory — so runtime, app.asar and
 * host.js paths never match. Returns undefined when nothing matches.
 */
