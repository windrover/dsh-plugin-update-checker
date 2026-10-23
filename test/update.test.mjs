#!/usr/bin/env node
/**
 * Contract test for the host half's update orchestration (lib/host/update.js).
 *
 * The bug this pins: dsh 0.2.1's plugin manager refuses `add` for a package that
 * is already a profile dependency (`ManagementFailure('already-installed')`,
 * before pnpm runs, whenever HMR is present — the desktop app always has HMR).
 * An update is exactly that shape, and the browser half's single `installBundle`
 * therefore changed nothing while reporting a failed application, which the
 * panel misread as the release-age policy. The update now has to become
 * remove-then-install.
 *
 * A fake manager keeps this honest: the points that matter are the call order,
 * which failures stop the sequence, and that this plugin never removes itself.
 *
 * Run: node test/update.test.mjs
 */
import assert from 'node:assert/strict'
import { parseUpdateRequest, performUpdate } from '../lib/host/update.js'

/** A manager whose answers are queued per method, recording every call. */
function fakeManager(answers) {
  const calls = []
  const take = (method) => {
    const queue = answers[method] ?? []
    assert.ok(queue.length > 0, `manager.${method} called more times than scripted`)
    const next = queue.shift()
    if (next instanceof Error) throw next
    return next
  }
  return {
    calls,
    installBundle: async (spec, options) => { calls.push({ method: 'installBundle', spec, options }); return take('installBundle') },
    removeBundle: async (name) => { calls.push({ method: 'removeBundle', name }); return take('removeBundle') },
  }
}

const SELF = 'dsh-plugin-update-checker'
const request = { name: 'dsh-context', version: '0.74.0' }

// ---- 1. a host without the already-installed refusal: one install ----------
{
  const manager = fakeManager({ installBundle: [{ application: 'applied', changed: true, version: '0.74.0' }] })
  const result = await performUpdate(manager, { ...request }, { selfName: SELF })
  assert.equal(result.ok, true)
  assert.deepEqual(result.steps, ['install'])
  assert.equal(result.restartRequired, false)
  assert.equal(manager.calls.length, 1, 'no removal when a plain install is accepted')
  assert.equal(manager.calls[0].spec, 'dsh-context@0.74.0', 'the spec is pinned to the exact version')
  assert.equal(manager.calls[0].options.enabled, true)
}

// ---- 2. the desktop shape: refused, removed, installed again --------------
{
  const manager = fakeManager({
    installBundle: [
      { application: 'failed', changed: false, error: { code: 'already-installed', message: 'dsh-context is already installed' } },
      { application: 'applied', changed: true, version: '0.74.0' },
    ],
    removeBundle: [{ application: 'applied', changed: true }],
  })
  const result = await performUpdate(manager, { ...request, registry: 'https://registry.npmmirror.com' }, { selfName: SELF })
  assert.equal(result.ok, true)
  assert.deepEqual(result.steps, ['install', 'remove', 'install-after-remove'])
  assert.deepEqual(manager.calls.map((c) => c.method), ['installBundle', 'removeBundle', 'installBundle'])
  assert.equal(manager.calls[1].name, 'dsh-context')
  assert.equal(manager.calls[2].spec, 'dsh-context@0.74.0', 'the reinstall names the same exact version')
  assert.equal(manager.calls[2].options.registry, 'https://registry.npmmirror.com', 'the registry hint survives the retry')
  assert.equal(result.removed, undefined, 'a successful reinstall is not a "removed" outcome')
}

// ---- 3. the refusal can also arrive as a throw ----------------------------
{
  const thrown = Object.assign(new Error('dsh-context is already installed'), { code: 'already-installed' })
  const manager = fakeManager({
    installBundle: [thrown, { application: 'restart-required', changed: true }],
    removeBundle: [{ application: 'restart-required', changed: true }],
  })
  const result = await performUpdate(manager, { ...request }, { selfName: SELF })
  assert.equal(result.ok, true)
  assert.equal(result.restartRequired, true, 'a restart-required apply is reported as such')
  assert.deepEqual(manager.calls.map((c) => c.method), ['installBundle', 'removeBundle', 'installBundle'])
}

// ---- 4. any other install failure stops before a removal ------------------
{
  const manager = fakeManager({
    installBundle: [{ application: 'failed', error: { code: 'incompatible-version', message: 'needs dsh ^0.3.0' } }],
  })
  const result = await performUpdate(manager, { ...request }, { selfName: SELF })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'install')
  assert.equal(result.code, 'incompatible-version')
  assert.equal(manager.calls.length, 1, 'a non already-installed failure must not remove anything')
}

// ---- 5. this plugin never removes itself ---------------------------------
{
  const manager = fakeManager({
    installBundle: [{ application: 'failed', error: { code: 'already-installed', message: 'already installed' } }],
  })
  const result = await performUpdate(manager, { name: SELF, version: '0.1.7' }, { selfName: SELF })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'self-update')
  assert.equal(result.spec, `${SELF}@0.1.7`)
  assert.equal(manager.calls.length, 1, 'removing the running bundle would take this route down with it')
  assert.deepEqual(manager.calls.map((c) => c.method), ['installBundle'])
}

// ---- 6. a refused removal is reported, and nothing is installed after -----
{
  const manager = fakeManager({
    installBundle: [{ application: 'failed', error: { code: 'already-installed', message: 'already installed' } }],
    removeBundle: [{ application: 'failed', error: { code: 'not-removable', message: 'shipped with the app' } }],
  })
  const result = await performUpdate(manager, { ...request }, { selfName: SELF })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'remove')
  assert.equal(result.code, 'not-removable')
  assert.deepEqual(manager.calls.map((c) => c.method), ['installBundle', 'removeBundle'])
}

// ---- 7. a failed reinstall says the old build is gone --------------------
{
  const manager = fakeManager({
    installBundle: [
      { application: 'failed', error: { code: 'already-installed', message: 'already installed' } },
      { application: 'failed', error: { code: 'not-found', message: 'no matching version' }, packageResult: { output: 'ERR_PNPM_NO_MATCHING_VERSION  No matching version found for dsh-context@0.74.0' } },
    ],
    removeBundle: [{ application: 'applied', changed: true }],
  })
  const result = await performUpdate(manager, { ...request }, { selfName: SELF })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'install-after-remove')
  assert.equal(result.removed, true, 'the caller needs to know the installed copy is gone')
  assert.match(result.message, /login|No matching version|no matching version/i)
  assert.match(result.output, /ERR_PNPM_NO_MATCHING_VERSION/)
}

// ---- 8. cancelled is a failure, not a success ---------------------------
{
  const manager = fakeManager({
    installBundle: [{ application: 'failed', error: { code: 'already-installed' } }],
    removeBundle: [{ application: 'cancelled' }],
  })
  const result = await performUpdate(manager, { ...request }, { selfName: SELF })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'remove')
}

// ---- 9. a manager without removeBundle fails closed ----------------------
{
  const manager = { installBundle: async () => ({ application: 'failed', error: { code: 'already-installed' } }) }
  const result = await performUpdate(manager, { ...request }, { selfName: SELF })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'remove')
  assert.equal(result.code, 'unavailable')
}

// ---- 10. request validation ---------------------------------------------
assert.deepEqual(parseUpdateRequest({ name: 'dsh-context', version: '0.74.0' }), { name: 'dsh-context', version: '0.74.0' })
assert.deepEqual(
  parseUpdateRequest({ name: '@scope/pkg', version: '1.2.3', registry: 'https://registry.npmmirror.com/' }),
  { name: '@scope/pkg', version: '1.2.3', registry: 'https://registry.npmmirror.com' },
  'the registry is normalised and a trailing slash dropped',
)
assert.equal(parseUpdateRequest({ name: 'dsh-context', version: 'latest' }).error, 'version must be a semantic version')
assert.equal(parseUpdateRequest({ name: 'dsh-context', version: '^0.74.0' }).error, 'version must be a semantic version')
assert.equal(parseUpdateRequest({ name: '../etc', version: '1.0.0' }).error, 'name must be a package name')
assert.equal(parseUpdateRequest({ version: '1.0.0' }).error, 'name must be a package name')
assert.equal(parseUpdateRequest(null).error, 'expected a JSON object')
assert.equal(parseUpdateRequest([]).error, 'expected a JSON object')
assert.equal(parseUpdateRequest({ name: 'dsh-context', version: '0.74.0', registry: 'file:///etc' }).registry, undefined,
  'a non-http registry hint is dropped rather than handed to pnpm')

console.log('ok: update orchestration (remove-then-install, self-update guard, failure stages)')
