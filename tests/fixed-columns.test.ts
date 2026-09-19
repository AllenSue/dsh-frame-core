import { test } from 'node:test'
import assert from 'node:assert/strict'

import { REACT_CAPABILITIES } from '../src/model/platform.ts'
import { createFrameState, withMeasurements } from '../src/model/state.ts'
import type { FrameState } from '../src/model/state.ts'
import type { FrameTypeDefinition } from '../src/model/types.ts'
import type { PaneId } from '../src/vendor/ui-dockkit/contract/types.ts'
import { closeFrame, floatFrame, openContent, registerFrame, splitFrame, undo } from '../src/ops/intents.ts'
import { placedPanes } from '../src/geometry/rects.ts'
import { project } from '../src/project/project.ts'

const CONVERSATION: FrameTypeDefinition = { id: 'conversation', title: () => 'Conversation' }
const NOTES: FrameTypeDefinition = { id: 'notes', title: () => 'Notes' }
/** A column that asks to stay where it is. */
const RAIL: FrameTypeDefinition = {
  id: 'rail',
  title: () => 'Rail',
  policy: { grows: false },
}

const PLATFORM = { id: 'react', capabilities: REACT_CAPABILITIES }
const VIEWPORT = { viewport: { width: 1000, height: 800 } }

/** A measured state with every type registered. */
function ready(types: readonly FrameTypeDefinition[] = [CONVERSATION, NOTES, RAIL]): FrameState {
  return withMeasurements(
    createFrameState({ startup: CONVERSATION, platform: PLATFORM, types }),
    VIEWPORT,
  )
}

/** Unwrap an accepted result, failing the test on a refusal. */
function accepted(result: { ok: boolean } & Record<string, any>): FrameState {
  assert.equal(result.ok, true, `expected acceptance, got ${JSON.stringify(result)}`)
  return result.value as FrameState
}

/**
 * A measured state whose `rail` content is registered but shown nowhere.
 *
 * `openContent` names a content, not a type, so a fixture that wants a column has
 * to have made one first 鈥?the same two steps a plugin takes.
 */
function withRail(types: readonly FrameTypeDefinition[] = [CONVERSATION, NOTES, RAIL]): FrameState {
  return accepted(registerFrame(ready(types), { id: 'rail', kind: 'rail', title: 'Rail' }))
}

/** The panes of a row, left to right. */
function columns(state: FrameState): readonly { id: PaneId; rect: { x: number; y: number; width: number } }[] {
  return [...placedPanes(state.layout)].sort((left, right) => left.rect.x - right.rect.x)
}

/** The widths of the panes showing the named kinds, in draw order. */
function widthsByKind(state: FrameState): Readonly<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const pane of placedPanes(state.layout)) {
    const node = state.layout.nodes[pane.id]
    if (node === undefined || node.kind !== 'pane') continue
    const first = node.tabs[0]
    const kind = first === undefined ? '' : state.layout.tabs[first]?.kind ?? ''
    if (kind !== '') out[kind] = Math.round(pane.rect.width * 1000)
  }
  return out
}

/** A row of rail | conversation | notes, made the way a person would. */
function threeColumns(): { state: FrameState; rail: PaneId; centre: PaneId; notes: PaneId } {
  // The rail goes on the left, then the centre takes its own split on the right:
  // three children in one row when the axes line up.
  const railed = accepted(openContent(withRail(), 'rail', { place: 'left' }))
  const first = columns(railed)
  const rail = first[0]?.id as PaneId
  const centre = first[1]?.id as PaneId
  const three = accepted(splitFrame(railed, centre, 'notes'))
  return { state: three, rail, centre, notes: columns(three)[2]?.id as PaneId }
}

test('the fixture really is one row of three', () => {
  const { state } = threeColumns()

  assert.equal(placedPanes(state.layout).length, 3)
  const rects = columns(state)
  for (const pane of rects) assert.equal(pane.rect.y, 0, 'all three share the row')
  // One split holds all three, which is what makes the collapse renormalise.
  const splits = Object.values(state.layout.nodes).filter((node) => node.kind === 'split')
  assert.equal(splits.length, 1, 'a flat row, not a nest')
  assert.equal(splits[0]?.kind === 'split' ? splits[0].children.length : 0, 3)
})

test('closing a frame widens only what agreed to take the room', () => {
  const { state, notes } = threeColumns()
  const before = widthsByKind(state)
  assert.deepEqual(Object.keys(before).sort(), ['conversation', 'notes', 'rail'])

  const closed = accepted(closeFrame(state, notes))
  const after = widthsByKind(closed)

  assert.equal(after.rail, before.rail, 'the rail kept its width to the pixel')
  assert.ok(
    (after.conversation ?? 0) > (before.conversation ?? 0),
    'and the centre took everything that was freed',
  )
  // Nothing leaked: the two widths add back up to the whole frame.
  assert.ok(Math.abs((after.rail ?? 0) + (after.conversation ?? 0) - 1000) <= 2)
})

test('without the preference every survivor takes a proportional bite', () => {
  // The same shape with a rail that never asked to stay put: this is the
  // behaviour the preference exists to opt out of.
  const greedy: FrameTypeDefinition = { id: 'rail', title: () => 'Rail' }
  const state = accepted(openContent(withRail([CONVERSATION, NOTES, greedy]), 'rail', { place: 'left' }))
  const centre = columns(state)[1]?.id as PaneId
  const three = accepted(splitFrame(state, centre, 'notes'))
  const before = widthsByKind(three)
  const notes = columns(three)[2]?.id as PaneId

  const after = widthsByKind(accepted(closeFrame(three, notes)))

  assert.ok((after.rail ?? 0) > (before.rail ?? 0), 'it grew, which is what the fixture is for')
})

test('when every survivor is fixed the row still adds up', () => {
  const fixed: FrameTypeDefinition = { id: 'notes', title: () => 'Notes', policy: { grows: false } }
  const state = accepted(openContent(withRail([CONVERSATION, fixed, RAIL]), 'rail', { place: 'left' }))
  const centre = columns(state)[1]?.id as PaneId
  const three = accepted(splitFrame(state, centre, 'notes'))
  const notes = columns(three)[2]?.id as PaneId

  const after = widthsByKind(accepted(closeFrame(three, notes)))

  assert.ok(Math.abs((after.rail ?? 0) + (after.conversation ?? 0) - 1000) <= 2, 'it still fills the frame')
})

test('the giveaway rides in the same history entry as the close', () => {
  const { state, notes } = threeColumns()
  const before = widthsByKind(state)

  const closed = accepted(closeFrame(state, notes))
  assert.equal(closed.history.past.length, state.history.past.length + 1, 'one intent, one entry')

  const back = accepted(undo(closed))
  assert.deepEqual(widthsByKind(back), before, 'and one step restores the widths too')
})

test('floating a frame out gives the room back the same way', () => {
  // Every path that collapses a split goes through the same settling, not just
  // closing: a rail must not jump because a neighbour left by another door.
  const { state, notes } = threeColumns()
  const before = widthsByKind(state)

  const floated = accepted(floatFrame(state, notes))

  assert.equal(widthsByKind(floated).rail, before.rail, 'the rail kept its width here too')
  assert.ok(
    Math.abs((widthsByKind(floated).rail ?? 0) + (widthsByKind(floated).conversation ?? 0) - 1000) <= 2,
  )
})

test('a projection reports the settled widths, not the renormalised ones', () => {
  const { state, notes } = threeColumns()
  const closed = accepted(closeFrame(state, notes))
  const rail = project(closed).docked.find((pane) => pane.tabs[0]?.typeId === 'rail')

  assert.equal(Math.round((rail?.rect.width ?? 0) * 1000), widthsByKind(state).rail)
})





