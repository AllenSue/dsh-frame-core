import { test } from 'node:test'
import assert from 'node:assert/strict'

import { REACT_CAPABILITIES } from '../src/model/platform.ts'
import { createFrameState, withMeasurements } from '../src/model/state.ts'
import type { FrameState } from '../src/model/state.ts'
import type { FrameTypeDefinition } from '../src/model/types.ts'
import type { PaneId } from '../src/vendor/ui-dockkit/contract/types.ts'
import { openContent, placementSplit, registerFrame, splitFrame } from '../src/ops/intents.ts'
import type { Placement } from '../src/ops/intents.ts'
import { placedPanes } from '../src/geometry/rects.ts'
import { createFramesService } from '../src/service/service.ts'

const CONVERSATION: FrameTypeDefinition = { id: 'conversation', title: () => 'Conversation' }
const SIDEBAR: FrameTypeDefinition = { id: 'sidebar', title: () => 'Sidebar' }

const PLATFORM = { id: 'react', capabilities: REACT_CAPABILITIES }
const VIEWPORT = { viewport: { width: 1000, height: 800 } }

/** A measured browser-target state with both types registered. */
function ready(): FrameState {
  return withMeasurements(
    createFrameState({ startup: CONVERSATION, platform: PLATFORM, types: [CONVERSATION, SIDEBAR] }),
    VIEWPORT,
  )
}

/** Unwrap an accepted result, failing the test on a refusal. */
function accepted(result: { ok: boolean } & Record<string, any>): FrameState {
  assert.equal(result.ok, true, `expected acceptance, got ${JSON.stringify(result)}`)
  return result.value as FrameState
}

/** The pane a content is currently shown in. */
function paneShowing(state: FrameState, contentId: string): PaneId {
  for (const node of Object.values(state.layout.nodes)) {
    if (node.kind !== 'pane') continue
    if (node.tabs.some((tabId) => state.layout.tabs[tabId]?.contentId === contentId)) return node.id
  }
  throw new Error(`no pane shows "${contentId}"`)
}

/** The area of the pane a content is shown in. */
function areaOf(state: FrameState, contentId: string): { x: number; y: number; width: number; height: number } {
  const id = paneShowing(state, contentId)
  const placed = placedPanes(state.layout).find((pane) => pane.id === id)
  assert.notEqual(placed, undefined)
  return placed!.rect
}

test('a placement names an axis and a side, and every side is covered', () => {
  assert.deepEqual(placementSplit('left'), { axis: 'row', direction: 'before' })
  assert.deepEqual(placementSplit('right'), { axis: 'row', direction: 'after' })
  assert.deepEqual(placementSplit('above'), { axis: 'column', direction: 'before' })
  assert.deepEqual(placementSplit('below'), { axis: 'column', direction: 'after' })
})

test('a frame opened to the left really lands to the left', () => {
  const state = ready()
  const registered = accepted(registerFrame(state, { id: 'nav', kind: 'sidebar', title: 'Nav' }))

  const opened = accepted(openContent(registered, 'nav', { place: 'left' }))
  const nav = areaOf(opened, 'nav')
  const centre = areaOf(opened, 'conversation')

  assert.ok(nav.x < centre.x, `expected nav at ${String(nav.x)} to be left of ${String(centre.x)}`)
  assert.equal(nav.y, centre.y)
  assert.ok(nav.width + centre.width > 0.999, 'together they fill the row')
})

test('a frame opened to the right really lands to the right', () => {
  const state = ready()
  const registered = accepted(registerFrame(state, { id: 'right', kind: 'sidebar', title: 'Right' }))

  const opened = accepted(openContent(registered, 'right', { place: 'right' }))
  const right = areaOf(opened, 'right')
  const centre = areaOf(opened, 'conversation')

  assert.ok(right.x > centre.x, 'the new frame is to the right of the reference')
  assert.ok(Math.abs(right.x + right.width - 1) < 1e-9, 'and reaches the far edge')
})

test('above and below land on the other axis', () => {
  for (const [place, first, second] of [
    ['above', 'nav', 'conversation'],
    ['below', 'conversation', 'nav'],
  ] as readonly [Placement, string, string][]) {
    const state = ready()
    const registered = accepted(registerFrame(state, { id: 'nav', kind: 'sidebar', title: 'Nav' }))
    const opened = accepted(openContent(registered, 'nav', { place }))

    const upper = areaOf(opened, first)
    const lower = areaOf(opened, second)
    assert.ok(upper.y < lower.y, `${place}: expected ${first} above ${second}`)
    assert.equal(upper.x, lower.x)
  }
})

test('the frame goes beside the one it was told to, not the focused one', () => {
  // Two panes side by side, focus on the one the split created.
  const split = accepted(splitFrame(ready(), undefined, 'sidebar'))
  const panes = [...placedPanes(split.layout)].sort((a, b) => a.rect.x - b.rect.x)
  const left = panes[0]?.id as PaneId
  const right = panes[1]?.id as PaneId
  assert.equal(split.layout.activePaneId, right, 'the split focused the pane it made')

  const registered = accepted(registerFrame(split, { id: 'nav', kind: 'sidebar', title: 'Nav' }))
  const opened = accepted(openContent(registered, 'nav', { place: 'right', beside: left }))

  const nav = areaOf(opened, 'nav')
  const leftRect = placedPanes(opened.layout).find((pane) => pane.id === left)?.rect
  const rightRect = placedPanes(opened.layout).find((pane) => pane.id === right)?.rect

  assert.notEqual(leftRect, undefined)
  assert.notEqual(rightRect, undefined)
  // The reference shrank; the frame that was already beside it did not move.
  assert.equal(leftRect?.x, 0, 'the reference kept its left edge')
  assert.ok(nav.x >= (leftRect?.x ?? 0) + (leftRect?.width ?? 0) - 1e-9, 'nav is right of its reference')
  assert.ok(nav.x + nav.width <= (rightRect?.x ?? 0) + 1e-9, 'nav is left of the pane already there')
  assert.equal(rightRect?.x, 0.5, 'the pane that was already right stayed right')
})

test('placing a frame the shell already shows focuses it rather than placing a second', () => {
  const state = ready()
  const registered = accepted(registerFrame(state, { id: 'nav', kind: 'sidebar', title: 'Nav' }))
  const opened = accepted(openContent(registered, 'nav', { place: 'left' }))
  const count = placedPanes(opened.layout).length

  const again = accepted(openContent(opened, 'nav', { place: 'right', beside: state.layout.activePaneId }))

  assert.equal(placedPanes(again.layout).length, count, 'no new frame')
  assert.equal(again.layout.activePaneId, paneShowing(opened, 'nav'))
})

test('a placement is still refused by the same three limits', () => {
  const tight = withMeasurements(
    createFrameState({ startup: CONVERSATION, platform: PLATFORM, types: [CONVERSATION, SIDEBAR] }),
    { viewport: { width: 100, height: 100 } },
  )
  const registered = accepted(registerFrame(tight, { id: 'nav', kind: 'sidebar', title: 'Nav' }))

  const refused = openContent(registered, 'nav', { place: 'left' })

  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false ? refused.code : '', 'frames/too-narrow')
})

test('the service carries placements through', () => {
  const frames = createFramesService({ startup: CONVERSATION, platform: PLATFORM })
  frames.registerType(SIDEBAR)
  frames.reportMeasurements(VIEWPORT)
  frames.registerContent({ id: 'nav', kind: 'sidebar', title: 'Nav' })

  assert.equal(frames.openContent('nav', { place: 'left' }).ok, true)

  const nav = frames.project().docked.find((pane) => pane.content?.typeId === 'sidebar')
  const centre = frames.project().docked.find((pane) => pane.content?.typeId === 'conversation')
  assert.notEqual(nav, undefined)
  assert.ok((nav?.rect.x ?? 1) < (centre?.rect.x ?? 0))
})
