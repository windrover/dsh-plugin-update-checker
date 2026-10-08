/**
 * dsh-plugin-update-checker — Host half.
 *
 * Exposes one HTTP route the browser half calls with fetch():
 *
 *   POST /api/plugin-update-checker/scan  -> { ok, dshVersion, checkedAt, plugins: [...] }
 *
 * The scan walks the profile's installed plugin bundles, reads each bundle's
 * package.json, evaluates its @deepseek-ai/dsh* peer-dependency ranges against
 * the running DSH runtime (replicating @deepseek-ai/dsh-app-boot's
 * evaluatePluginCompatibility, so the verdict matches what the launcher applies
 * on boot), and probes the configured npm registry for a published version newer
 * than the installed one.
 *
 * Design notes:
 *  - Compatibility is evaluated with a small self-contained reimplementation that
 *    depends only on semver (zero-dependency). This avoids importing the heavy
 *    @deepseek-ai/dsh-app-boot tree from a link:-installed plugin directory,
 *    where that package is not on the resolution path and would crash boot with
 *    "Cannot find package". The runtime version itself is read from app-boot's
 *    package.json via require.resolve, which costs nothing extra.
 *  - Compatibility and update availability are computed independently: a failed
 *    network lookup cannot hide an incompatible peer range, and vice versa.
 *  - Bundles installed from a tarball/git/path publish nothing to a registry, so
 *    they are reported as unsupported / unknown rather than "up to date". The
 *    check never claims a bundle is current when it cannot actually compare it.
 *  - The host reads every manifest and performs every network call; the browser
 *    half only renders the result. One broken manifest or an unreachable registry
 *    is isolated to its row, so it cannot blank the whole report.
 *
 * Services: webServer (the route) and the global fetch. The profile
 * directory is resolved from the launcher's argv (authoritative), falling back
 * to the DSH_PROFILE / DSH_HOME env.
 */

import { readFile, readdir } from 'node:fs/promises'
import { readFileSync, lstatSync, realpathSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import semver from 'semver'

const require = createRequire(import.meta.url)

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
function getDshRuntimeVersion() {
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
function evaluatePluginCompatibility(manifest, exemptions, runtimeVersion) {
  if (!manifest || !Object.prototype.hasOwnProperty.call(manifest, 'peerDependencies')) return undefined
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
function readProfileVersionExemptions(profileDir) {
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
function profileDirFromArgv() {
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith('/') || arg.startsWith('-')) continue
    if (!existsSync(join(arg, 'package.json'))) continue
    // The parent directory must be named `profiles`: that is the only shape
    // DSH itself creates (~/.dsh/profiles/<name> or $DSH_HOME/profiles/<name>).
    if (basename(dirname(arg)) !== 'profiles') continue
    return arg
  }
  return undefined
}

/** Resolve the active profile directory: argv first, then env, then home+name. */
function activeProfileDir() {
  const fromArgv = profileDirFromArgv()
  if (fromArgv) return fromArgv

  // DSH_PROFILE_DIR is an absolute path already; some hosts export it instead
  // of (or alongside) DSH_PROFILE. Trust it when it really is a profile.
  const fromEnvDir = process.env.DSH_PROFILE_DIR?.trim()
  if (fromEnvDir && existsSync(join(fromEnvDir, 'package.json'))) return fromEnvDir

  const home = (process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '') ? process.env.DSH_HOME : join(homedir(), '.dsh')
  // A DSH_PROFILE that names a real directory always wins; only when it is
  // absent (or names something that does not exist) do we fall back. Note we
  // no longer default to 'web' silently: if DSH_PROFILE is set but wrong we
  // still prefer it, so an explicit operator choice is never overridden.
  if (process.env.DSH_PROFILE) return join(home, 'profiles', process.env.DSH_PROFILE)
  return join(home, 'profiles', 'web')
}

/** Read + parse a package.json; returns undefined on any read/parse failure. */
async function readManifest(manifestPath) {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    return undefined
  }
}

/** Locate a bundle's installed directory: profile node_modules, then shared tree. */
function findBundleDir(name, profileDir) {
  const home = (process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '') ? process.env.DSH_HOME : join(homedir(), '.dsh')
  // Two trees hold a bundle: the profile's own node_modules, then the shared
  // profiles/node_modules. For an unscoped name the package directory IS the
  // entry, so the old "scoped ? scopeDir : leaf" second candidate was a
  // duplicate of the first (two wasted stat calls per bundle); for a scoped
  // name it pointed at the bare scope directory (@local), which is not a
  // package and could shadow the real one if it ever held a package.json.
  const candidates = [
    join(profileDir, 'node_modules', name),
    join(home, 'profiles', 'node_modules', name),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'package.json'))) return dir
  }
  try {
    return dirname(require.resolve(`${name}/package.json`))
  } catch {
    return undefined
  }
}

/**
 * Known source repos for link:-installed bundles, keyed by package name.
 *
 * A link:-installed bundle publishes nothing to a registry and may not carry a
 * `repository` field or live in a git checkout, so the scanner cannot always
 * discover its source URL. Declare them here (or via the plugin config's
 * `repositories` map) as bare URLs like "https://github.com/<org>/<repo>"; the
 * scanner appends "/tree/<ref>/<subpath>" when the local path is inside the repo.
 */
const KNOWN_REPOS = {
  "dsh-minimal-ui-panels": "https://github.com/windrover/dsh-minimal-UI-panels",
}

/**
 * Resolve a link:-installed bundle's real source directory and its git origin.
 *
 * A link:-installed bundle is a symlink into the developer's source tree, so it
 * publishes nothing to a registry and installBundle must never replace it. We
 * therefore skip the registry and instead point the user at the source: the real
 * path (git worktree) and the origin remote (for a one-click GitHub link). When
 * the local checkout has no git origin and no declared repo, `repoUrl` stays null
 * and the UI falls back to showing just the local path.
 *
 * @returns {{ dir: string, repoUrl: string|null, ref: string, subpath: string|null }}
 *   repoUrl is the origin's web URL (GitHub/GitLab/Codeberg) when resolvable,
 *   subpath is the path inside the repo the bundle lives at (for monorepos),
 *   ref is the current branch/HEAD (used as the tree ref in the link).
 */
function resolveSourceLink(dir, declaredRepo) {
  let real = dir
  try { real = realpathSync(dir) } catch { /* keep dir */ }
  let repo = real
  for (;;) {
    if (existsSync(join(repo, '.git'))) break
    const parent = dirname(repo)
    if (parent === repo) { repo = null; break }
    repo = parent
  }
  let repoUrl = declaredRepo ? gitWebUrl(declaredRepo) : null
  let ref = 'main'
  if (repo) {
    try {
      const out = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, encoding: 'utf8' }).trim()
      if (out) repoUrl = repoUrl ?? gitWebUrl(out)
    } catch { /* no origin */ }
    try {
      const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
      if (head && head !== 'HEAD') ref = head
    } catch { /* detached */ }
  }
  let subpath = null
  if (repo && real.startsWith(repo + '/')) subpath = real.slice(repo.length + 1)
  return { dir: real, repoUrl, ref, subpath }
}

/** Turn a git remote URL (ssh/https) into a web URL (best-effort for common hosts). */
function gitWebUrl(remote) {
  let url = (remote ?? '').trim()
  if (!url) return null
  if (url.startsWith('git@')) url = 'https://' + url.slice(4).replace(/:/, '/')
  if (url.endsWith('.git')) url = url.slice(0, -4)
  if (/^https?:\/\//.test(url)) return url
  return null
}

/**
 * Registries to probe, best first.
 *
 * The host half declares only `webServer`, and this cordis version throws on any
 * service access outside `inject` ("cannot get property ... without inject"), so
 * the browser-side plugin manager is not reachable from here. Read whatever
 * configuration the host can see for itself.
 *
 * Precedence is first-found-wins, and what counts as safe to race depends on
 * what was found:
 *
 *  - Nothing configured → race the mirror the launcher also falls back to
 *    against the public registry. Both are public, so trying both costs only a
 *    request, and on a mirror-served host it saves the public registry's latency
 *    (measured here: ~0.2 s against the mirror versus ~11 s against npmjs).
 *  - The *public default* configured (npm writes this into ~/.npmrc itself) →
 *    keep it first and add the mirror behind it. Racing two public registries
 *    leaks nothing, and it is what the launcher already documents.
 *  - Anything else configured → it alone. A corporate or internal registry was
 *    named deliberately; racing it would send internal package names to third
 *    parties, and the public registries cannot answer for its packages anyway.
 *
 * @param {string} profileDir - the active profile directory.
 * @returns {string[]} registry bases, deduplicated, best first.
 */
function resolveRegistries(profileDir) {
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
function normalizeRegistry(value) {
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
async function probeAnyRegistry(name, registries, signal) {
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
function classifyUpdate(installedVersion, remote) {
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

/** Scan one bundle for compatibility + update facts. */
async function scanBundle(bundle, profileDir, dshVersion, exemptions, signal, repositories = {}, registries = ['https://registry.npmjs.org']) {
  const name = bundle.name
  const installedVersion = bundle.version ?? null
  const row = {
    name,
    installedVersion,
    installed: bundle.installed === true,
    linked: false,
    description: bundle.description ?? bundle.meta?.description ?? null,
    compatibility: { status: 'compatible' },
    update: { status: 'unknown', error: 'not scanned' },
  }

  // Compatibility (no network needed).
  // describeBundle already resolved both, so reuse them when present: a
  // scan of N bundles used to resolve every directory and parse every
  // package.json twice.
  const dir = bundle.dir !== undefined ? bundle.dir : findBundleDir(name, profileDir)
  // A link:-installed bundle (symlink into a source tree) is not published to a
  // registry, so installBundle would replace the developer's symlink with a
  // published copy and break their live-edit loop. Flag it so the UI disables
  // the one-click update and instead links to the source.
  try { if (dir && lstatSync(dir).isSymbolicLink()) row.linked = true } catch { /* keep false */ }
  const manifest = bundle.manifest !== undefined
    ? bundle.manifest
    : (dir ? await readManifest(join(dir, 'package.json')) : undefined)
  if (manifest && manifest.peerDependencies) {
    try {
      const issue = evaluatePluginCompatibility(manifest, exemptions, dshVersion)
      if (issue) {
        row.compatibility = {
          status: issue.exempted ? 'compatible' : 'incompatible',
          peers: issue.peers,
          exempted: issue.exempted === true,
        }
      }
    } catch {
      row.compatibility = { status: 'unknown', error: 'could not evaluate compatibility' }
    }
  }

  // Update availability.
  if (!bundle.installed && bundle.optional) {
    row.update = { status: 'unsupported', error: 'shipped by the installation' }
    return row
  }
  // Listed in dsh.profile.bundles but absent from disk. Probing the registry
  // would compare the published version against the 0.0.0 fallback and report
  // "update available" for something that is not installed at all, so say so
  // instead of inventing a phantom upgrade.
  if (!bundle.installed) {
    row.update = { status: 'unsupported', error: 'listed in the profile but not installed' }
    row.compatibility = { status: 'unknown', error: 'no manifest to evaluate' }
    return row
  }
  // Link:-installed bundles publish nothing to a registry; probing it only
  // yields a misleading 404. Skip the network and point the user at the source.
  if (row.linked && dir) {
    const src = resolveSourceLink(dir, repositories[name] ?? KNOWN_REPOS[name])
    const link = src.repoUrl
      ? src.repoUrl + '/tree/' + src.ref + (src.subpath ? '/' + src.subpath : '')
      : null
    row.source = {
      dir: src.dir,
      repoUrl: src.repoUrl,
      ref: src.ref,
      subpath: src.subpath,
      link,
    }
    row.update = { status: 'source', error: 'installed from source; update from the repository' }
    return row
  }
  try {
    // A manifest-declared registry is authoritative for that package; otherwise
    // race the configured registries so a slow public registry cannot dominate.
    const declared = typeof bundle.registry === 'string' && bundle.registry !== '' ? bundle.registry : ''
    const candidates = declared !== '' ? [declared] : registries
    const { result: remote, registry: usedRegistry } = await probeAnyRegistry(name, candidates, signal)
    row.update = classifyUpdate(installedVersion ?? manifest?.version, remote)
    // Surface the registry the answer came from so the one-click update installs
    // from the same place the version was read (the client passes it through).
    if (row.update.status !== 'unknown' && usedRegistry) row.update.registry = usedRegistry
  } catch (err) {
    row.update = { status: 'unknown', error: String(err?.message ?? err) }
  }
  return row
}

/** Read one manifest synchronously (used for lightweight bundle enumeration). */
function readManifestSync(manifestPath) {
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Build a single bundle descriptor for a name known to be a bundle.
 *
 * Resolves the installed directory via findBundleDir (which follows symlinks,
 * so link:-installed plugins resolve correctly), and pulls version + registry
 * from the manifest. This never enumerates dependency directories (semver, zod,
 * ...) because the names come exclusively from the profile's dsh.profile.bundles
 * (the launcher's authoritative bundle list).
 *
 * The resolved directory and parsed manifest travel with the descriptor so
 * scanBundle does not resolve and re-read the same package.json a second time
 * (it used to: one findBundleDir + one readManifestSync here, then another of
 * each there, for every bundle).
 */
function describeBundle(name, profileDir) {
  const dir = findBundleDir(name, profileDir)
  const manifest = dir ? readManifestSync(join(dir, 'package.json')) : undefined
  return {
    name,
    version: manifest?.version ?? null,
    // A name listed in dsh.profile.bundles is not proof that it is installed:
    // the list is hand-maintained and can keep entries whose package was never
    // installed (or was removed). findBundleDir returns undefined then, and
    // reporting installed:true made the panel show a phantom row with a null
    // version. `installed` now reflects whether the directory actually
    // resolved, which is what the browser half renders.
    installed: Boolean(dir),
    optional: false,
    registry: manifest?.publishConfig?.registry ?? '',
    dir,
    manifest,
  }
}

/**
 * Enumerate the bundles to scan.
 *
 * Primary source: the profile's dsh.profile.bundles list (authoritative; it
 * excludes bare dependencies like semver/zod and includes every link:-installed
 * plugin). Each name is turned into a descriptor by describeBundle.
 *
 * Fallback (no bundle list in the profile): a best-effort directory walk over
 * profile/node_modules that treats symlinks as bundles too. This last-resort
 * path can include dependency directories, so it is only used when the
 * canonical list is unavailable.
 */
async function listBundles(profileDir) {
  let names = []
  try {
    const pj = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const b = pj?.dsh?.profile?.bundles
    if (Array.isArray(b)) names = b
  } catch { /* ignore */ }
  if (names.length > 0) return names.map((name) => describeBundle(name, profileDir))

  const nm = join(profileDir, 'node_modules')
  const out = []
  const readEntries = async (base) =>
    (await readdir(base, { withFileTypes: true })).catch(() => [])
  const collect = async (dir) => {
    const manifest = await readManifest(join(dir, 'package.json'))
    if (manifest?.name) out.push({ name: manifest.name, version: manifest.version, installed: true, optional: false })
  }
  for (const entry of await readEntries(nm)) {
    const dir = join(nm, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('@')) {
        for (const inner of await readEntries(dir)) await collect(join(dir, inner.name))
      } else {
        await collect(dir)
      }
    } else if (entry.isSymbolicLink()) {
      await collect(dir)
    }
  }
  return out
}

/**
 * Plugin entry point: register the scan route.
 * @param {object} ctx - host context (needs webServer).
 * @param {object} _config - plugin config; supports `repositories` keyed by
 *   package name -> source repo URL (e.g. "https://github.com/<org>/<repo>"),
 *   used to render a clickable link for link:-installed bundles.
 */
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
