import { test } from 'node:test'
import assert from 'node:assert/strict'

import { REACT_CAPABILITIES, TUI_CAPABILITIES } from '../src/model/platform.ts'
import { createFrameState, withMeasurements } from '../src/model/state.ts'
import type { FrameState } from '../src/model/state.ts'
import type { FrameTypeDefinition } from '../src/model/types.ts'
import { dockFrame, floatFrame, splitFrame } from '../src/ops/intents.ts'
import { placedPanes } from '../src/geometry/rects.ts'
import { project } from '../src/project/project.ts'

const CONVERSATION: FrameTypeDefinition = { id: 'conversation', title: () => 'Conversation' }

/** A measured state on the named target. */
function ready(capabilities = REACT_CAPABILITIES): FrameState {
  return withMeasurements(
    createFrameState({ startup: CONVERSATION, platform: { id: 'test', capabilities }, types: [CONVERSATION] }),
    { viewport: { width: 1000, height: 800 } },
  )
}

/** Unwrap an accepted result, failing the test on a refusal. */
function accepted(result: { ok: boolean } & Record<string, any>): FrameState {
  assert.equal(result.ok, true, `expected acceptance, got ${JSON.stringify(result)}`)
  return result.value as FrameState
}

test('floating a pane moves it out of the docked tree and into the projection', () => {
  const floated = accepted(floatFrame(ready()))

  assert.equal(floated.layout.floats.length, 1)
  assert.equal(floated.history.past.length, 1)
  // The root pane stays behind with nothing in it: reseeding an emptied root is
  // the content provider's decision, not the core's.
  assert.equal(placedPanes(floated.layout).length, 1)
  assert.equal(project(floated).docked[0]?.content, undefined)

  const view = project(floated)
  assert.equal(view.floats.length, 1)
  assert.equal(view.floats[0]?.presentation, 'window')
  assert.equal(view.floats[0]?.rectHonoured, true)
  assert.equal(view.floats[0]?.content?.title, 'Conversation')
  assert.deepEqual(view.degradations, [])
})

test('a floating rectangle is normalized, never the engine pixel default', () => {
  const view = project(accepted(floatFrame(ready())))
  const rect = view.floats[0]?.rect

  for (const value of [rect?.x, rect?.y, rect?.width, rect?.height]) {
    assert.equal(typeof value, 'number')
    assert.equal(value !== undefined && value >= 0 && value <= 1, true, `${String(value)} is outside the unit square`)
  }
})

test('docking brings the frame back into the tree', () => {
  const floated = accepted(floatFrame(ready()))
  const docked = accepted(dockFrame(floated))

  assert.equal(docked.layout.floats.length, 0)
  assert.equal(placedPanes(docked.layout).length, 1)
  assert.equal(project(docked).floats.length, 0)
})

test('a target that cannot float refuses the move without changing anything', () => {
  const state = ready({ ...REACT_CAPABILITIES, floats: 'none' })
  const result = floatFrame(state)

  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, 'frames/unsupported-on-platform')
  assert.equal(state.layout.floats.length, 0)
  assert.equal(state.history.past.length, 0)
})

test('a target without rectangles keeps the rectangle unread and says so', () => {
  const floated = accepted(floatFrame(ready(TUI_CAPABILITIES)))
  const view = project(floated)

  assert.equal(view.floats[0]?.presentation, 'overlay')
  assert.equal(view.floats[0]?.rectHonoured, false)
  assert.equal(view.degradations.some((item) => item.kind === 'rect-ignored'), true)
})

test('a target that cannot float at all drops the frame and says so', () => {
  const floated = accepted(floatFrame(ready()))
  const blind = { ...floated, platform: { id: 'blind', capabilities: { ...REACT_CAPABILITIES, floats: 'none' as const } } }
  const view = project(blind)

  assert.equal(view.floats.length, 0)
  assert.equal(view.degradations.some((item) => item.kind === 'float-dropped'), true)
  // Nothing was rewritten: the model still carries the frame.
  assert.equal(blind.layout.floats.length, 1)
})

test('floating and docking the state they are already in change nothing', () => {
  const docked = ready()
  assert.equal(accepted(dockFrame(docked)).revision, docked.revision)

  const floated = accepted(floatFrame(docked))
  assert.equal(accepted(floatFrame(floated)).revision, floated.revision)

  const back = accepted(dockFrame(floated))
  assert.equal(accepted(dockFrame(back)).revision, back.revision)
})

test('a split pane can be floated without disturbing its sibling', () => {
  const split = accepted(splitFrame(ready(), undefined, 'conversation'))
  const [left, right] = [...placedPanes(split.layout)].sort((a, b) => a.rect.x - b.rect.x)

  const floated = accepted(floatFrame(split, left?.id))
  assert.equal(placedPanes(floated.layout).length, 1)
  assert.equal(placedPanes(floated.layout)[0]?.id, right?.id)
  assert.equal(project(floated).floats.length, 1)
})
