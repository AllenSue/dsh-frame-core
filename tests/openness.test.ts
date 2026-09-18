import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { REACT_CAPABILITIES } from '../src/model/platform.ts'
import { createFrameState, withMeasurements } from '../src/model/state.ts'
import type { FrameState } from '../src/model/state.ts'
import type { FrameTypeDefinition } from '../src/model/types.ts'
import { getType, registerType, requireType, typeIds } from '../src/model/types.ts'
import { closeFrame, floatFrame, splitFrame } from '../src/ops/intents.ts'

/**
 * The type registry is an **open constraint interface**: the core fixes the
 * shape of a declaration and how it arbitrates one, and knows nothing about
 * which types exist. These tests hold both halves of that — the mechanical half
 * (no type id is written down in the core) and the behavioural half (a type the
 * core has never heard of is governed by its declaration alone).
 *
 * `vendor/` is excluded: it is a third-party copy, not ours to police.
 */
const SOURCE = join(import.meta.dirname, '..', 'src')

/** Every `.ts` under `src/`, excluding the vendored engine. */
function coreSources(dir: string = SOURCE, prefix = ''): readonly string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry === 'vendor') continue
      found.push(...coreSources(path, `${prefix}${entry}/`))
      continue
    }
    if (entry.endsWith('.ts')) found.push(`${prefix}${entry}`)
  }
  return found
}

const FILES = coreSources()

test('the core has sources to check, so an empty scan cannot pass for a clean one', () => {
  assert.ok(FILES.length >= 10, `expected the core, found ${FILES.length} files`)
  assert.ok(FILES.includes('model/types.ts'))
})

test('the core contains no dotted name, so it cannot be naming a type', () => {
  // A type id in this project is either bare or dotted (`legacy.conversation`).
  // The dotted form is the distinctive one, and the core has no legitimate use
  // for a quoted `word.word` literal: its error codes use a slash, its paths use
  // a slash or a leading `..`, and its vocabulary is single words.
  //
  // Quoted occurrences only, which is what makes this comment-proof — the core's
  // prose is allowed to say it never learns the word sidebar, and it does, in a
  // comment, unquoted.
  const dotted = /'[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+'/g
  const offenders: string[] = []
  for (const file of FILES) {
    for (const literal of readFileSync(join(SOURCE, file), 'utf8').match(dotted) ?? []) {
      offenders.push(`${file}: ${literal}`)
    }
  }

  assert.deepEqual(offenders, [], 'the core names something dotted, which here means a content type')
})

test('the core does not name any type its extensions register', () => {
  // The counterpart to the rule above: a bare id (`conversation`) would slip past
  // a dotted-name check, so the ids the shipped extensions actually register are
  // named here explicitly. This list is the one place to extend when a new
  // extension invents an id — and if one of them ever shows up in the core, the
  // boundary has been broken.
  const registered = ['legacy.conversation', 'legacy.sidebar', 'legacy.rightbar', 'conversation']
  const offenders: string[] = []
  for (const file of FILES) {
    const source = readFileSync(join(SOURCE, file), 'utf8')
    for (const id of registered) {
      if (source.includes(`'${id}'`) || source.includes(`"${id}"`)) offenders.push(`${file}: ${id}`)
    }
  }

  assert.deepEqual(offenders, [], 'the core names a type that a plugin owns')
})

// ------------------------------------------------- the registry is open

test('the registry takes any id, keeps registration order, and refuses a duplicate', () => {
  let registry = registerType({ byId: new Map() }, { id: 'a-type-nobody-has-heard-of', title: () => 'A' })
  registry = registerType(registry, { id: 'another.one', title: () => 'B' })

  assert.deepEqual(typeIds(registry), ['a-type-nobody-has-heard-of', 'another.one'])
  assert.equal(getType(registry, 'a-type-nobody-has-heard-of')?.title(), 'A')
  assert.equal(getType(registry, 'never-registered'), undefined)
  assert.throws(() => registerType(registry, { id: 'another.one', title: () => 'C' }), /already registered/)
  assert.throws(() => requireType(registry, 'never-registered'), /is not registered/)
})

test('a declaration needs an id and a title, and nothing else', () => {
  const bare: FrameTypeDefinition = { id: 'bare', title: () => 'Bare' }
  const registry = registerType({ byId: new Map() }, bare)

  assert.equal(getType(registry, 'bare'), bare)
})

// ----------------------------------- governance comes from the declaration

/** A measured shell with `types` registered and the first one seeded. */
function shell(startup: FrameTypeDefinition, types: readonly FrameTypeDefinition[]): FrameState {
  return withMeasurements(
    createFrameState({ startup, platform: { id: 'react', capabilities: REACT_CAPABILITIES }, types }),
    { viewport: { width: 1000, height: 800 } },
  )
}

/** Unwrap an accepted result, failing the test on a refusal. */
function accepted(result: { ok: boolean } & Record<string, any>): FrameState {
  assert.equal(result.ok, true, `expected acceptance, got ${JSON.stringify(result)}`)
  return result.value as FrameState
}

/** Unwrap a refusal, failing the test on an acceptance. */
function refused(result: { ok: boolean } & Record<string, any>): string {
  assert.equal(result.ok, false, 'expected a refusal')
  return result.ok === false ? (result.code as string) : ''
}

test('a type the core has never heard of is refused for close, by its own declaration', () => {
  const pinned: FrameTypeDefinition = {
    id: 'zzz.pinned-surface',
    title: () => 'Pinned',
    policy: { closable: false },
  }

  const state = shell(pinned, [pinned])

  assert.equal(refused(closeFrame(state)), 'frames/policy-refused')
})

test('a type the core has never heard of is refused for split, by its own declaration', () => {
  const fused: FrameTypeDefinition = {
    id: 'zzz.fused-surface',
    title: () => 'Fused',
    policy: { splittable: false },
  }

  const state = shell(fused, [fused])

  assert.equal(refused(splitFrame(state, undefined, fused.id)), 'frames/policy-refused')
})

test('a type that refuses to float is refused for float, by its own declaration', () => {
  const anchored: FrameTypeDefinition = {
    id: 'zzz.anchored-surface',
    title: () => 'Anchored',
    hosts: ['dock'],
  }

  const state = shell(anchored, [anchored])

  assert.equal(refused(floatFrame(state)), 'frames/policy-refused')
})

test('the core has no notion of a type it likes more than another', () => {
  // Two made-up types, governed by nothing but their own fields. If the core had
  // a built-in list, or a special case, one of these would behave differently.
  const strict: FrameTypeDefinition = {
    id: 'zzz.strict',
    title: () => 'Strict',
    policy: { closable: false, splittable: false },
    hosts: ['dock'],
  }
  const loose: FrameTypeDefinition = { id: 'zzz.loose', title: () => 'Loose' }

  const strictState = shell(strict, [strict, loose])
  const looseState = shell(loose, [strict, loose])

  assert.equal(refused(closeFrame(strictState)), 'frames/policy-refused')
  assert.equal(refused(splitFrame(strictState, undefined, loose.id)), 'frames/policy-refused')
  assert.equal(refused(floatFrame(strictState)), 'frames/policy-refused')

  assert.equal(accepted(closeFrame(looseState)).layout !== undefined, true)
  assert.equal(accepted(splitFrame(looseState, undefined, strict.id)).layout !== undefined, true)
  assert.equal(floatFrame(looseState).ok, true)
})

test('registering a type is the only way the core learns one exists', () => {
  const ghost: FrameTypeDefinition = { id: 'zzz.never-registered', title: () => 'Ghost' }
  const state = shell({ id: 'zzz.startup', title: () => 'Startup' }, [{ id: 'zzz.startup', title: () => 'Startup' }])

  // Declared as a type but not registered: the core refuses to seed with it.
  assert.equal(refused(splitFrame(state, undefined, ghost.id)), 'frames/unknown-type')
})
