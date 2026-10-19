#!/usr/bin/env node
/**
 * Parity test for the compatibility verdict.
 *
 * The plugin reimplements @deepseek-ai/dsh-app-boot's evaluatePluginCompatibility
 * so the panel can show the same verdict the launcher applies at boot. A
 * reimplementation is only worth anything if it agrees with the original, so
 * this test pins the launcher's rules as a table:
 *
 *   - engines.dsh decides ALONE; when present, peerDependencies are ignored
 *   - otherwise only @deepseek-ai/dsh and @deepseek-ai/dsh-* peers are checked
 *   - ranges are compared with includePrerelease: true
 *   - no declaration at all => compatible (nothing to check)
 *
 * The `engines.dsh` rule used to be missing here. The checker looked only at
 * peers, so a bundle that moved its requirement onto engines.dsh was shown as
 * "compatible" even when the launcher would skip it. That is the bug this test
 * exists to keep fixed.
 *
 * When a DSH profile is present, the same table is also run through app-boot's
 * real function and the two verdicts must agree; in CI (no profile) that
 * cross-check is skipped and the table alone decides.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { evaluatePluginCompatibility } from '../lib/host/update-checker.js'

const require = createRequire(import.meta.url)

const manifest = (extra) => ({ name: 'demo', version: '1.0.0', ...extra })

/** [label, manifest, runtime, expectedCompatible] */
const CASES = [
  ['no declaration at all', manifest({}), '0.2.1-rc.2', true],
  ['peers satisfied', manifest({ peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-0' } }), '0.2.1-rc.2', true],
  ['peers unsatisfied', manifest({ peerDependencies: { '@deepseek-ai/dsh': '^0.3.0-0' } }), '0.2.1-rc.2', false],
  ['non-dsh peer ignored', manifest({ peerDependencies: { '@deepseek-ai/schemastery': '^99.0.0' } }), '0.2.1-rc.2', true],
  ['engines.dsh satisfied', manifest({ engines: { dsh: '>=0.2.0-0 <0.3.0-0' } }), '0.2.1-rc.2', true],
  ['engines.dsh unsatisfied', manifest({ engines: { dsh: '^0.3.0-0' } }), '0.2.1-rc.2', false],
  // The decisive one: engines wins even when the peers would fail.
  ['engines wins over failing peers',
    manifest({ engines: { dsh: '>=0.2.0-0 <0.3.0-0' }, peerDependencies: { '@deepseek-ai/dsh': '^0.3.0-0' } }),
    '0.2.1-rc.2', true],
  ['engines fails even when peers would pass',
    manifest({ engines: { dsh: '^0.3.0-0' }, peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-0' } }),
    '0.2.1-rc.2', false],
  ['empty engines range is unmet', manifest({ engines: { dsh: '  ' } }), '0.2.1-rc.2', false],
  ['prerelease range matches prerelease runtime',
    manifest({ peerDependencies: { '@deepseek-ai/dsh': '^0.2.0-rc.1' } }), '0.2.1-rc.2', true],
  ['workspace:* peer means the running runtime',
    manifest({ peerDependencies: { '@deepseek-ai/dsh': 'workspace:*' } }), '0.2.1-rc.2', true],
]

let failures = 0
for (const [label, m, runtime, expected] of CASES) {
  const verdict = evaluatePluginCompatibility(m, {}, runtime)
  const compatible = verdict === undefined
  if (compatible === expected) {
    console.log(`✔ ${label}  -> ${compatible ? 'compatible' : 'incompatible'}`)
  } else {
    failures += 1
    console.error(`✗ ${label}: expected ${expected ? 'compatible' : 'incompatible'}, got ${JSON.stringify(verdict)}`)
  }
}

// Cross-check against the launcher's own implementation when a profile exists.
const APP_BOOT = (() => {
  try { return require.resolve('@deepseek-ai/dsh-app-boot/lib/index.js') } catch { /* not installed here */ }
  return undefined
})() ?? [
  `${process.env.HOME}/.dsh/profiles/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`,
  `${process.env.HOME}/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`,
].find((p) => existsSync(p))

if (APP_BOOT === undefined) {
  console.log('\ncross-check: 跳过（未找到 @deepseek-ai/dsh-app-boot；CI 里属正常）')
} else {
  const host = await import(pathToFileURL(APP_BOOT).href)
  let checked = 0
  for (const [label, m, runtime] of CASES) {
    const ours = evaluatePluginCompatibility(m, {}, runtime) === undefined
    const theirs = host.evaluatePluginCompatibility(m, {}, runtime) === undefined
    checked += 1
    if (ours !== theirs) {
      failures += 1
      console.error(`✗ cross-check 不一致（${label}）：ours=${ours} launcher=${theirs}`)
    }
  }
  console.log(`cross-check: ${checked} 条与 launcher 一致 ✅`)
}

if (failures > 0) {
  console.error(`\n${failures} 处不一致`)
  process.exit(1)
}
console.log('\n全部通过 ✅ compat-parity')
