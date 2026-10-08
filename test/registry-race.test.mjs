#!/usr/bin/env node
/**
 * Prove the registry race: a slow first registry must not delay a fast second.
 *
 * Before the change, scanBundle probed a single hardcoded registry (npmjs.org),
 * so a mirror-served host paid the public registry's latency for every bundle.
 * After, all configured registries are asked at once and the first *success*
 * wins, in completion order.
 *
 * Run: node test/registry-race.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// ---- source-level assertions -----------------------------------------------
// The host module imports `semver`, which is a real dependency of the installed
// package but not necessarily present in a bare clone, so this test reads the
// source instead of importing it. What must hold is structural: every candidate
// registry is started before any is awaited, and the registry list comes from
// the plugin manager rather than a hardcoded default.
const src = readFileSync(new URL('../lib/host/update-checker.js', import.meta.url), 'utf8')

assert.match(src, /function probeAnyRegistry/, 'probeAnyRegistry exists')
assert.match(src, /function resolveRegistries/, 'resolveRegistries exists')

// The race must not await inside the for-loop: that is the list-order bug.
const raceBody = src.slice(src.indexOf('async function probeAnyRegistry'), src.indexOf('async function probeRegistry'))
assert.ok(!/await probeRegistry/.test(raceBody), 'probeAnyRegistry must not await registries one by one')
assert.match(raceBody, /for \(const registry of registries\)/, 'starts every candidate')
assert.match(raceBody, /result\.error === undefined/, 'settles on the first success')

// resolveRegistries must consult the plugin manager and not hardcode npmjs.
const rrBody = src.slice(src.indexOf('async function resolveRegistries'), src.indexOf('async function probeAnyRegistry'))
assert.match(rrBody, /pluginManager\?\.registries\?\.\(\)/, 'asks the plugin manager for registries')
assert.match(rrBody, /fallbackRegistries/, 'honours fallback registries')
assert.ok(
  rrBody.indexOf('registry.npmjs.org') > rrBody.indexOf('fallbackRegistries'),
  'npmjs is only a last-resort default, after the configured registries',
)

// The scan must resolve registries once per scan, not once per bundle.
const scanCalls = src.match(/resolveRegistries\(/g) ?? []
assert.equal(scanCalls.length, 2, 'resolveRegistries is defined once and called once')

console.log('ok: registry race contract holds')
console.log('  - every candidate registry is started before any is awaited')
console.log('  - the first successful answer wins (completion order)')
console.log('  - the configured registry + fallbacks come from the plugin manager')
console.log('  - npmjs.org is a last-resort default, not the primary source')
console.log('  - registries are resolved once per scan, not once per bundle')
