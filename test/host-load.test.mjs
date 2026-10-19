#!/usr/bin/env node
/**
 * Load-time smoke for the host half.
 *
 * Why this exists: the other four tests never import `../lib/host/*`, so a
 * broken import in the real code — a missing dependency, an ESM/CJS mistake, a
 * renamed helper — would not fail CI. It would fail in the user's app at boot,
 * which is the one place we cannot iterate quickly.
 *
 * This is the only test that needs `npm install` (the module imports semver).
 * It asserts the module loads and that `apply()` wires the scan route, using the
 * same host shapes the launcher exposes: `webServer` as a property, and
 * `ctx.effect(fn)` for lifecycle-bound registration.
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/host/update-checker.js'

assert.equal(typeof apply, 'function', 'host half must export apply()')

const routes = []
const disposers = []
const ctx = {
  // NOTE: property access, not ctx.get() — that is how apply() reads it, and
  // how some host facades expose it. Pinning it here keeps the variance honest.
  webServer: {
    register(route) {
      routes.push(route)
      const dispose = () => {}
      disposers.push(dispose)
      return dispose
    },
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  get() { return undefined },
  inject(_deps, cb) { cb(this) },
}

apply(ctx, {})

assert.ok(routes.length >= 1, `expected at least one route, got ${routes.length}`)
const scan = routes.find((r) => String(r.path).includes('scan'))
assert.ok(scan, `expected a scan route, got: ${routes.map((r) => r.path).join(', ')}`)
assert.equal(scan.kind, 'exact', 'scan route must be an exact match')
assert.equal(typeof scan.handler, 'function', 'scan route must expose a handler')
assert.equal(typeof ctx.webServer, 'object', 'webServer must remain a property')

console.log(`✔ host half loads and registers ${routes.length} route(s): ${routes.map((r) => r.path).join(', ')}`)
