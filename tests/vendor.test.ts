import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The vendored engine is ours to keep correct, and these are the two properties
 * that make it worth having a copy at all. They are checked mechanically because
 * both would rot silently: a stray `import` is invisible until a host without
 * React tries to load it, and a copy that reaches outside itself is not a copy.
 */
const VENDOR = join(import.meta.dirname, '..', 'src', 'vendor')

/** Every file under the vendor tree, relative to it. */
function vendorFiles(dir: string = VENDOR, prefix = ''): readonly string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      found.push(...vendorFiles(path, `${prefix}${entry}/`))
      continue
    }
    found.push(`${prefix}${entry}`)
  }
  return found
}

const FILES = vendorFiles()
const SOURCES = FILES.filter((file) => file.endsWith('.ts'))

test('the vendor tree is where the engine actually is', () => {
  assert.ok(SOURCES.length >= 10, `expected the engine, found ${SOURCES.length} source files`)
  assert.ok(SOURCES.includes('brand/index.ts'))
  assert.ok(SOURCES.includes('ui-dockkit/engine/planner.ts'))
})

test('nothing vendored imports React, which is the whole reason for the copy', () => {
  for (const file of SOURCES) {
    const source = readFileSync(join(VENDOR, file), 'utf8')
    assert.equal(
      /from\s+'react'|require\('react'\)|from\s+"react"/.test(source),
      false,
      `${file} imports React; the core must run where React does not exist`,
    )
  }
})

test('the copy is self-contained: vendor imports nothing outside vendor', () => {
  for (const file of SOURCES) {
    const source = readFileSync(join(VENDOR, file), 'utf8')
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '')
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('.'),
        `${file} imports "${specifier}"; anything vendored must reach only into the vendor tree,`
        + ' or it is a dependency wearing a copy as a disguise',
      )
    }
    // And a relative reach must stay inside: `../../brand/index.ts` from a
    // contract file lands in the tree, `../../../frames/...` would not.
    for (const specifier of specifiers) {
      const resolved = join(VENDOR, file, '..', specifier)
      assert.ok(
        resolved.startsWith(VENDOR),
        `${file} reaches outside the vendor tree via "${specifier}"`,
      )
    }
  }
})

test('the provenance file names every vendored source', () => {
  const provenance = readFileSync(join(VENDOR, 'README.md'), 'utf8')
  for (const file of SOURCES) {
    // The engine's own upstream path, which is what the file lists.
    assert.ok(
      provenance.includes(file),
      `${file} is not named in vendor/README.md; a copy whose source is not written down is a rumour`,
    )
  }
})

test('the provenance file records the local differences from upstream', () => {
  const provenance = readFileSync(join(VENDOR, 'README.md'), 'utf8')

  assert.match(provenance, /dsh-client-ui-dockkit/)
  assert.match(provenance, /0\.1\.5-rc\.2/)
  assert.match(provenance, /c291e796/)
  // Each of the three edits. If a fourth happens and this is not updated, the
  // file is lying about what was copied, which is worse than having no file.
  assert.match(provenance, /Branded/)
  assert.match(provenance, /axis: SplitAxis/)
  assert.match(provenance, /direction: SplitDirection/)
})
