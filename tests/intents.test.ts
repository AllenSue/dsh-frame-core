import { test } from 'node:test'
import assert from 'node:assert/strict'

import { REACT_CAPABILITIES } from '../src/model/platform.ts'
import { createFrameState, withMeasurements } from '../src/model/state.ts'
import type { FrameState } from '../src/model/state.ts'
import type { FrameTypeDefinition } from '../src/model/types.ts'
import { closeFrame, focusFrame, moveFocus, redo, splitFrame, undo } from '../src/ops/intents.ts'
import { placedPanes } from '../src/geometry/rects.ts'

const CONVERSATION: FrameTypeDefinition = { id: 'conversation', title: () => 'Conversation' }

/** A measured browser-target state with the given extra types. */
function ready(startup: FrameTypeDefinition = CONVERSATION, budget = 4): FrameState {
  const platform = { id: 'react', capabilities: { ...REACT_CAPABILITIES, maxDockPanes: budget } }
  return withMeasurements(
    createFrameState({ startup, platform, types: [startup] }),
    { viewport: { width: 1000, height: 800 } },
  )
}

/** Unwrap an accepted result, failing the test on a refusal. */
function accepted(result: { ok: boolean } & Record<string, any>): FrameState {
  assert.equal(result.ok, true, `expected acceptance, got ${JSON.stringify(result)}`)
  return result.value as FrameState
}

test('a split is refused before any renderer has reported geometry', () => {
  const cold = createFrameState({ startup: CONVERSATION })
  const result = splitFrame(cold)

  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, 'frames/not-measured')
  assert.equal(cold.history.past.length, 0)
})

test('an accepted split yields two panes and exactly one history entry', () => {
  const state = accepted(splitFrame(ready(), undefined, 'conversation'))

  assert.equal(placedPanes(state.layout).length, 2)
  assert.equal(state.history.past.length, 1)
  assert.equal(state.history.future.length, 0)
})

test('the pane budget refuses a split and leaves the state untouched', () => {
  const once = accepted(splitFrame(ready(CONVERSATION, 2), undefined, 'conversation'))
  const result = splitFrame(once)

  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, 'frames/pane-budget-exhausted')
  assert.equal(once.history.past.length, 1)
})

test('directional focus walks to the neighbour and stops at the edge', () => {
  const split = accepted(splitFrame(ready(), undefined, 'conversation'))
  const ordered = [...placedPanes(split.layout)].sort((a, b) => a.rect.x - b.rect.x)
  const left = ordered[0]?.id as never
  const right = ordered[1]?.id as never

  // The split focuses the pane it created, so the neighbour is to the left.
  const back = accepted(moveFocus(split, 'left'))
  assert.equal(back.layout.activePaneId, left)
  assert.equal(back.history.past.length, 2)

  const forward = accepted(moveFocus(back, 'right'))
  assert.equal(forward.layout.activePaneId, right)

  // Nothing beyond the leftmost pane: focus stays and nothing is recorded.
  const atEdge = accepted(moveFocus(back, 'left'))
  assert.equal(atEdge.layout.activePaneId, left)
  assert.equal(atEdge.history.past.length, back.history.past.length)

  // Neither pane has anything above it.
  assert.equal(accepted(moveFocus(back, 'up')).layout.activePaneId, left)
})

test('focusing the pane that already has focus records nothing', () => {
  const state = ready()
  const same = accepted(focusFrame(state, state.layout.activePaneId))

  assert.equal(same.history.past.length, 0)
  assert.equal(same.revision, state.revision)
})

test('closing a split pane merges it away and undo brings it back', () => {
  const split = accepted(splitFrame(ready(), undefined, 'conversation'))
  const [left] = placedPanes(split.layout)
  const other = placedPanes(split.layout).find((pane) => pane.id !== left?.id)

  assert.notEqual(other, undefined)
  const closed = accepted(closeFrame(split, other?.id))
  assert.equal(placedPanes(closed.layout).length, 1)

  const back = accepted(undo(closed))
  assert.equal(placedPanes(back.layout).length, 2)
  assert.equal(back.history.future.length, 1)

  const again = accepted(redo(back))
  assert.equal(placedPanes(again.layout).length, 1)
})

/** The id of the pane holding nothing, if there is one. */
function emptyPane(state: FrameState): string | undefined {
  return placedPanes(state.layout)
    .map((pane) => state.layout.nodes[pane.id])
    .find((node) => node?.kind === 'pane' && node.tabs.length === 0)?.id
}

test('a frame with nothing in it is deleted by closing it', () => {
  // A split with no seed starts empty and waits for a choice: it is a frame the
  // user can see, so closing it has to take it away.
  const split = accepted(splitFrame(ready(), undefined))
  const empty = emptyPane(split)
  assert.notEqual(empty, undefined)
  assert.equal(split.history.past.length, 1)

  const closed = accepted(closeFrame(split, empty as never))
  assert.equal(placedPanes(closed.layout).length, 1)
  assert.equal(closed.history.past.length, 2)

  const back = accepted(undo(closed))
  assert.equal(placedPanes(back.layout).length, 2, 'and it is one step back')
})

test('the shell itself is not closed away', () => {
  const only = ready()
  // Closing the shell takes down what it shows and leaves the shell standing.
  const emptied = accepted(closeFrame(only))
  assert.equal(placedPanes(emptied.layout).length, 1)
  assert.notEqual(emptyPane(emptied), undefined)
  assert.equal(emptied.history.past.length, 1)

  // Closing it again has nothing to take down and nowhere to merge: the shell
  // stays, and a close that moves nothing records nothing.
  const again = accepted(closeFrame(emptied))
  assert.equal(placedPanes(again.layout).length, 1)
  assert.equal(again.history.past.length, 1)
})

test('a type that refuses closing produces a refusal, not a change', () => {
  const pinned: FrameTypeDefinition = {
    id: 'conversation',
    title: () => 'Conversation',
    policy: { closable: false },
  }
  const state = ready(pinned)
  const result = closeFrame(state)

  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, 'frames/policy-refused')
  assert.equal(state.history.past.length, 0)
})

test('undo with nothing recorded is a refusal', () => {
  const state = ready()
  const result = undo(state)

  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, 'frames/nothing-to-undo')
  assert.equal(redo(state).ok, false)
})

test('a new intent drops the redo branch', () => {
  const split = accepted(splitFrame(ready(), undefined, 'conversation'))
  const [left] = placedPanes(split.layout)
  const other = placedPanes(split.layout).find((pane) => pane.id !== left?.id)
  const closed = accepted(closeFrame(split, other?.id))
  const stepped = accepted(undo(closed))
  assert.equal(stepped.history.future.length, 1)

  const branched = accepted(focusFrame(stepped, left?.id as never))
  assert.equal(branched.history.future.length, 0)
})
