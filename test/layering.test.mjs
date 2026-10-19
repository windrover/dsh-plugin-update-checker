#!/usr/bin/env node
/**
 * Layering guard for the split host half.
 *
 * The host half was one 908-line file; it is now six modules by responsibility.
 * A split is only worth keeping if the boundaries stay put, so the rules that
 * made the split worthwhile are asserted here instead of written in a doc:
 *
 *   1. Only the entry module (update-checker.js) may touch `ctx`. Everything
 *      else is pure logic that takes plain arguments, which is what makes it
 *      testable without a host.
 *   2. Dependencies point one way (see ALLOWED); no module imports the entry.
 *   3. Every cross-module import is actually exported by its target — a missing
 *      `export` otherwise only shows up when the plugin boots.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'host')
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const files = readdirSync(HOST).filter((f) => f.endsWith('.js')).sort()
const sources = Object.fromEntries(files.map((f) => [f, readFileSync(join(HOST, f), 'utf8')]))

// ---- 1. ctx lives only in the entry --------------------------------------
const ctxUsers = files.filter((f) => /\bctx\b/.test(strip(sources[f])))
assert.deepEqual(ctxUsers, ['update-checker.js'],
  `only the entry may touch ctx, found: ${ctxUsers.join(', ')}`)

// ---- 2. one-way dependencies ---------------------------------------------
const ALLOWED = {
  'dsh.js': ['profile.js'],
  'profile.js': [],
  'registry.js': [],
  'runtime.js': ['registry.js'],
  'scan.js': ['dsh.js', 'profile.js', 'registry.js'],
  'update-checker.js': ['dsh.js', 'profile.js', 'registry.js', 'runtime.js', 'scan.js'],
}
for (const file of files) {
  const imports = [...sources[file].matchAll(/from '\.\/([a-z-]+\.js)'/g)].map((m) => m[1])
  assert.ok(ALLOWED[file] !== undefined, `unexpected module ${file}: add it to ALLOWED with its dependencies`)
  for (const target of imports) {
    assert.ok(ALLOWED[file].includes(target),
      `${file} imports ${target}, which is not allowed (rethink the layering before widening this table)`)
  }
}

// ---- 3. every imported name is exported by its target --------------------
/** Names exported by a module: `export function|const|let X`, plus `export { X } from ...`. */
function exportedNames(src) {
  const names = new Set()
  for (const m of src.matchAll(/^export (?:async )?(?:function|const|let) ([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  for (const m of src.matchAll(/^export \{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) names.add(part.trim().split(/\s+as\s+/).pop())
  }
  return names
}

let checked = 0
for (const file of files) {
  const src = sources[file]
  for (const m of src.matchAll(/import \{([^}]+)\} from '\.\/([a-z-]+\.js)'/g)) {
    const target = sources[m[2]]
    assert.ok(target !== undefined, `${file} imports ${m[2]}, which does not exist`)
    const available = exportedNames(target)
    for (const part of m[1].split(',')) {
      const name = part.trim()
      if (name === '') continue
      checked += 1
      assert.ok(available.has(name),
        `${file} imports "${name}" from ${m[2]}, but that module does not export it`)
    }
  }
}

console.log(`layering ok: ${files.length} modules · ctx only in the entry · ${checked} imports verified · one-way deps`)
