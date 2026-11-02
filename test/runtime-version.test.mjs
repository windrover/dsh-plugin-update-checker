#!/usr/bin/env node
/**
 * Pin how the host half decides which DSH runtime version it is running under.
 *
 * The bug this exists for: inside the Electron desktop app the runtime is packed
 * into `app.asar`, while `require.resolve('@deepseek-ai/dsh-app-boot/package.json')`
 * — and every ancestor walk after it — lands in the npm-installed CLI tree at
 * `~/.dsh/profiles/node_modules`. The panel therefore reported 0.2.1-rc.2 while
 * running under 0.2.1-rc.5, offered a "runtime update" to the version already
 * installed, and evaluated every plugin's compatibility against the wrong release.
 *
 * The contract now:
 *   1. DSH_VERSION wins when it is a valid semver (an explicit launcher override);
 *   2. otherwise the desktop carrier's own descriptor
 *      (`<resources>/app.asar/dsh/desktop-runtime.json` → release.version) wins;
 *   3. only then the module lookups / ancestor walks the CLI relies on;
 *   4. a relayed `?runtime=` is validated as semver before it is used at all.
 *
 * Run: node test/runtime-version.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dsh = await import('../lib/host/dsh.js')

const root = mkdtempSync(join(tmpdir(), 'uc-runtime-'))

// A fake desktop carrier: <resources>/app.asar/dsh/desktop-runtime.json — the
// same shape the real App ships (release.version is the running runtime).
const resources = join(root, 'Resources')
mkdirSync(join(resources, 'app.asar', 'dsh'), { recursive: true })
writeFileSync(join(resources, 'app.asar', 'dsh', 'desktop-runtime.json'), JSON.stringify({
  schemaVersion: 1,
  release: { version: '0.2.1-rc.5', nodeVersion: '24.21.0', pnpmVersion: '11.28.5' },
}), 'utf8')

// A fake profile whose shared tree names yet another version, to prove the
// ancestor-walk fallback still works when the desktop carrier is absent.
const profile = join(root, 'profile')
mkdirSync(join(profile, 'node_modules', '@deepseek-ai', 'dsh-app-boot'), { recursive: true })
writeFileSync(join(profile, 'package.json'), '{}', 'utf8')
writeFileSync(join(profile, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version: '9.9.9' }), 'utf8')

const saved = {
  resources: process.resourcesPath,
  version: process.env.DSH_VERSION,
  profileDir: process.env.DSH_PROFILE_DIR,
}
process.env.DSH_PROFILE_DIR = profile

const restore = () => {
  if (saved.resources === undefined) delete process.resourcesPath
  else process.resourcesPath = saved.resources
  if (saved.version === undefined) delete process.env.DSH_VERSION
  else process.env.DSH_VERSION = saved.version
  if (saved.profileDir === undefined) delete process.env.DSH_PROFILE_DIR
  else process.env.DSH_PROFILE_DIR = saved.profileDir
  rmSync(root, { recursive: true, force: true })
}

try {
  // ---- 1. the desktop descriptor is read and validated ----------------------
  delete process.env.DSH_VERSION
  delete process.resourcesPath
  assert.equal(dsh.readDesktopRuntimeVersion(), undefined,
    'no carrier resources -> not the desktop app')

  process.resourcesPath = resources
  assert.equal(dsh.readDesktopRuntimeVersion(), '0.2.1-rc.5',
    'the carrier descriptor names the running release')
  assert.equal(dsh.getDshRuntimeVersion(), '0.2.1-rc.5',
    'the descriptor beats the npm CLI tree — this is the bug that was fixed')

  // ---- 2. an explicit env override still wins ------------------------------
  process.env.DSH_VERSION = '0.2.1-rc.9'
  assert.equal(dsh.getDshRuntimeVersion(), '0.2.1-rc.9', 'DSH_VERSION wins when explicit and valid')

  // A non-semver env value is ignored rather than reported as a version.
  process.env.DSH_VERSION = 'not-a-version'
  assert.equal(dsh.getDshRuntimeVersion(), '0.2.1-rc.5', 'an invalid DSH_VERSION is ignored')

  // ---- 3. without a carrier the ancestor walk still answers ----------------
  delete process.env.DSH_VERSION
  delete process.resourcesPath
  assert.equal(dsh.readDesktopRuntimeVersion(), undefined)
  assert.equal(dsh.getDshRuntimeVersion(), '9.9.9',
    'the profile tree fallback still works for the CLI')

  // ---- 4. a relayed ?runtime= is validated, never trusted blindly ---------
  const req = (url) => ({ url })
  assert.equal(dsh.runtimeVersionFromRequest(req('/api/plugin-update-checker/scan?runtime=0.2.1-rc.5')), '0.2.1-rc.5')
  assert.equal(dsh.runtimeVersionFromRequest(req('/api/plugin-update-checker/scan?runtime=not-a-version')), undefined,
    'a non-semver relay is dropped')
  assert.equal(dsh.runtimeVersionFromRequest(req('/api/plugin-update-checker/scan')), undefined)
  assert.equal(dsh.runtimeVersionFromRequest({}), undefined, 'no url (unit tests, HEAD probes) is fine')
  assert.equal(dsh.runtimeVersionFromRequest(undefined), undefined)
  assert.equal(dsh.runtimeVersionFromRequest(req(`/x?runtime=${'9'.repeat(80)}`)), undefined,
    'oversized values are rejected before parsing')

  console.log('ok: runtime-version resolution contract holds')
  console.log('  - desktop carrier descriptor wins over the npm CLI tree')
  console.log('  - DSH_VERSION wins when valid; invalid values are ignored')
  console.log('  - profile-tree walk still answers for the CLI')
  console.log('  - relayed ?runtime= is semver-validated')
} finally {
  restore()
}
