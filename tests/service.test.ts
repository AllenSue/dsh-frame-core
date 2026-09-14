import { test } from 'node:test'
import assert from 'node:assert/strict'

import { REACT_CAPABILITIES } from '../src/model/platform.ts'
import type { FrameTypeDefinition } from '../src/model/types.ts'
import { createFramesService, provideFramesService } from '../src/service/service.ts'

const CONVERSATION: FrameTypeDefinition = { id: 'conversation', title: () => 'Conversation' }
const FILES: FrameTypeDefinition = { id: 'files', title: () => 'Files' }

/** A service on the browser target, measured and ready to split. */
function ready() {
  const service = createFramesService({ startup: CONVERSATION })
  service.attachRenderer({ id: 'react', capabilities: REACT_CAPABILITIES })
  service.reportMeasurements({ viewport: { width: 1000, height: 800 } })
  return service
}

test('the service starts on one frame and reports what is focused', () => {
  const service = ready()

  assert.equal(service.project().docked.length, 1)
  assert.equal(service.project().platform, 'react')
  assert.equal(service.activeTypeId(), CONVERSATION.id)
  assert.equal(service.isOpen(CONVERSATION.id), true)
  assert.equal(service.isOpen(FILES.id), false)
})

test('a subscriber is told about accepted changes and nothing else', () => {
  const service = ready()
  let notified = 0
  service.subscribe(() => { notified += 1 })

  assert.equal(service.split().ok, true)
  assert.equal(notified, 1)

  // An unknown type is a refusal: nothing changes, so nothing is published.
  assert.equal(service.open('missing').ok, false)
  assert.equal(notified, 1)

  // Focusing the frame that already has focus records nothing.
  const active = service.project().active
  assert.notEqual(active, undefined)
  assert.equal(service.focus(active as never).ok, true)
  assert.equal(notified, 1)
})

test('the projection reference only changes when the layout does', () => {
  const service = ready()
  const first = service.project()

  assert.equal(service.project(), first)
  service.split()
  assert.notEqual(service.project(), first)
})

test('registering a type is visible to the service, not to the pane count', () => {
  const service = ready()
  service.registerType(FILES)

  assert.equal(service.isOpen(FILES.id), false)
  assert.equal(service.project().docked.length, 1)
})

test('providing the service publishes it under one name and withdraws it once', () => {
  const provided: string[] = []
  let disposed = 0
  const host = {
    reflect: {
      provide(name: string, value: unknown): () => void {
        provided.push(name)
        assert.notEqual(value, undefined)
        return () => { disposed += 1 }
      },
    },
  }

  const { service, dispose } = provideFramesService(host, { startup: CONVERSATION })
  assert.deepEqual(provided, ['frames'])
  assert.equal(service.project().docked.length, 1)

  dispose()
  assert.equal(disposed, 1)
})
