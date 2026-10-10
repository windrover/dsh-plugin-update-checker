#!/usr/bin/env node
/**
 * Pin the DSH-runtime check contract.
 *
 * Before this change the "Check updates" panel reported the running DSH version
 * but never checked whether a *newer DSH runtime itself* existed — and worse,
 * the @deepseek-ai/dsh* runtime packages (symlinked from the runtime install
 * into the shared profiles tree) were mislabelled as user source-links
 * ("update from the repository"), so the runtime could neither be checked nor
 * updated from the panel. That is the literal "检查更新的插件无法检查dsh".
 *
 * This pins the contract the host half must now honour:
 *
 *   1. The scan route appends exactly one 'dsh-runtime' row (name
 *      'dsh-runtime'), separate from the per-bundle rows.
 *   2. Every @deepseek-ai/dsh* bundle is reported as 'part-of-runtime' (never
 *      as a source-link), so the runtime is checked once as a unit and the
 *      misleading "update from the repository" verdict disappears.
 *   3. The runtime check uses the app's own electron updater feed
 *      (app-update.yml's url + channel) as the authoritative source, NOT npm's
 *      `latest` dist-tag — npm `latest` lags the running nightly build and would
 *      falsely report "up to date". npm is only a fallback when no feed is found.
 *
 * Run: node test/runtime-check.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(new URL('../lib/host/update-checker.js', import.meta.url), 'utf8')
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

// ---- 1. The runtime check is its own function the route appends --------------
assert.match(code, /async function checkDshRuntime/, 'checkDshRuntime exists')
assert.ok(/plugins\.push\(runtimeRow\)/.test(code), 'the route appends exactly one runtime row to the result')
assert.ok(/name:\s*'dsh-runtime'/.test(code), "the runtime row is named 'dsh-runtime'")

// ---- 2. @deepseek-ai/dsh* must never be treated as user source-links --------
assert.match(code, /function isRuntimePackage/, 'isRuntimePackage exists')
assert.match(code, /return name === '@deepseek-ai\/dsh'/, 'treats @deepseek-ai/dsh as runtime')
assert.match(code, /name\.startsWith\('@deepseek-ai\/dsh-'\)/, 'treats @deepseek-ai/dsh-* as runtime')
const scanBody = code.slice(code.indexOf('async function scanBundle'), code.indexOf('/** Read one manifest'))
assert.match(scanBody, /isRuntimePackage\(name\)/, 'scanBundle consults isRuntimePackage')
assert.match(scanBody, /status:\s*'part-of-runtime'/, 'runtime packages get the part-of-runtime status')
assert.ok(!/isRuntimePackage[\s\S]*part-of-runtime[\s\S]*resolveSourceLink/.test(scanBody.replace(/resolveSourceLink/g, 'XresolvesX')), 'runtime packages skip resolveSourceLink (no source-link verdict)')

// ---- 3. The runtime check prefers the electron updater feed over npm --------
const rtBody = code.slice(code.indexOf('async function checkDshRuntime'), code.indexOf('/** Scan one bundle'))
assert.match(rtBody, /readAppUpdateConfig/, 'reads the app-update.yml config')
assert.match(rtBody, /fetchRuntimeFeedVersion/, 'fetches the updater feed version')
assert.match(rtBody, /probeAnyRegistry\('@deepseek-ai\/dsh-app-boot'/, 'falls back to npm for the runtime when no feed')
// The feed must be consulted BEFORE npm in the code (feed path returns early).
const feedIdx = rtBody.indexOf('fetchRuntimeFeedVersion')
const npmIdx = rtBody.indexOf("probeAnyRegistry('@deepseek-ai/dsh-app-boot'")
assert.ok(feedIdx !== -1 && npmIdx !== -1 && feedIdx < npmIdx, 'the updater feed is checked before npm')

// ---- 4. The feed file selection matches electron-builder's channel naming ---
assert.match(code, /function runtimeFeedFileNames/, 'runtimeFeedFileNames exists')
assert.match(code, /channel === 'latest' \? 'latest' : channel/, 'uses the channel in the file name (nightly -> nightly-mac.yml)')
assert.match(code, /'darwin'\) return 'mac'/, 'maps darwin -> mac feed naming')

console.log('ok: DSH runtime-check contract holds')
console.log('  - the scan appends one dsh-runtime row (checked as a unit)')
console.log('  - @deepseek-ai/dsh* are reported as part-of-runtime, never as source-links')
console.log('  - the runtime check uses the app updater feed first, npm only as fallback')
console.log('  - the feed file name follows the electron channel (e.g. nightly-mac.yml)')
