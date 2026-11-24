#!/usr/bin/env node
/**
 * Contract test for the browser half of dsh-plugin-update-checker.
 *
 * The DSH precheck's "stage 3" only proves the bundle loads and exports a
 * callable `apply`; it never runs `apply`. This test actually does, against a
 * mock client context, and pins the contract DSH imposes plus this bundle's own
 * shape:
 *
 *   - the bundle id registered via __ModuleLoader__.load must equal the package
 *     name (`client-modules` resolves the browser module by walking up to the
 *     package.json whose `name` strictly equals that id, then requiring the
 *     bundle to register the same id; a case mismatch silently drops the whole
 *     browser half from the boot graph);
 *   - `exports.inject` must be short service ids the section depends on;
 *   - exactly one tab is registered into `settings.plugins.tab` with a unique
 *     id/order, a non-empty label thunk, and an injection closure that hands the
 *     component `t` (locale) and `scan` (the host-route caller).
 *
 * Run: node test/client-contract.test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_NAME = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name

// ---- a react stub that records createElement calls -------------------------
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useSyncExternalStore: () => {},
  Fragment: Symbol('Fragment'),
}
const react_jsx_runtime = {
  jsx: react.createElement,
  jsxs: react.createElement,
  Fragment: react.Fragment,
}
const requireStub = (spec) => {
  if (spec === 'react') return react
  if (spec === 'react/jsx-runtime') return react_jsx_runtime
  throw new Error(`unexpected require(${JSON.stringify(spec)})`)
}

// ---- load the bundle exactly the way the browser loader does ---------------
let registrations = []
const loadCalls = []
vm.runInNewContext(
  readFileSync(join(ROOT, 'lib/client.js'), 'utf8'),
  {
    window: {
      __ModuleLoader__: {
        load: ({ id, factory }) => {
          loadCalls.push(id)
          factory(requireStub)
        },
      },
    },
    console,
  },
  { filename: join(ROOT, 'lib/client.js') }
)

assert.equal(loadCalls.length, 1, 'exactly one module registers')
assert.equal(loadCalls[0], PKG_NAME, 'bundle id must equal package name')

// ---- replay apply against a mock client context ----------------------------
const slotEntries = []
const localeBinds = []
const mockCtx = {
  effect: (fn) => fn(),
  slots: {
    // The bundle's factory returns `ctx.slots.register(reg, body)`; capture both.
    register: (reg, body) => {
      slotEntries.push({ ...reg, body })
      return () => {}
    },
    inject: (slotName, factory) => {
      assert.equal(slotName, 'settings.plugins.tab', 'registers into the Plugins settings tab slot')
      factory() // -> ctx.slots.register(reg, body)
    },
  },
  locale: {
    register: () => {},
    bind: (ns) => {
      localeBinds.push(ns)
      return (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key)
    },
  },
  modules: { entries: {} },
}
// The bundle exposes apply on the module exports returned by the factory.
// Re-run the factory capture to obtain exports, this time with the boot graph a
// real Host injects so the scan URL can be checked.
let capturedExports
const scanned = []
const bootSandbox = {
  window: {
    __ModuleLoader__: {
      load: ({ factory }) => { capturedExports = factory(requireStub) },
    },
    __DSH_BOOT__: { release: { version: '0.2.1-rc.5', commit: 'd4db512' } },
  },
  fetch: async (url, init) => {
    scanned.push({ url, init })
    return { json: async () => ({ ok: true, dshVersion: '0.2.1-rc.5' }) }
  },
  console,
}
vm.runInNewContext(
  readFileSync(join(ROOT, 'lib/client.js'), 'utf8'),
  bootSandbox,
  { filename: join(ROOT, 'lib/client.js') }
)

assert.equal(typeof capturedExports.apply, 'function', 'bundle exports a callable apply')
assert.ok(Array.isArray(capturedExports.inject), 'bundle declares an inject array')
for (const s of capturedExports.inject) assert.equal(typeof s, 'string', 'inject ids are strings')

capturedExports.apply(mockCtx)
assert.equal(slotEntries.length, 1, 'exactly one tab is registered')
assert.equal(slotEntries[0].id, 'update-checker', 'tab id is stable')
assert.ok(localeBinds.includes('pluginUpdateChecker'), 'locale dictionary is registered')

// ---- the registered tab body is a renderable component ----------------------
const { body: TabBody, inject: bodyInject } = slotEntries[0]
assert.equal(typeof TabBody, 'function', 'tab registers a renderable body component')
const t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key)
// Render with an empty result (the initial, not-yet-checked state).
const rendered = TabBody({ t, scan: async () => ({}) })
assert.ok(rendered && rendered.type === 'div', 'body renders a root <div>')

// ---- the scan relays the release the Host put in the boot graph ------------
// Inside the desktop app the host half's own module lookups find the npm CLI
// (0.2.1-rc.2) instead of the runtime packed in app.asar; the boot graph is the
// one place that names the release actually serving the page, so the scan sends
// it and the host prefers it for that request.
const { scan } = slotEntries[0].inject()
await scan()
assert.equal(scanned.length, 1, 'scan calls the host route once')
assert.equal(scanned[0].init?.method, 'POST', 'scan is a POST')
assert.equal(scanned[0].url, '/api/plugin-update-checker/scan?runtime=0.2.1-rc.5',
  'the boot release travels to the host')

// Older Hosts inject no release: the plain route, host-side resolution decides.
bootSandbox.window.__DSH_BOOT__ = { release: {} }
await scan()
assert.equal(scanned[1].url, '/api/plugin-update-checker/scan',
  'a graph without a release keeps the plain route')

bootSandbox.window.__DSH_BOOT__ = undefined
await scan()
assert.equal(scanned[2].url, '/api/plugin-update-checker/scan',
  'no boot graph at all keeps the plain route')

// ---- how an unactionable update is labelled --------------------------------
// The runtime row is the one thing this panel can never update: the desktop app
// delivers it. A plain "Update available" next to a row with no button reads as
// a broken control, so that row names the actor — and only when the host really
// is the desktop carrier (update.source === 'desktop-updater'). A CLI/web host
// falls back to npm, keeps "Update available", and gets npm instructions.

function renderTab(result) {
  const states = [false, null, result, {}, {}] // loading, error, result, updating, outcome
  const reactWithStates = { ...react, useState: () => [states.shift(), () => {}] }
  let bundleExports
  vm.runInNewContext(
    readFileSync(join(ROOT, 'lib/client.js'), 'utf8'),
    {
      window: {
        __ModuleLoader__: {
          load: ({ factory }) => {
            bundleExports = factory((spec) => {
              if (spec === 'react') return reactWithStates
              if (spec === 'react/jsx-runtime') return react_jsx_runtime
              throw new Error(`unexpected require(${JSON.stringify(spec)})`)
            })
          },
        },
      },
      console,
    },
    { filename: join(ROOT, 'lib/client.js') }
  )
  const bodies = []
  bundleExports.apply({
    effect: (fn) => fn(),
    slots: {
      register: (reg, body) => { bodies.push(body); return () => {} },
      inject: (name, factory) => factory(),
    },
    locale: { register() {}, bind: () => (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) },
    modules: { entries: {} },
  })
  return bodies[0]
}

function textsOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) textsOf(n, out); return out }
  if (typeof node === 'object') {
    textsOf(node.children, out)
    if (node.props && node.props.children !== undefined) textsOf(node.props.children, out)
  }
  return out
}

const resultWith = (plugins) => ({
  ok: true,
  checkedAt: '2026-10-30T00:00:00.000Z',
  dshVersion: '0.2.1-rc.2',
  plugins,
})
const runtimeRow = (source) => ({
  name: 'dsh-runtime',
  installedVersion: '0.2.1-rc.2',
  installed: true,
  linked: false,
  compatibility: { status: 'compatible' },
  update: { status: 'update-available', latest: '0.2.1-rc.5', ...(source ? { source } : {}) },
})

const scanStub = async () => ({})
const desktopTexts = textsOf(renderTab(resultWith([runtimeRow('desktop-updater')]))({ t, scan: scanStub }))
assert.ok(desktopTexts.includes('update.appManaged'),
  'the desktop runtime row names the app as the updater')
assert.ok(!desktopTexts.includes('update.updateAvailable'),
  'the desktop runtime row must not claim a generic update')
assert.ok(desktopTexts.includes('runtimeUpdateAvailable'), 'availability is still stated')
assert.ok(desktopTexts.includes('runtimeUpdateHint'), 'the desktop hint stays')
assert.ok(!desktopTexts.includes('updateBtn'), 'the runtime never gets an update button')

const cliTexts = textsOf(renderTab(resultWith([runtimeRow()]))({ t, scan: scanStub }))
assert.ok(cliTexts.includes('update.updateAvailable'), 'a CLI-hosted runtime keeps the normal wording')
assert.ok(!cliTexts.includes('update.appManaged'), 'no app claim without the desktop feed')
assert.ok(cliTexts.some((s) => s.startsWith('runtimeUpdateHintNpm:')), 'npm hosts get npm instructions')
assert.ok(!cliTexts.includes('runtimeUpdateHint'), 'the app-updater hint must not leak into npm hosts')
assert.ok(!cliTexts.includes('updateBtn'), 'the runtime never gets an update button')

// A release the app's own updater withholds (outside the staged-rollout window)
// must not be advertised, but it must not become invisible either: the row says
// "up to date" and names the release the feed is holding back. Otherwise the
// panel has the same silent blind spot it was built to close.
const stagedRow = {
  name: 'dsh-runtime',
  installedVersion: '0.2.2-rc.5',
  installed: true,
  linked: false,
  compatibility: { status: 'compatible' },
  update: { status: 'up-to-date', latest: '0.2.2-rc.5', staged: '0.2.3-alpha.2' },
}
const stagedTexts = textsOf(renderTab(resultWith([stagedRow]))({ t, scan: scanStub }))
assert.ok(stagedTexts.includes('update.upToDate'), 'a gated release reads as up to date')
assert.ok(!stagedTexts.includes('update.updateAvailable'), 'a gated release is not advertised as available')
assert.ok(!stagedTexts.includes('runtimeUpdateAvailable'), 'no availability line for a gated release')
assert.ok(stagedTexts.some((s) => s.startsWith('runtimeStaged:')), 'the withheld release is explained')
assert.ok(!stagedTexts.includes('updateBtn'), 'the runtime never gets an update button')

// A plain up-to-date runtime (nothing withheld) stays quiet about staging.
const quietTexts = textsOf(renderTab(resultWith([{
  name: 'dsh-runtime',
  installedVersion: '0.2.2-rc.5',
  installed: true,
  linked: false,
  compatibility: { status: 'compatible' },
  update: { status: 'up-to-date', latest: '0.2.2-rc.5' },
}]))({ t, scan: scanStub }))
assert.ok(!quietTexts.some((s) => s.startsWith('runtimeStaged:')), 'no staging note when nothing is withheld')

// Ordinary plugins are untouched: they keep their Update button.
const pluginTexts = textsOf(renderTab(resultWith([{
  name: 'some-plugin',
  installedVersion: '1.0.0',
  compatibility: { status: 'compatible' },
  update: { status: 'update-available', latest: '1.1.0' },
}]))({ t, scan: scanStub }))
assert.ok(pluginTexts.includes('updateBtn'), 'a normal plugin still offers Update')
assert.ok(!pluginTexts.includes('update.appManaged'), 'the quiet badge is runtime-only')

console.log('ok: dsh-plugin-update-checker browser-half contract holds')
console.log(`  bundle id      : ${loadCalls[0]}`)
console.log(`  tab id         : ${slotEntries[0].id} (order ${slotEntries[0].order})`)
console.log(`  tab label      : ${slotEntries[0].label(t)}`)
console.log(`  inject         : ${JSON.stringify(capturedExports.inject)}`)
console.log('  runtime labels : app-managed on desktop, npm hint elsewhere, never a button')
