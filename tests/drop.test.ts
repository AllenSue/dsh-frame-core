import { test } from 'node:test'
import assert from 'node:assert/strict'

import { REACT_CAPABILITIES, TUI_CAPABILITIES } from '../src/model/platform.ts'
import { createFrameState, withMeasurements } from '../src/model/state.ts'
import type { FrameState } from '../src/model/state.ts'
import type { FrameTypeDefinition } from '../src/model/types.ts'
import type { PaneId, TabId } from '../src/vendor/ui-dockkit/contract/types.ts'
import { dropFrame, placeFloat, placeTab, resizeSplit, splitFrame, undo } from '../src/ops/intents.ts'
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

/** The active tab of the focused pane. */
function activeTab(state: FrameState): TabId {
  const pane = state.layout.nodes[state.layout.activePaneId]
  assert.equal(pane?.kind, 'pane')
  const tabId = pane?.kind === 'pane' ? pane.activeTabId : undefined
  assert.notEqual(tabId, undefined)
  return tabId as TabId
}

/** The pane drawn at the left or right of a two-pane layout. */
function paneAt(state: FrameState, side: 'first' | 'last'): PaneId {
  const ordered = [...placedPanes(state.layout)].sort((a, b) => a.rect.x - b.rect.x)
  const chosen = side === 'first' ? ordered[0] : ordered[ordered.length - 1]
  assert.notEqual(chosen, undefined)
  return chosen?.id as PaneId
}

test('an edge release splits the target and seats the frame in the new half', () => {
  // Three panes, so the pane the frame leaves still disappears and the count
  // still grows: the release splits the *target*, not the source.
  const two = accepted(splitFrame(ready(), undefined, 'notes'))
  const three = accepted(splitFrame(two, paneAt(two, 'first'), 'notes'))
  const left = paneAt(three, 'first')
  const right = paneAt(three, 'last')
  const source = three.layout.nodes[left]
  assert.equal(source?.kind, 'pane')
  const dragged = (source?.kind === 'pane' ? source.tabs[0] : undefined) as TabId

  const next = accepted(dropFrame(three, dragged, { kind: 'dock', paneId: right, zone: 'right' }, 'conversation'))

  assert.equal(placedPanes(next.layout).length, 3)
  assert.equal(next.history.past.length, 3, 'the drop is one intent, however many operations it took')
  // The frame that was dragged is now the rightmost pane's content.
  const rightmost = [...placedPanes(next.layout)].sort((a, b) => a.rect.x - b.rect.x).at(-1)
  const landed = next.layout.nodes[rightmost?.id as PaneId]
  assert.equal(landed?.kind, 'pane')
  assert.equal(
    landed?.kind === 'pane' ? next.layout.tabs[landed.tabs[0] as TabId]?.kind : undefined,
    'conversation',
  )
})

test('dragging the only frame out of a pane merges that pane away in the same step', () => {
  // Both panes hold the same kind: a centre release seats the frame among the
  // target's tabs, and a pane holds one kind only. What this test is about is
  // the emptied pane, not the kind, so the fixture stays within one.
  const two = accepted(splitFrame(ready(), undefined, 'conversation'))
  const left = paneAt(two, 'first')
  const right = paneAt(two, 'last')
  const source = two.layout.nodes[left]
  const dragged = (source?.kind === 'pane' ? source.tabs[0] : undefined) as TabId

  // Dropped on the *centre* of the neighbour: the frame moves in and the pane it
  // came from has nothing left, so it disappears.
  const next = accepted(dropFrame(two, dragged, { kind: 'dock', paneId: right, zone: 'center' }))

  assert.equal(placedPanes(next.layout).length, 1)
  assert.equal(next.history.past.length, 2)
})

test('a release that would mix kinds in one pane is refused', () => {
  // The rule the fixture above respects. A centre release stacks the frame among
  // the target's tabs, and a pane holds one kind only.
  const two = accepted(splitFrame(ready(), undefined, 'notes'))
  const left = paneAt(two, 'first')
  const right = paneAt(two, 'last')
  const source = two.layout.nodes[left]
  const dragged = (source?.kind === 'pane' ? source.tabs[0] : undefined) as TabId

  const refused = dropFrame(two, dragged, { kind: 'dock', paneId: right, zone: 'center' })

  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false ? refused.code : '', 'frames/kind-mismatch')

  // An *edge* release is exempt, and rightly so: it makes a new pane, and the
  // frame takes its kind in with it.
  assert.equal(
    dropFrame(two, dragged, { kind: 'dock', paneId: right, zone: 'right' }, 'conversation').ok,
    true,
  )
  assert.equal(two.history.past.length, 1, 'a refusal records nothing')
})

test('a drop over nothing takes the frame out into a window', () => {
  const state = ready()
  const next = accepted(dropFrame(state, activeTab(state), { kind: 'float' }))

  assert.equal(next.layout.floats.length, 1)
  assert.equal(next.history.past.length, 1)
})

test('an edge release answers to the same three limits a keyboard split does', () => {
  const budgeted = withMeasurements(
    createFrameState({
      startup: CONVERSATION,
      platform: { id: 'react', capabilities: { ...REACT_CAPABILITIES, maxDockPanes: 1 } },
      types: [CONVERSATION],
    }),
    { viewport: { width: 1000, height: 800 } },
  )
  const pane = budgeted.layout.activePaneId
  assert.equal(
    refused(dropFrame(budgeted, activeTab(budgeted), { kind: 'dock', paneId: pane, zone: 'right' }, 'conversation')),
    'frames/pane-budget-exhausted',
  )
  assert.equal(budgeted.history.past.length, 0, 'a refusal leaves the history alone')

  const narrow = withMeasurements(
    createFrameState({
      startup: CONVERSATION,
      platform: { id: 'react', capabilities: REACT_CAPABILITIES },
      types: [CONVERSATION],
    }),
    { viewport: { width: 100, height: 100 } },
  )
  assert.equal(
    refused(dropFrame(narrow, activeTab(narrow), { kind: 'dock', paneId: narrow.layout.activePaneId, zone: 'bottom' }, 'conversation')),
    'frames/too-narrow',
  )

  const unsplittable = createFrameState({
    startup: { id: 'pinned', title: () => 'Pinned', policy: { splittable: false } },
    platform: { id: 'react', capabilities: REACT_CAPABILITIES },
    types: [{ id: 'pinned', title: () => 'Pinned', policy: { splittable: false } }],
  })
  const measured = withMeasurements(unsplittable, { viewport: { width: 1000, height: 800 } })
  assert.equal(
    refused(dropFrame(measured, activeTab(measured), { kind: 'dock', paneId: measured.layout.activePaneId, zone: 'right' })),
    'frames/policy-refused',
  )
})

test('a target with no floating frames refuses a release over nothing', () => {
  const terminal = withMeasurements(
    createFrameState({
      startup: CONVERSATION,
      platform: { id: 'headless', capabilities: { ...TUI_CAPABILITIES, floats: 'none' } },
      types: [CONVERSATION],
    }),
    { viewport: { width: 80, height: 24 } },
  )
  assert.equal(
    refused(dropFrame(terminal, activeTab(terminal), { kind: 'float' })),
    'frames/unsupported-on-platform',
  )
})

test('a release that would move nothing is accepted without becoming an undo step', () => {
  const state = ready()
  const pane = state.layout.activePaneId
  const next = accepted(dropFrame(state, activeTab(state), { kind: 'dock', paneId: pane, zone: 'center' }))

  assert.equal(next, state, 'the core answers a no-op with the very same state object')
  assert.equal(next.history.past.length, 0)
})

test('the two paths to a split agree on what the user ends up looking at', () => {
  const start = ready()

  // The key map: the frame stays where it is and a new one appears beside it.
  const byKey = accepted(splitFrame(start, undefined, 'conversation'))
  // The pointer: the frame is dragged to the same edge, and the pane it leaves
  // is backfilled by the type it was showing.
  const byDrag = accepted(
    dropFrame(start, activeTab(start), { kind: 'dock', paneId: start.layout.activePaneId, zone: 'right' }, 'conversation'),
  )

  const shape = (state: FrameState): unknown => project(state).docked
    .map((pane) => ({ rect: pane.rect, kinds: pane.tabs.map((tab) => tab.typeId) }))
    .sort((a, b) => a.rect.x - b.rect.x)

  assert.deepEqual(shape(byDrag), shape(byKey))
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
  const floated = accepted(dropFrame(ready(), activeTab(ready()), { kind: 'float' }))
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
  const floated = accepted(dropFrame(ready(), activeTab(ready()), { kind: 'float' }))
  const paneId = floated.layout.floats[0] as PaneId

  const next = accepted(placeFloat(floated, paneId, { x: 4, y: 4, width: 0.001, height: 0.001 }))
  const rect = project(next).floats[0]?.rect

  assert.ok(rect !== undefined)
  assert.ok(rect!.width >= 0.15 && rect!.height >= 0.15, 'the size floor holds')
  assert.ok(rect!.x + rect!.width <= 1.0001 && rect!.y + rect!.height <= 1.0001, 'it stays inside')
})

test('a chip moves to another caret slot in the strip it is already in', () => {
  // One kind throughout: what is being tested is the caret slot, and a pane
  // holds one kind only.
  const two = accepted(splitFrame(ready(), undefined, 'conversation'))
  const left = paneAt(two, 'first')
  const right = paneAt(two, 'last')
  const source = two.layout.nodes[right]
  const dragged = (source?.kind === 'pane' ? source.tabs[0] : undefined) as TabId

  // Dropping on the neighbour's centre is what puts two chips in one strip.
  const stacked = accepted(dropFrame(two, dragged, { kind: 'dock', paneId: left, zone: 'center' }))
  const node = stacked.layout.nodes[left]
  assert.equal(node?.kind, 'pane')
  const before = (node?.kind === 'pane' ? node.tabs : []).map((tabId) => stacked.layout.tabs[tabId]?.kind)
  assert.deepEqual(before, ['conversation', 'conversation'])

  const first = (node?.kind === 'pane' ? node.tabs[0] : undefined) as TabId
  const next = accepted(placeTab(stacked, first, left, 2))
  const after = next.layout.nodes[left]
  const order = (after?.kind === 'pane' ? after.tabs : [])
  assert.equal(order[0], node?.kind === 'pane' ? node.tabs[1] : undefined, 'the two swapped places')
})

test('a chip cannot be placed into a strip it is not in; that is a drop', () => {
  const two = accepted(splitFrame(ready(), undefined, 'notes'))
  const left = paneAt(two, 'first')
  const source = two.layout.nodes[paneAt(two, 'last')]
  const dragged = (source?.kind === 'pane' ? source.tabs[0] : undefined) as TabId

  assert.equal(refused(placeTab(two, dragged, left, 0)), 'frames/unknown-target')
  assert.equal(two.history.past.length, 1)
})
