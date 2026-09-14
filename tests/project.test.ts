import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyOp } from '../src/vendor/ui-dockkit/engine/operations.ts'
import { planSplitPane } from '../src/vendor/ui-dockkit/engine/planner.ts'
import type { LayoutOp, LayoutState } from '../src/vendor/ui-dockkit/contract/types.ts'
import { REACT_CAPABILITIES } from '../src/model/platform.ts'
import { createFrameState, withLayout, withMeasurements } from '../src/model/state.ts'
import type { FrameState } from '../src/model/state.ts'
import { FULL_RECT } from '../src/geometry/rect.ts'
import { project } from '../src/project/project.ts'
import type { FrameTypeDefinition } from '../src/model/types.ts'

const CONVERSATION: FrameTypeDefinition = { id: 'conversation', title: () => 'Conversation' }

const REACT = { id: 'react', capabilities: REACT_CAPABILITIES }

/** Apply a whole planned intent, the way the operation layer will. */
function applyAll(layout: LayoutState, ops: readonly LayoutOp[]): LayoutState {
  let next = layout
  for (const op of ops) next = applyOp(next, op).state
  return next
}

/** A state on the browser target, measured, with one split already applied. */
function splitOnce(base: FrameState): FrameState {
  const measured = withMeasurements(base, { viewport: { width: 1000, height: 800 } })
  return withLayout(measured, applyAll(measured.layout, planSplitPane(measured.layout, measured.minter.next)))
}

test('a configuration-free state projects one frame filling the area', () => {
  const state = createFrameState({ startup: CONVERSATION })
  const view = project(state)

  assert.equal(view.platform, 'unattached')
  assert.equal(view.empty, false)
  assert.equal(view.revision, 0)
  assert.equal(view.expanded, true)
  assert.equal(view.mode, 'push')
  assert.deepEqual(view.degradations, [])
  assert.equal(view.docked.length, 1)
  assert.deepEqual(view.docked[0]?.rect, FULL_RECT)
  // The chip carries the tab's identity, because a drag names the tab it moves.
  assert.deepEqual(
    view.docked[0]?.tabs.map((tab) => ({ ...tab, id: 'minted' })),
    [{ id: 'minted', typeId: 'conversation', title: 'Conversation', active: true }],
  )
  assert.equal(typeof view.docked[0]?.tabs[0]?.id, 'string')
  assert.equal(view.active, state.layout.activePaneId)
})

test('an unattached renderer is never told a split is possible', () => {
  const pane = project(createFrameState({ startup: CONVERSATION })).docked[0]

  assert.equal(pane?.canSplit, false)
  assert.equal(pane?.splitBlockedBy, 'narrow')
})

test('a measured renderer is told whether two halves would fit', () => {
  const base = createFrameState({ startup: CONVERSATION, platform: REACT })

  const roomy = project(withMeasurements(base, { viewport: { width: 1000, height: 800 } }))
  assert.equal(roomy.docked[0]?.canSplit, true)
  assert.equal(roomy.docked[0]?.splitBlockedBy, undefined)

  const cramped = project(withMeasurements(base, { viewport: { width: 100, height: 100 } }))
  assert.equal(cramped.docked[0]?.canSplit, false)
  assert.equal(cramped.docked[0]?.splitBlockedBy, 'narrow')
})

test('splitting yields two half-width panes and one divider', () => {
  const view = project(splitOnce(createFrameState({ startup: CONVERSATION, platform: REACT })))

  assert.equal(view.docked.length, 2)
  assert.deepEqual(view.docked.map((pane) => pane.rect.x), [0, 0.5])
  assert.deepEqual(view.docked.map((pane) => pane.rect.width), [0.5, 0.5])
  assert.equal(view.dividers.length, 1)
  assert.equal(view.dividers[0]?.axis, 'row')
  assert.equal(view.dividers[0]?.at, 0.5)
  assert.equal(view.dividers[0]?.rect.width, 0)
})

test('a pane the target cannot draw is reported as a degradation, not dropped in silence', () => {
  const platform = { id: 'narrow-budget', capabilities: { ...REACT_CAPABILITIES, maxDockPanes: 1 } }
  const view = project(splitOnce(createFrameState({ startup: CONVERSATION, platform })))

  assert.equal(view.docked.length, 1)
  assert.equal(view.degradations.length, 1)
  assert.equal(view.degradations[0]?.kind, 'pane-dropped')
  assert.equal(view.docked[0]?.canSplit, false)
  assert.equal(view.docked[0]?.splitBlockedBy, 'budget')
})

test('projection reads the state without changing it, and repeats exactly', () => {
  const state = splitOnce(createFrameState({ startup: CONVERSATION, platform: REACT }))
  const layoutBefore = JSON.stringify(state.layout)

  const first = project(state)
  const second = project(state)

  assert.equal(JSON.stringify(state.layout), layoutBefore)
  assert.deepEqual(second, first)
  assert.equal(first.revision, state.revision)
})
