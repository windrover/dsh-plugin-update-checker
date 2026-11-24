#!/usr/bin/env node
/**
 * Pin the staged-rollout gate on the DSH-runtime row.
 *
 * The bug this exists for (2026-11-24): the panel said
 *   DSH 运行时  由 App 更新   有可用更新   installed 0.2.2-rc.5, latest 0.2.3-alpha.2
 * while the app's own 检查更新… correctly answered "no update". The feed carried
 * `stagingPercentage: 10`, and this install's `.updaterId` hashes to bucket
 * 34.2% — outside the window. electron-updater refuses the release; the panel
 * did not read the gate at all, so it advertised a release the app would never
 * install. The user then restarts, checks the menu, and sees nothing.
 *
 * Contract:
 *   1. The feed's `stagingPercentage` is read, not just `version`.
 *   2. A release inside the rollout window is still reported as available.
 *   3. A release outside it is NOT: the runtime row reports up-to-date for the
 *      running version (and names the withheld release in `staged`).
 *   4. Unknown inputs stay permissive — no gate, unparsable gate, or no readable
 *      updater identity must behave exactly as before (report the update).
 *
 * Run: node test/runtime-staging.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'uc-staging-'))

// <resources>/app-update.yml — the file readAppUpdateConfig walks up to find.
const resources = join(root, 'Resources')
mkdirSync(resources, { recursive: true })
writeFileSync(join(resources, 'app-update.yml'),
  'provider: generic\nurl: https://feed.test/mac-arm64/\nchannel: nightly\n', 'utf8')

// <userData>/.updaterId — the staging identity electron-updater hashes.
const userData = join(root, 'userData')
mkdirSync(userData, { recursive: true })

// Byte 12-15 of the UUID decides the bucket: 0x0000... is 0%, 0xffffffff is 100%.
const LOW_ID = '00000000-0000-0000-0000-000000000001' // bucket ~0%  -> always in
const HIGH_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff' // bucket 100% -> never in
const BUCKET_34 = '2fbfc415-2103-5687-a0f2-60e4579e4c07' // the real install, 34.2%

function serveFeed(text) {
  globalThis.fetch = async () => ({ ok: true, status: 200, async text() { return text } })
}

const savedArgv = process.argv
const savedUserData = process.env.DSH_DESKTOP_USER_DATA
const savedFetch = globalThis.fetch

const useId = (id) => writeFileSync(join(userData, '.updaterId'), id, 'utf8')

try {
  // Only `runtime.js` owns the feed + gate; import it after argv is pointed at
  // the fake bundle so readAppUpdateConfig finds the yml.
  process.argv = [process.argv[0], 'dsh', join(resources, 'app.asar', 'dsh')]
  process.env.DSH_DESKTOP_USER_DATA = userData
  const { checkDshRuntime } = await import('../lib/host/runtime.js')

  const feed = (version, staging) =>
    `version: ${version}\nfiles:\n  - url: https://feed.test/x.zip\n`
    + (staging === undefined ? '' : `stagingPercentage: ${staging}\n`)

  // ---- 1. inside the window: the update is real -----------------------------
  useId(LOW_ID)
  serveFeed(feed('0.2.3-alpha.2', 10))
  let row = await checkDshRuntime('0.2.2-rc.5', [], undefined)
  assert.equal(row.update.status, 'update-available', 'a release inside the rollout is offered')
  assert.equal(row.update.latest, '0.2.3-alpha.2')
  assert.equal(row.update.source, 'desktop-updater')

  // ---- 2. outside the window: the app would say "no update" ----------------
  useId(BUCKET_34)
  serveFeed(feed('0.2.3-alpha.2', 10))
  row = await checkDshRuntime('0.2.2-rc.5', [], undefined)
  assert.equal(row.update.status, 'up-to-date', 'a staged release outside the window is not advertised')
  assert.equal(row.update.latest, '0.2.2-rc.5', 'the row keeps the version actually installed')
  assert.equal(row.update.staged, '0.2.3-alpha.2', 'the withheld release is named for diagnostics')

  // ---- 3. no gate / 100% / unparsable gate stay permissive -----------------
  serveFeed(feed('0.2.3-alpha.2', undefined))
  row = await checkDshRuntime('0.2.2-rc.5', [], undefined)
  assert.equal(row.update.status, 'update-available', 'a feed without a gate behaves as before')

  serveFeed(feed('0.2.3-alpha.2', 100))
  row = await checkDshRuntime('0.2.2-rc.5', [], undefined)
  assert.equal(row.update.status, 'update-available', '100% is a full rollout')

  serveFeed(feed('0.2.3-alpha.2', 'not-a-number'))
  row = await checkDshRuntime('0.2.2-rc.5', [], undefined)
  assert.equal(row.update.status, 'update-available', 'an unparsable gate is not allowed to hide releases')

  // ---- 4. an unreadable identity must not hide a release either ------------
  rmSync(join(userData, '.updaterId'), { force: true })
  serveFeed(feed('0.2.3-alpha.2', 10))
  row = await checkDshRuntime('0.2.2-rc.5', [], undefined)
  assert.equal(row.update.status, 'update-available', 'no updaterId means the gate cannot be evaluated')

  // ---- 5. an older feed is still up-to-date, gate or no gate ---------------
  useId(LOW_ID)
  serveFeed(feed('0.2.2-rc.5', 10))
  row = await checkDshRuntime('0.2.2-rc.5', [], undefined)
  assert.equal(row.update.status, 'up-to-date', 'the same version is never an update')

  // ---- 6. the HIGH_ID really is outside every finite window ---------------
  useId(HIGH_ID)
  serveFeed(feed('0.2.3-alpha.2', 99))
  row = await checkDshRuntime('0.2.2-rc.5', [], undefined)
  assert.equal(row.update.status, 'up-to-date', 'a bucket at 100% is outside a 99% window')

  console.log('ok: staged-rollout gate on the runtime row holds')
  console.log('  - the feed gate is read, not just its version')
  console.log('  - staged releases outside this install\'s window are not advertised')
  console.log('  - missing/unparsable gates and identities stay permissive')
} finally {
  process.argv = savedArgv
  if (savedUserData === undefined) delete process.env.DSH_DESKTOP_USER_DATA
  else process.env.DSH_DESKTOP_USER_DATA = savedUserData
  globalThis.fetch = savedFetch
  rmSync(root, { recursive: true, force: true })
}
