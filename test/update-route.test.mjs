#!/usr/bin/env node
/**
 * Route-level test for POST /api/plugin-update-checker/update.
 *
 * The orchestration has its own test (update.test.mjs); this one drives the
 * registered handler end to end, because that is where three things live that
 * the unit test cannot see:
 *
 *   1. the manager is looked up at request time (`ctx.get('pluginManager')`) and
 *      a host without it must fail closed with a machine code, not a 500;
 *   2. the body is validated before anything touches the profile;
 *   3. a manager that reports `applied` while writing nothing is caught by
 *      reading the installed version back off disk — the exact "profile
 *      unchanged" shape that started this.
 *
 * The manager is fake and no network is reached: scan is never called here.
 *
 * Run: node test/update-route.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --- fixture profile -------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'uc-update-'))
const profile = join(root, 'profiles', 'bench')
const bundleDir = join(profile, 'node_modules', 'dsh-context')
mkdirSync(bundleDir, { recursive: true })
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'bench-profile', version: '0.0.0',
  dependencies: { 'dsh-context': '0.73.3' },
  dsh: { profile: { bundles: ['dsh-context'] } },
}, null, 2), 'utf8')
writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({ name: 'dsh-context', version: '0.73.3', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2), 'utf8')

process.env.DSH_PROFILE_DIR = profile
process.env.DSH_VERSION = '0.2.1-rc.2'

const onDisk = () => JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')).version
const writeOnDisk = (version) => writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({ name: 'dsh-context', version, dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2), 'utf8')

const { apply } = await import('../lib/host/update-checker.js')

// --- harness ---------------------------------------------------------------
function boot(manager) {
  const routes = []
  const ctx = {
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: (name) => (name === 'pluginManager' ? manager : undefined),
    inject(_deps, cb) { cb(this) },
  }
  apply(ctx, {})
  const route = routes.find((r) => String(r.path).endsWith('/update'))
  assert.ok(route, 'the update route must be registered')
  return route
}

/** The web server hands the handler a raw Node request stream. */
function request(method, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {})
  return {
    method,
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(text) },
  }
}

async function call(route, method, body) {
  const res = {
    statusCode: 200, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    end(payload) { this.body = payload },
  }
  await route.handler(request(method, body), res)
  return { status: res.statusCode, body: res.body === undefined ? undefined : JSON.parse(res.body) }
}

/** A manager whose install rewrites the manifest, unless told otherwise. */
function manager(options = {}) {
  const calls = []
  const installs = [...(options.installs ?? [])]
  return {
    calls,
    async installBundle(spec, opts) {
      calls.push({ method: 'installBundle', spec, opts })
      const scripted = installs.length > 0 ? installs.shift() : { application: 'applied', changed: true }
      if (scripted.write !== false) writeOnDisk(spec.slice(spec.indexOf('@', 1) + 1))
      return scripted
    },
    async removeBundle(name) {
      calls.push({ method: 'removeBundle', name })
      return options.remove ?? { application: 'applied', changed: true }
    },
  }
}

try {
  // ---- method guard ------------------------------------------------------
  {
    const route = boot(manager())
    const { status, body } = await call(route, 'GET')
    assert.equal(status, 405)
    assert.equal(body.ok, false)
  }

  // ---- malformed body / invalid request ---------------------------------
  {
    const route = boot(manager())
    const broken = await call(route, 'POST', '{not json')
    assert.equal(broken.status, 400, 'unparsable JSON is a client error')
    assert.match(broken.body.error, /bad request body/)

    const tagged = await call(route, 'POST', { name: 'dsh-context', version: 'latest' })
    assert.equal(tagged.status, 400)
    assert.equal(tagged.body.error, 'version must be a semantic version')

    const traversal = await call(route, 'POST', { name: '../../etc/passwd', version: '1.0.0' })
    assert.equal(traversal.status, 400)
  }

  // ---- no manager service ------------------------------------------------
  {
    const route = boot(undefined)
    const { status, body } = await call(route, 'POST', { name: 'dsh-context', version: '0.74.0' })
    assert.equal(status, 503)
    assert.equal(body.code, 'no-plugin-manager')
    assert.equal(onDisk(), '0.73.3', 'the profile is untouched')
  }

  // ---- happy path --------------------------------------------------------
  {
    const mgr = manager()
    const route = boot(mgr)
    const { status, body } = await call(route, 'POST', { name: 'dsh-context', version: '0.74.0' })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.application, 'applied')
    assert.equal(body.installedVersion, '0.74.0', 'the version is read back from disk')
    assert.deepEqual(body.steps, ['install'])
    assert.equal(mgr.calls[0].spec, 'dsh-context@0.74.0')
  }

  // ---- the desktop shape: already-installed -> remove -> install --------
  {
    writeOnDisk('0.73.3')
    const mgr = manager({
      installs: [{ application: 'failed', error: { code: 'already-installed', message: 'dsh-context is already installed' } }],
    })
    const route = boot(mgr)
    const { body } = await call(route, 'POST', { name: 'dsh-context', version: '0.74.0' })
    assert.equal(body.ok, true, 'the update succeeds once the old copy is removed')
    assert.deepEqual(body.steps, ['install', 'remove', 'install-after-remove'])
    assert.deepEqual(mgr.calls.map((c) => c.method), ['installBundle', 'removeBundle', 'installBundle'])
    assert.equal(onDisk(), '0.74.0')
  }

  // ---- applied but nothing written: the "profile unchanged" case --------
  {
    writeOnDisk('0.73.3')
    const mgr = manager({ installs: [{ application: 'applied', changed: false, write: false }] })
    const route = boot(mgr)
    const { body } = await call(route, 'POST', { name: 'dsh-context', version: '0.74.0' })
    assert.equal(body.ok, false)
    assert.equal(body.code, 'unchanged', 'the disk is the authority, not the manager\'s verdict')
    assert.match(body.message, /still 0\.73\.3/)
    assert.equal(onDisk(), '0.73.3')
  }

  // ---- a plain failure keeps its stage and code ------------------------
  {
    writeOnDisk('0.73.3')
    const mgr = manager({
      installs: [{
        application: 'failed',
        error: { code: 'not-found', message: 'no matching version' },
        packageResult: { output: 'ERR_PNPM_NO_MATCHING_VERSION  No matching version found for dsh-context@0.99.0' },
      }],
    })
    const route = boot(mgr)
    const { body } = await call(route, 'POST', { name: 'dsh-context', version: '0.99.0' })
    assert.equal(body.ok, false)
    assert.equal(body.stage, 'install')
    assert.equal(body.code, 'not-found')
    assert.match(body.output, /ERR_PNPM_NO_MATCHING_VERSION/)
  }

  console.log('ok: update route (validation, manager lookup, remove-then-install, disk verification)')
} finally {
  rmSync(root, { recursive: true, force: true })
}
