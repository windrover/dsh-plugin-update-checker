#!/usr/bin/env node
/**
 * Stale-mirror guard for the registry race.
 *
 * The race exists so a slow public registry cannot delay a fast mirror. The
 * flip side showed up on the first real publish: npm creates a stub version
 * (0.0.0-stage) for a brand-new package, the mirror cached it, and the mirror is
 * ~20x faster than the public registry — so the race returned the placeholder
 * and the panel reported the installed 0.1.4 as "up to date" against 0.0.0-stage.
 *
 * The fix keeps the fast path (first success wins) but treats an answer as
 * suspect when it carries a placeholder, or when it claims something older than
 * the version already installed — then it waits for the other candidates (they
 * are already in flight) and keeps the highest real release.
 *
 * Run: node test/registry-staleness.test.mjs
 */
import assert from 'node:assert/strict'
import { probeAnyRegistry } from '../lib/host/registry.js'

const FAST = 'https://fast.test'
const SLOW = 'https://slow.test'

const packument = (version, extra = {}) => ({
  'dist-tags': { latest: version },
  versions: { [version]: { version, ...extra } },
})

/** Serve a canned body per registry, optionally delayed. */
function stubNetwork(table) {
  globalThis.fetch = async (input) => {
    const url = String(input)
    for (const [base, spec] of Object.entries(table)) {
      if (url.startsWith(base)) {
        if (spec.delay) await new Promise((r) => setTimeout(r, spec.delay))
        return { ok: true, status: 200, async json() { return spec.body } }
      }
    }
    return { ok: false, status: 404, async json() { return {} } }
  }
}

const realFetch = globalThis.fetch
try {
  // 1. The mirror still has npm's placeholder; the public registry has the real release.
  stubNetwork({
    [FAST]: { body: packument('0.0.0-stage', { stub: true }) },
    [SLOW]: { body: packument('0.1.4'), delay: 60 },
  })
  let out = await probeAnyRegistry('pkg', [FAST, SLOW], undefined, '0.1.4')
  assert.equal(out.result.latest, '0.1.4', 'a placeholder answer must not win the race')
  assert.equal(out.registry, SLOW)

  // 2. A stale real version: the mirror is behind what is already installed.
  stubNetwork({
    [FAST]: { body: packument('0.1.3') },
    [SLOW]: { body: packument('0.1.4'), delay: 60 },
  })
  out = await probeAnyRegistry('pkg', [FAST, SLOW], undefined, '0.1.4')
  assert.equal(out.result.latest, '0.1.4', 'an answer older than the installed version is stale')

  // 3. Fast path is preserved: a trustworthy first answer wins without waiting.
  stubNetwork({
    [FAST]: { body: packument('0.1.4') },
    [SLOW]: { body: packument('0.1.5'), delay: 400 },
  })
  const started = Date.now()
  out = await probeAnyRegistry('pkg', [FAST, SLOW], undefined, '0.1.4')
  const elapsed = Date.now() - started
  assert.equal(out.result.latest, '0.1.4', 'the first trustworthy answer is used as-is')
  assert.ok(elapsed < 300, `must not wait for the slow registry on the fast path (took ${elapsed}ms)`)

  // 4. All answers are placeholders: still return one rather than "no registry".
  stubNetwork({
    [FAST]: { body: packument('0.0.0-stage', { stub: true }) },
    [SLOW]: { body: packument('0.0.0-stage', { stub: true }), delay: 20 },
  })
  out = await probeAnyRegistry('pkg', [FAST, SLOW], undefined, '0.1.4')
  assert.equal(out.result.latest, '0.0.0-stage', 'placeholder-only registries still answer')

  // 5. Every registry fails: the error is surfaced, not swallowed.
  stubNetwork({})
  out = await probeAnyRegistry('pkg', [FAST, SLOW], undefined, '0.1.4')
  assert.ok(typeof out.result.error === 'string' && out.result.error.length > 0, 'failures surface as an error')

  console.log('✓ registry race: placeholder rejected, stale version rejected, fast path preserved')
} finally {
  globalThis.fetch = realFetch
}
