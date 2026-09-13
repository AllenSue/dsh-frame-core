import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EMPTY_REGISTRY, FrameTypeError, getType, hasType, registerType, requireType, typeIds,
} from '../src/model/types.ts'
import type { FrameTypeDefinition } from '../src/model/types.ts'

const CONVERSATION: FrameTypeDefinition = { id: 'conversation', title: () => 'Conversation' }
const FILES: FrameTypeDefinition = { id: 'files', title: () => 'Files' }

test('registering returns a new registry and leaves the old one alone', () => {
  const first = registerType(EMPTY_REGISTRY, CONVERSATION)
  const second = registerType(first, FILES)

  assert.equal(hasType(EMPTY_REGISTRY, 'conversation'), false)
  assert.deepEqual(typeIds(first), ['conversation'])
  assert.deepEqual(typeIds(second), ['conversation', 'files'])
  assert.equal(getType(second, 'files'), FILES)
})

test('a duplicate id is a programming error, not a silent replacement', () => {
  const registry = registerType(EMPTY_REGISTRY, CONVERSATION)
  assert.throws(
    () => registerType(registry, { ...CONVERSATION, title: () => 'Other' }),
    (error: unknown) => error instanceof FrameTypeError && error.code === 'frames/duplicate-type',
  )
})

test('reading an unregistered id fails loud with the unknown-type code', () => {
  assert.throws(
    () => requireType(EMPTY_REGISTRY, 'missing'),
    (error: unknown) => error instanceof FrameTypeError && error.code === 'frames/unknown-type',
  )
})

test('lookup by id answers undefined instead of throwing', () => {
  assert.equal(getType(EMPTY_REGISTRY, 'missing'), undefined)
  assert.equal(hasType(EMPTY_REGISTRY, 'missing'), false)
})
