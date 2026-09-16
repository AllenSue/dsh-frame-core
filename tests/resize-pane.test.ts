import { test } from 'node:test'
import assert from 'node:assert/strict'

import { REACT_CAPABILITIES } from '../src/model/platform.ts'
import { createFrameState, withMeasurements } from '../src/model/state.ts'
import type { FrameState } from '../src/model/state.ts'
import type { FrameTypeDefinition } from '../src/model/types.ts'
import type { PaneId } from '../src/vendor/ui-dockkit/contract/types.ts'
import { MIN_RESIZE_FRACTION, resizePane, splitFrame, undo } from '../src/ops/intents.ts'
import { placedPanes } from '../src/geometry/rects.ts'
import { createFramesService } from '../src/service/service.ts'

const CONVERSATION: FrameTypeDefinition = { id: 'conversation', title: () => 'Conversation' }
const NOTES: FrameTypeDefinition = { id: 'notes', title: () => 'Notes' }

const PLATFORM = { id: 'react', capabilities: REACT_CAPABILITIES }
const VIEWPORT = { viewport: { width: 1000, height: 800 } }

function ready(): FrameState {
  return withMeasurements(
    createFrameState({ startup: CONVERSATION, platform: PLATFORM, types: [CONVERSATION, NOTES] }),
    VIEWPORT,
  )
}

/** Unwrap an accepted result, failing the test on a refusal. */
function accepted(result: { ok: boolean } & Record<string, any>): FrameState {
  assert.equal(result.ok, true, `expected acceptance, got ${JSON.stringify(result)}`)
  return result.value as FrameState
}

/** The share each pane of a row occupies, left to right. */
function widths(state: FrameState): readonly number[] {
  return [...placedPanes(state.layout)].sort((a, b) => a.rect.x - b.rect.x).map((pane) => pane.rect.width)
}

/** The pane occupying the given horizontal share, left to right. */
function paneOrder(state: FrameState): readonly PaneId[] {
  return [...placedPanes(state.layout)].sort((a, b) => a.rect.x - b.rect.x).map((pane) => pane.id)
}

test('resizing a pane takes the difference out of its sibling', () => {
  const two = accepted(splitFrame(ready(), undefined, 'notes'))
  const [left] = paneOrder(two)
  assert.deepEqual(widths(two).map((width) => Math.round(width * 100)), [50, 50])

  const resized = accepted(resizePane(two, left as PaneId, 0.3))

  assert.deepEqual(widths(resized).map((width) => Math.round(width * 100)), [30, 70])
  assert.equal(resized.history.past.length, 2, 'one intent, one entry')
})

test('the shares still total one after a resize', () => {
  const two = accepted(splitFrame(ready(), undefined, 'notes'))
  const [left] = paneOrder(two)

  const resized = accepted(resizePane(two, left as PaneId, 0.37))

  assert.ok(Math.abs(widths(resized).reduce((sum, width) => sum + width, 0) - 1) < 1e-9)
})

test('a third child keeps its proportion to the sibling it is not sharing with', () => {
  // 1 | 2, then the second splits into two equal halves: 0.5 | 0.25 | 0.25.
  const two = accepted(splitFrame(ready(), undefined, 'notes'))
  const [left, right] = paneOrder(two)
  const three = accepted(splitFrame(two, right as PaneId, 'notes'))
  const before = widths(three)
  assert.deepEqual(before.map((width) => Math.round(width * 100)), [50, 25, 25])

  const resized = accepted(resizePane(three, left as PaneId, 0.2))

  const after = widths(resized)
  assert.ok(Math.abs((after[0] ?? 0) - 0.2) < 1e-9, 'the pane took the share it asked for')
  // The two siblings were equal and stay equal, still adding up to what is left.
  assert.ok(Math.abs((after[1] ?? 0) - (after[2] ?? 0)) < 1e-9)
  assert.ok(Math.abs((after[1] ?? 0) - 0.4) < 1e-9)
})

test('a deliberate resize may leave a pane thinner than a split would allow', () => {
  // The divider floor is 12%; a navigation rail is far under it, and this is the
  // whole reason the resize floor is a different number.
  const two = accepted(splitFrame(ready(), undefined, 'notes'))
  const [left] = paneOrder(two)

  const resized = accepted(resizePane(two, left as PaneId, 56 / 1000))

  assert.ok(Math.abs((widths(resized)[0] ?? 0) - 0.056) < 1e-9, 'the rail kept its width')
})

test('but a pane cannot be resized away entirely', () => {
  const two = accepted(splitFrame(ready(), undefined, 'notes'))
  const [left] = paneOrder(two)

  const resized = accepted(resizePane(two, left as PaneId, 0))

  assert.ok(Math.abs((widths(resized)[0] ?? 0) - MIN_RESIZE_FRACTION) < 1e-9)
})

test('a caller may set its own floor', () => {
  const two = accepted(splitFrame(ready(), undefined, 'notes'))
  const [left] = paneOrder(two)

  const resized = accepted(resizePane(two, left as PaneId, 0.01, 0.2))

  // Asked for a twentieth, allowed no less than a fifth.
  assert.ok(Math.abs((widths(resized)[0] ?? 0) - 0.2) < 1e-9)
})

test('the root pane has no parent, so there is no share to change', () => {
  const state = ready()

  const resized = accepted(resizePane(state, state.layout.activePaneId, 0.3))

  assert.equal(resized, state, 'a request with nothing to do changes nothing')
  assert.equal(resized.history.past.length, 0)
})

test('resizing to where it already is records nothing', () => {
  const two = accepted(splitFrame(ready(), undefined, 'notes'))
  const [left] = paneOrder(two)

  const again = accepted(resizePane(two, left as PaneId, 0.5))

  assert.equal(again, two)
  assert.equal(again.history.past.length, 1)
})

test('a resize steps back in one move', () => {
  const two = accepted(splitFrame(ready(), undefined, 'notes'))
  const [left] = paneOrder(two)
  const resized = accepted(resizePane(two, left as PaneId, 0.2))

  const back = accepted(undo(resized))

  assert.deepEqual(widths(back).map((width) => Math.round(width * 100)), [50, 50])
})

test('a pane that is not in the tree is refused', () => {
  const state = ready()

  const refused = resizePane(state, 'pane-ghost' as PaneId, 0.3)

  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false ? refused.code : '', 'frames/unknown-target')
})

test('the service carries the resize through', () => {
  const frames = createFramesService({ startup: CONVERSATION, platform: PLATFORM })
  frames.registerType(NOTES)
  frames.reportMeasurements(VIEWPORT)
  frames.split(undefined, 'notes')
  const left = [...frames.project().docked].sort((a, b) => a.rect.x - b.rect.x)[0]?.id as PaneId

  assert.equal(frames.resizePane(left, 0.28).ok, true)

  const widths = [...frames.project().docked].sort((a, b) => a.rect.x - b.rect.x).map((pane) => pane.rect.width)
  assert.deepEqual(widths.map((width) => Math.round(width * 100)), [28, 72])
})
