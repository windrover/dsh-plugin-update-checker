#!/usr/bin/env node
/**
 * Route-level test for POST /api/plugin-update-checker/scan.
 *
 * The other tests either pin helper contracts or just load the module; none
 * drives the actual handler end to end. This one builds a throwaway profile on
 * disk, stubs the network, calls the registered handler and asserts the JSON the
 * browser half renders.
 *
 * It also pins two bugs that only appear on this path:
 *   1. compatibility used to be evaluated only when the manifest declared
 *      peerDependencies, so an engines.dsh-only manifest kept the row's default
 *      "compatible" even when the launcher would skip it;
 *   2. the engines.dsh rule itself (peers are ignored when it is present).
 *
 * Network is fully stubbed: no test may touch a real registry.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RUNTIME = '0.2.1-rc.2'
const REGISTRY = 'https://registry.test'

// --- fixture profile -------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'uc-scan-'))
const profile = join(root, 'profiles', 'bench')
const bundlesDir = join(profile, 'node_modules')
mkdirSync(bundlesDir, { recursive: true })
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'bench-profile', version: '0.0.0',
  dsh: { profile: { bundles: ['ok-bundle', 'engines-ok', 'engines-bad'] } },
}, null, 2), 'utf8')

const writeBundle = (name, manifest) => {
  const dir = join(bundlesDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8')
}
writeBundle('ok-bundle', { name: 'ok-bundle', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0-0' } })
// engines.dsh only — this is the shape the old code never evaluated.
writeBundle('engines-ok', { name: 'engines-ok', version: '2.0.0', engines: { dsh: '>=0.2.0-0 <0.3.0-0' } })
writeBundle('engines-bad', { name: 'engines-bad', version: '3.0.0', engines: { dsh: '^0.3.0-0' } })

// --- environment the host half reads --------------------------------------
process.env.DSH_PROFILE_DIR = profile
process.env.DSH_VERSION = RUNTIME
process.env.npm_config_registry = REGISTRY
process.env.NPM_CONFIG_REGISTRY = REGISTRY

// --- stub the network ------------------------------------------------------
const realFetch = globalThis.fetch
const fetched = []
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input)
  fetched.push(url)
  const json = (body) => ({ ok: true, status: 200, async json() { return body }, async text() { return JSON.stringify(body) } })
  // Registry probe: /<package name>
  if (url.startsWith(REGISTRY)) {
    const name = url.slice(REGISTRY.length + 1).split('/').pop()
    return json({ 'dist-tags': { latest: name === 'ok-bundle' ? '1.2.0' : '9.9.9' } })
  }
  return json({})
}

// --- drive the handler -----------------------------------------------------
const { apply } = await import('../lib/host/update-checker.js')

const routes = []
const ctx = {
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  get: () => undefined,
  inject(_deps, cb) { cb(this) },
}
apply(ctx, {})

const route = routes.find((r) => String(r.path).includes('scan'))
assert.ok(route, 'scan route must be registered')

const call = async (method) => {
  const res = {
    statusCode: 200, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    end(body) { this.body = body },
    writableEnded: false,
  }
  await route.handler({ method, socket: { remoteAddress: '127.0.0.1' }, headers: {} }, res)
  return { status: res.statusCode, body: JSON.parse(res.body) }
}

try {
  // Method guard.
  const wrong = await call('GET')
  assert.equal(wrong.status, 405, 'GET must be rejected with 405')
  assert.equal(wrong.body.ok, false)

  // Happy path.
  const { status, body } = await call('POST')
  assert.equal(status, 200, 'POST must answer 200')
  assert.equal(body.ok, true)
  assert.equal(body.dshVersion, RUNTIME, 'dshVersion must come from the resolved runtime')

  const byName = Object.fromEntries((body.plugins ?? []).map((p) => [p.name, p]))
  assert.ok(byName['ok-bundle'], 'ok-bundle must be scanned')
  assert.equal(byName['ok-bundle'].compatibility.status, 'compatible')
  assert.equal(byName['ok-bundle'].installedVersion, '1.0.0')
  assert.equal(byName['ok-bundle'].update.status, 'update-available')
  assert.equal(byName['ok-bundle'].update.latest ?? byName['ok-bundle'].update.version, '1.2.0')

  // engines.dsh satisfied -> compatible.
  assert.equal(byName['engines-ok'].compatibility.status, 'compatible')

  // engines.dsh unsatisfied -> incompatible. This is the row the old gate never
  // evaluated, so it used to report "compatible" here.
  assert.equal(byName['engines-bad'].compatibility.status, 'incompatible',
    'an engines.dsh mismatch must surface as incompatible')
  assert.deepEqual(byName['engines-bad'].compatibility.peers, { 'engines.dsh': '^0.3.0-0' })

  assert.ok(fetched.length > 0, 'the scan must probe the configured registry')
  assert.ok(fetched.every((u) => u.startsWith(REGISTRY)), `no request may leave the stubbed registry: ${fetched.join(', ')}`)

  console.log(`✔ scan route: ${Object.keys(byName).length} rows, ${fetched.length} stubbed requests, method guard ok`)
} finally {
  globalThis.fetch = realFetch
  rmSync(root, { recursive: true, force: true })
}
