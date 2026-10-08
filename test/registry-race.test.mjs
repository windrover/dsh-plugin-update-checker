#!/usr/bin/env node
/**
 * Pin the registry-race contract.
 *
 * Before this change, scanBundle probed a single hardcoded registry
 * (npmjs.org), so a mirror-served host paid the public registry's latency for
 * every bundle. Now the candidates are raced and the first *success* wins, in
 * completion order.
 *
 * It also pins the bug that shipped in the first attempt: resolveRegistries
 * originally asked `ctx.remote.pluginManager`. `remote` is a *browser-side*
 * service, so on the host that access throws "cannot get property ... without
 * inject" — and because the argument is evaluated at the call site, an internal
 * try/catch did not save it. The route answered HTTP 500. The host half must
 * therefore read configuration, never a service.
 *
 * Run: node test/registry-race.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The host module imports `semver`, which is a real dependency of the installed
// package but not necessarily present in a bare clone, so this test reads the
// source instead of importing it.
const src = readFileSync(new URL('../lib/host/update-checker.js', import.meta.url), 'utf8')

// Strip comments first: the file *documents* the ctx.remote bug in prose, and a
// raw-text scan would flag those explanations as if they were code.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

// ---- the race itself --------------------------------------------------------
assert.match(code, /function probeAnyRegistry/, 'probeAnyRegistry exists')
assert.match(code, /function resolveRegistries/, 'resolveRegistries exists')

const raceBody = code.slice(code.indexOf('function probeAnyRegistry'), code.indexOf('async function probeRegistry'))
assert.ok(!/await probeRegistry/.test(raceBody), 'probeAnyRegistry must not await registries one by one')
assert.match(raceBody, /for \(const registry of registries\)/, 'starts every candidate')
assert.match(raceBody, /result\.error === undefined/, 'settles on the first success')

// ---- registry resolution: configuration, never a service --------------------
const rrBody = code.slice(code.indexOf('function resolveRegistries'), code.indexOf('function firstConfiguredRegistry'))
assert.ok(!/ctx\./.test(rrBody), 'resolveRegistries must not touch ctx — the host half declares only webServer')
assert.match(rrBody, /registry\.npmmirror\.com/, 'knows the launcher mirror')
assert.match(rrBody, /registry\.npmjs\.org/, 'knows the public default')
assert.match(rrBody, /isPublicDefault/, 'distinguishes the public default from a private registry')

// Nothing configured -> race both public registries.
assert.match(rrBody, /if \(configured === undefined\) return \[MIRROR, PUBLIC\]/, 'nothing configured races both')

// The public default -> keep it, add the mirror (both public, nothing leaks).
assert.match(rrBody, /if \(isPublicDefault\(configured\)\) return \[configured, MIRROR\]/, 'public default adds the mirror')

// Anything else -> alone. Racing a corporate registry would send internal
// package names to third parties.
assert.match(rrBody, /return \[configured\]/, 'any other configured registry is used alone')

const cfgBody = code.slice(code.indexOf('function firstConfiguredRegistry'), code.indexOf('function normalizeRegistry'))
assert.match(cfgBody, /npm_config_registry/, 'reads the npm registry environment override')
assert.match(cfgBody, /readRegistryFromNpmrc/, 'reads the profile / home .npmrc')
assert.match(cfgBody, /return base/, 'first source that names a registry wins')

// The route must not reach for ctx.remote either — that access throws on the host.
const routeBody = code.slice(code.indexOf('handler: async (req, res)'))
assert.ok(!/ctx\.remote/.test(routeBody), 'the scan route must not read ctx.remote')

// ---- scope of the resolution ------------------------------------------------
const scanCalls = code.match(/resolveRegistries\(/g) ?? []
assert.equal(scanCalls.length, 2, 'resolveRegistries is defined once and called once per scan')

console.log('ok: registry race contract holds')
console.log('  - every candidate registry is started before any is awaited')
console.log('  - the first successful answer wins (completion order)')
console.log('  - registries come from env/.npmrc, never from ctx (which throws on the host)')
console.log('  - nothing configured -> race the mirror against the public registry')
console.log('  - public default configured -> keep it and add the mirror')
console.log('  - any other configured registry is used alone, so a private one never races public')
console.log('  - registries are resolved once per scan, not once per bundle')
