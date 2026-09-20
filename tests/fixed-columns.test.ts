import { test } from 'node:test'
import assert from 'node:assert/strict'

import { REACT_CAPABILITIES } from '../src/model/platform.ts'
import { createFrameState, withMeasurements } from '../src/model/state.ts'
import type { FrameState } from '../src/model/state.ts'
import type { FrameTypeDefinition } from '../src/model/types.ts'
import type { PaneId } from '../src/vendor/ui-dockkit/contract/types.ts'
import { closeFrame, floatFrame, openContent, registerFrame, resizePane, resizeSplit, splitFrame, undo } from '../src/ops/intents.ts'
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

/** One pane's width in px of the fixture's 1000px viewport. */
function widthOf(state: FrameState, paneId: PaneId): number {
  return Math.round((placedPanes(state.layout).find((pane) => pane.id === paneId)?.rect.width ?? 0) * 1000)
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
  const rail = project(closed).docked.find((pane) => pane.content?.typeId === 'rail')

  assert.equal(Math.round((rail?.rect.width ?? 0) * 1000), widthsByKind(state).rail)
})

// ------------------------------------------------- fixed means fixed, both ways

test('a fixed column keeps its width when a sibling asks for room', () => {
  // The shipped third column opening: somebody asks the middle pane for a share.
  // The rail used to concede a proportional bite of it and come back narrower —
  // which is what "grows: false" was supposed to prevent, and did not, because it
  // only covered room *freed* by a departure and not room *asked for* by a
  // sibling. The shipped grid kept the rail at its exact width and squeezed the
  // centre alone (`280px minmax(0, 1fr) 0`).
  const { state, rail, centre } = threeColumns()
  const before = widthsByKind(state)

  const asked = accepted(resizePane(state, centre, 0.4))
  const after = widthsByKind(asked)

  assert.equal(after.rail, before.rail, 'the rail kept its width to the pixel')
  assert.equal(widthOf(asked, centre), 400, 'and the asker got what it asked for')
  assert.ok(
    Math.abs((after.rail ?? 0) + (after.conversation ?? 0) + (after.notes ?? 0) - 1000) <= 2,
    'the row still fills the frame',
  )
  assert.ok((after.notes ?? 0) < 250, 'the room came out of the pane that could give it')
})

test('asking for more than the rest can give is refused, not rounded down', () => {
  const { state, centre } = threeColumns()
  const entries = state.history.past.length
  const room = 1 - ((widthsByKind(state).rail ?? 0) / 1000)
  assert.ok(Math.abs(room - 0.5) < 0.01, 'the fixture leaves half the row to the others')

  const result = resizePane(state, centre, room + 0.1)

  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.code, 'frames/policy-refused')
  assert.equal(state.history.past.length, entries, 'and nothing was recorded')
})

test('a divider drag cannot move a fixed column', () => {
  const { state, rail } = threeColumns()
  const before = widthsByKind(state)
  const split = Object.values(state.layout.nodes).find((node) => node.kind === 'split')
  assert.equal(split?.kind, 'split')

  // A drag hands over the whole row's sizes, as the renderer does — so a fixed
  // child anywhere in that row would be moved by a drag that never touched it.
  const dragged = accepted(resizeSplit(state, (split as { id: string }).id as never, [0.4, 0.3, 0.3]))
  const after = widthsByKind(dragged)

  assert.equal(after.rail, before.rail, 'the rail did not follow the pointer')
  assert.ok(
    Math.abs((after.rail ?? 0) + (after.conversation ?? 0) + (after.notes ?? 0) - 1000) <= 2,
    'and the row still fills the frame',
  )
})

test('the divider beside a fixed column is reported as immovable', () => {
  const { state } = threeColumns()
  const [besideRail, besideOthers] = project(state).dividers

  // The projection is what a renderer reads to decide where a grab handle goes:
  // the core will carry the rail's share over, so that boundary cannot follow a
  // pointer and the handle should not be offered.
  assert.equal(besideRail?.movable, false)
  assert.equal(besideOthers?.movable, true)
})





