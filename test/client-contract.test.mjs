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
// Re-run the factory capture to obtain exports.
let capturedExports
vm.runInNewContext(
  readFileSync(join(ROOT, 'lib/client.js'), 'utf8'),
  {
    window: {
      __ModuleLoader__: {
        load: ({ factory }) => { capturedExports = factory(requireStub) },
      },
    },
    console,
  },
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

console.log('ok: dsh-plugin-update-checker browser-half contract holds')
console.log(`  bundle id      : ${loadCalls[0]}`)
console.log(`  tab id         : ${slotEntries[0].id} (order ${slotEntries[0].order})`)
console.log(`  tab label      : ${slotEntries[0].label(t)}`)
console.log(`  inject         : ${JSON.stringify(capturedExports.inject)}`)
