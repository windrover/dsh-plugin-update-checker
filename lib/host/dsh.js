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
 * Where the Electron desktop carrier keeps its resources, or undefined when this
 * is not the desktop app at all (plain `dsh web` / headless / tests).
 *
 * `process.resourcesPath` is set on Electron's main process; the utility /
 * ELECTRON_RUN_AS_NODE processes may omit it, so fall back to the conventional
 * layout next to `process.execPath` for both spellings macOS/Linux use.
 */
function desktopResourcesDir() {
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') return process.resourcesPath
  try {
    const beside = join(dirname(process.execPath), '..')
    for (const name of ['Resources', 'resources']) {
      const candidate = join(beside, name)
      if (existsSync(candidate)) return candidate
    }
  } catch { /* not Electron */ }
  return undefined
}

/**
 * The desktop carrier's own release descriptor: `<resources>/app.asar/dsh/
 * desktop-runtime.json` carries `release.version` (and the node/pnpm versions the
 * bundle was built with).
 *
 * This is the *only* source that is correct inside the Electron app. There the
 * runtime is packed into `app.asar`, while every `node_modules` lookup below
 * resolves the npm-installed CLI — which is exactly how this checker used to
 * report 0.2.1-rc.2 while the app it was running in was 0.2.1-rc.5. Reading the
 * descriptor needs Electron's asar-patched `fs`; under plain node the read fails
 * and the function says "not the desktop app".
 */
export function readDesktopRuntimeVersion() {
  const resources = desktopResourcesDir()
  if (resources === undefined) return undefined
  try {
    const release = JSON.parse(readFileSync(join(resources, 'app.asar', 'dsh', 'desktop-runtime.json'), 'utf8'))?.release
    if (typeof release?.version === 'string' && semver.valid(release.version) !== null) return release.version
  } catch { /* not the desktop app, or no descriptor in this build */ }
  return undefined
}

/**
 * A version the browser half relayed from the Host's own boot graph
 * (`window.__DSH_BOOT__.release.version` — the graph the Host itself composed and
 * injected). It is host truth travelling over the authenticated connection, but
 * it is still validated as semver and used only for reporting and compatibility
 * verdicts; it never selects what gets installed.
 */
export function runtimeVersionFromRequest(req) {
  if (typeof req?.url !== 'string') return undefined
  let raw
  try { raw = new URL(req.url, 'http://localhost').searchParams.get('runtime') } catch { return undefined }
  if (raw === null || raw.length > 64) return undefined
  return semver.valid(raw) ?? undefined
}

/**
 * Running DSH runtime version.
 *
 * The launcher ships "@deepseek-ai/dsh-app-boot" whose own "version" equals the
 * running runtime. We read that JSON (never execute the module, because a
 * link-installed plugin cannot resolve "@deepseek-ai/*" from its own tree).
 *
 * Resolution order, most to least trustworthy — the first two are the ones that
 * hold inside the desktop app, where the npm tree is NOT the running runtime:
 *   1. DSH_VERSION env: a launcher that knows its own version says so explicitly.
 *   2. The desktop carrier's descriptor (see readDesktopRuntimeVersion).
 *   3. require.resolve("@deepseek-ai/dsh-app-boot/package.json") - works when the
 *      plugin is hoisted into the profile tree (the normal CLI case).
 *   4. Walk UP from this file's real path's directory ancestors for
 *      node_modules/@deepseek-ai/dsh-app-boot/package.json. Note we must convert
 *      import.meta.url (a file:// URL) with fileURLToPath first, otherwise the
 *      ancestor walk starts from a "file://..." string and never matches.
 *   5. Walk UP from the active profile's node_modules/@deepseek-ai/dsh-app-boot/
 *      package.json. The profile's shared tree is a DSH-maintained symlink that
 *      points at the runtime install the CLI uses — reliable for the CLI, stale
 *      for the desktop app, which is why steps 1-2 come first.
 */
export function getDshRuntimeVersion() {
  const declared = process.env.DSH_VERSION
  if (typeof declared === 'string' && semver.valid(declared) !== null) return declared

  const carrier = readDesktopRuntimeVersion()
  if (carrier !== undefined) return carrier

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
  return '0.0.0'
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
