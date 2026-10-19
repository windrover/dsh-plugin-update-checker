/**
 * dsh-plugin-update-checker — host/scan.js
 *
 * 由 lib/host/update-checker.js 按下述职责拆出（函数体逐字保留）：
 *   scanBundle
 */
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { isRuntimePackage, evaluatePluginCompatibility } from './dsh.js'
import { readManifest, findBundleDir, KNOWN_REPOS, resolveSourceLink } from './profile.js'
import { probeAnyRegistry, classifyUpdate } from './registry.js'

export async function scanBundle(bundle, profileDir, dshVersion, exemptions, signal, repositories = {}, registries = ['https://registry.npmjs.org']) {
  const name = bundle.name
  const installedVersion = bundle.version ?? null

  // The @deepseek-ai/dsh* packages are the runtime, symlinked into the shared
  // tree from the runtime install. They are not user plugins and must not be
  // treated as source-links or independently updatable bundles. The runtime is
  // checked once, as a unit, by checkDshRuntime (which the route appends as the
  // 'dsh-runtime' row). Report the runtime packages themselves as a thin,
  // inert row so they neither blank the report nor invite a misleading
  // "update from the repository" action.
  if (isRuntimePackage(name)) {
    return {
      name,
      installedVersion,
      installed: bundle.installed === true,
      linked: false,
      description: bundle.description ?? bundle.meta?.description ?? null,
      compatibility: { status: 'compatible' },
      update: { status: 'part-of-runtime', error: 'part of the DSH runtime; checked as a unit' },
    }
  }
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
  // Always evaluate: the launcher does. Gating on peerDependencies meant a
  // manifest that declares only engines.dsh was never evaluated here, so the
  // row kept its default "compatible" even when the launcher would skip it.
  if (manifest) {
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
    // The installed version lets the race spot a stale mirror instead of
    // reporting "up to date" from an answer older than what is on disk.
    const { result: remote, registry: usedRegistry } =
      await probeAnyRegistry(name, candidates, signal, installedVersion ?? manifest?.version)
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
