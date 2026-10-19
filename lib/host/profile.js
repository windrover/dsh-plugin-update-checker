/**
 * dsh-plugin-update-checker — host/profile.js
 *
 * 由 lib/host/update-checker.js 按下述职责拆出（函数体逐字保留）：
 *   profileDirFromArgv, activeProfileDir, readManifest, readManifestSync, findBundleDir, KNOWN_REPOS, resolveSourceLink, gitWebUrl, describeBundle, listBundles
 */
import { readFile, readdir } from 'node:fs/promises'
import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

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
export function activeProfileDir() {
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
export async function readManifest(manifestPath) {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    return undefined
  }
}

/** Locate a bundle's installed directory: profile node_modules, then shared tree. */
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
export function findBundleDir(name, profileDir) {
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
export const KNOWN_REPOS = {
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
export function resolveSourceLink(dir, declaredRepo) {
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
export async function listBundles(profileDir) {
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
