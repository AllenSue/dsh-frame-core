import { test } from 'node:test'
import assert from 'node:assert/strict'

import { REACT_CAPABILITIES } from '../src/model/platform.ts'
import { createFrameState, withMeasurements } from '../src/model/state.ts'
import type { FrameState } from '../src/model/state.ts'
import type { FrameTypeDefinition } from '../src/model/types.ts'
import type { PaneId, TabId } from '../src/vendor/ui-dockkit/contract/types.ts'
import { dropFrame, floatFrame, placeFloat, placeTab, resizeSplit, splitFrame, undo } from '../src/ops/intents.ts'
import { placedPanes } from '../src/geometry/rects.ts'
import { project } from '../src/project/project.ts'

const CONVERSATION: FrameTypeDefinition = { id: 'conversation', title: () => 'Conversation' }

/** A second type, so a drop can move something other than the startup frame. */
const NOTES: FrameTypeDefinition = { id: 'notes', title: () => 'Notes' }

/** A measured browser-target state with both types registered. */
function ready(types: FrameTypeDefinition[] = [CONVERSATION, NOTES]): FrameState {
  return withMeasurements(
    createFrameState({ startup: CONVERSATION, platform: { id: 'react', capabilities: REACT_CAPABILITIES }, types }),
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

/** The pane drawn at the left or right of a two-pane layout. */
function paneAt(state: FrameState, side: 'first' | 'last'): PaneId {
  const ordered = [...placedPanes(state.layout)].sort((a, b) => a.rect.x - b.rect.x)
  const chosen = side === 'first' ? ordered[0] : ordered[ordered.length - 1]
  assert.notEqual(chosen, undefined)
  return chosen?.id as PaneId
}

test('a tab-level drop is refused, and says why', () => {
  // Retired with the tab strip: a pointer used to pick up a chip, and a frame
  // displays one content now, so there is no chip. The intent stays in the
  // vocabulary and refuses rather than quietly meaning something else.
  const two = accepted(splitFrame(ready(), undefined, 'notes'))
  const left = paneAt(two, 'first')
  const source = two.layout.nodes[paneAt(two, 'last')]
  const dragged = (source?.kind === 'pane' ? source.tabs[0] : undefined) as TabId

  assert.equal(
    refused(dropFrame(two, dragged, { kind: 'dock', paneId: left, zone: 'center' })),
    'frames/one-content-per-frame',
  )
  assert.equal(refused(dropFrame(two, dragged, { kind: 'float' })), 'frames/one-content-per-frame')
  assert.equal(two.history.past.length, 1, 'a refusal records nothing')
})

test('a chip reorder is refused, and says why', () => {
  const two = accepted(splitFrame(ready(), undefined, 'notes'))
  const left = paneAt(two, 'first')
  const source = two.layout.nodes[left]
  const tab = (source?.kind === 'pane' ? source.tabs[0] : undefined) as TabId

  assert.equal(refused(placeTab(two, tab, left, 0)), 'frames/one-content-per-frame')
  assert.equal(two.history.past.length, 1)
})


test('a divider drag records the sizes it reached, and steps back in one move', () => {
  const two = accepted(splitFrame(ready(), undefined, 'notes'))
  const divider = project(two).dividers[0]
  assert.notEqual(divider, undefined)

  const next = accepted(resizeSplit(two, divider!.splitId, [0.7, 0.3]))

  assert.deepEqual(project(next).docked.map((pane) => Math.round(pane.rect.width * 100)), [70, 30])
  assert.equal(next.history.past.length, 2)
  const back = accepted(undo(next))
  assert.deepEqual(project(back).docked.map((pane) => Math.round(pane.rect.width * 100)), [50, 50])
})

test('a divider drag below the pane floor is clamped rather than refused', () => {
  const two = accepted(splitFrame(ready(), undefined, 'notes'))
  const divider = project(two).dividers[0]!
  const next = accepted(resizeSplit(two, divider.splitId, [0.01, 0.99]))

  const widths = project(next).docked.map((pane) => pane.rect.width)
  assert.ok((widths[0] ?? 0) > 0.1, `expected the floor to hold, got ${widths[0]}`)
  assert.ok(widths[0]! + widths[1]! > 0.999)
})

test('a divider drag that reaches where it already was records nothing', () => {
  const two = accepted(splitFrame(ready(), undefined, 'notes'))
  const divider = project(two).dividers[0]!
  const next = accepted(resizeSplit(two, divider.splitId, divider.sizes))

  assert.equal(next, two)
  assert.equal(next.history.past.length, 1)
})

test('a floating frame moves and resizes through one intent', () => {
  const floated = accepted(floatFrame(ready()))
  const paneId = floated.layout.floats[0] as PaneId
  const start = floated.layout.nodes[paneId]
  assert.equal(start?.kind, 'pane')
  const rect = (start?.kind === 'pane' ? start.rect : undefined) ?? { x: 0, y: 0, width: 1, height: 1 }

  const moved = accepted(placeFloat(floated, paneId, { ...rect, x: 0.1, y: 0.2 }))
  assert.deepEqual(project(moved).floats[0]?.rect, { ...rect, x: 0.1, y: 0.2 })

  const larger = accepted(placeFloat(moved, paneId, { x: 0.1, y: 0.2, width: 0.8, height: 0.7 }))
  assert.deepEqual(project(larger).floats[0]?.rect, { x: 0.1, y: 0.2, width: 0.8, height: 0.7 })
})

test('a floating rectangle is kept inside the area and above the size floor', () => {
  const floated = accepted(floatFrame(ready()))
  const paneId = floated.layout.floats[0] as PaneId

  const next = accepted(placeFloat(floated, paneId, { x: 4, y: 4, width: 0.001, height: 0.001 }))
  const rect = project(next).floats[0]?.rect

  assert.ok(rect !== undefined)
  assert.ok(rect!.width >= 0.15 && rect!.height >= 0.15, 'the size floor holds')
  assert.ok(rect!.x + rect!.width <= 1.0001 && rect!.y + rect!.height <= 1.0001, 'it stays inside')
})

