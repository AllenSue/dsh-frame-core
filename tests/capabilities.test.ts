import { test } from 'node:test'
import assert from 'node:assert/strict'

import { REACT_CAPABILITIES } from '../src/model/platform.ts'
import type { FloatPresentation, FrameCapabilities } from '../src/model/platform.ts'
import { createFrameState, withMeasurements, withPlatform } from '../src/model/state.ts'
import type { FrameState } from '../src/model/state.ts'
import type { FrameTypeDefinition } from '../src/model/types.ts'
import { floatFrame, splitFrame } from '../src/ops/intents.ts'
import { placedPanes } from '../src/geometry/rects.ts'
import { project } from '../src/project/project.ts'

const CONVERSATION: FrameTypeDefinition = { id: 'conversation', title: () => 'Conversation' }
const NOTES: FrameTypeDefinition = { id: 'notes', title: () => 'Notes' }

const PLATFORM = { id: 'react', capabilities: REACT_CAPABILITIES }
const VIEWPORT = { viewport: { width: 1000, height: 800 } }

/** Unwrap an accepted result, failing the test on a refusal. */
function accepted(result: { ok: boolean } & Record<string, any>): FrameState {
  assert.equal(result.ok, true, `expected acceptance, got ${JSON.stringify(result)}`)
  return result.value as FrameState
}

/**
 * Two docked panes and two floating frames.
 *
 * Built under a permissive target and then re-targeted, because the limits a
 * matrix cell declares are exactly the ones that would refuse to build the
 * fixture. What the matrix varies is what a target can *draw*, not what it can
 * be asked for.
 */
function furnished(): FrameState {
  let state = withMeasurements(
    createFrameState({ startup: CONVERSATION, platform: PLATFORM, types: [CONVERSATION, NOTES] }),
    VIEWPORT,
  )
  for (let index = 0; index < 3; index += 1) {
    const pane = placedPanes(state.layout)[0]?.id
    state = accepted(splitFrame(state, pane, 'notes'))
  }
  assert.equal(placedPanes(state.layout).length, 4)

  for (let index = 0; index < 2; index += 1) {
    const pane = placedPanes(state.layout)[index]?.id
    state = accepted(floatFrame(state, pane))
  }
  assert.equal(placedPanes(state.layout).length, 2, 'two stayed docked')
  assert.equal(state.layout.floats.length, 2, 'two came out')
  return state
}

/** The three ways a target can present a floating frame. */
const FLOAT_MODES: readonly FloatPresentation[] = ['window', 'overlay', 'none']

/** Every capability combination the matrix covers. */
const MATRIX: readonly (readonly [string, FrameCapabilities])[] = FLOAT_MODES.flatMap((floats) =>
  [true, false].flatMap((freeRect) =>
    [true, false].flatMap((drag) =>
      [1, 4].map((maxDockPanes): readonly [string, FrameCapabilities] => [
        `floats=${floats} freeRect=${String(freeRect)} drag=${String(drag)} panes=${String(maxDockPanes)}`,
        { floats, freeRect, drag, maxDockPanes, minPaneSize: 8, detachable: false },
      ]))))

const FIXTURE = furnished()

test('the matrix covers every combination of the four capabilities it varies', () => {
  // Written out rather than derived from the list, so adding a fourth float mode
  // or a third budget fails here instead of silently narrowing the coverage.
  assert.equal(MATRIX.length, 3 * 2 * 2 * 2)
  assert.equal(FLOAT_MODES.length, 3)
})

test('every combination projects to something a target could draw', () => {
  for (const [label, capabilities] of MATRIX) {
    const view = project(withPlatform(FIXTURE, { id: 'tui', capabilities }))

    assert.equal(view.platform, 'tui', label)
    assert.equal(view.revision, FIXTURE.revision + 1, label)
    assert.equal(view.viewport !== undefined, true, label)

    // A pane over the budget is not drawn, and is reported rather than lost.
    assert.ok(view.docked.length <= capabilities.maxDockPanes, label)
    const dropped = view.degradations.filter((entry) => entry.kind === 'pane-dropped')
    assert.equal(
      dropped.length,
      Math.max(0, placedPanes(FIXTURE.layout).length - capabilities.maxDockPanes),
      `${label}: every pane over budget is accounted for`,
    )

    for (const pane of view.docked) {
      assert.ok(pane.rect.width > 0 && pane.rect.height > 0, label)
      assert.ok(pane.rect.x >= 0 && pane.rect.x + pane.rect.width <= 1.0001, label)
      assert.ok(pane.rect.y >= 0 && pane.rect.y + pane.rect.height <= 1.0001, label)
    }
  }
})

test('a target that cannot float loses the floating frames, and says so', () => {
  const view = project(withPlatform(FIXTURE, {
    id: 'headless',
    capabilities: { ...TUI_SHAPED, floats: 'none' },
  }))

  assert.deepEqual(view.floats, [])
  assert.equal(view.degradations.filter((entry) => entry.kind === 'float-dropped').length, FIXTURE.layout.floats.length)
})

test('a target that can float gets them, presented the way it declared', () => {
  for (const floats of ['window', 'overlay'] as const) {
    const view = project(withPlatform(FIXTURE, {
      id: 'tui',
      capabilities: { ...TUI_SHAPED, floats },
    }))

    assert.equal(view.floats.length, FIXTURE.layout.floats.length, floats)
    for (const frame of view.floats) {
      assert.equal(frame.presentation, floats === 'overlay' ? 'overlay' : 'window', floats)
    }
  }
})

test('a target that cannot place a floating frame keeps the rectangle and reports it', () => {
  const withRects = project(withPlatform(FIXTURE, {
    id: 'free',
    capabilities: { ...TUI_SHAPED, floats: 'window', freeRect: true },
  }))
  const without = project(withPlatform(FIXTURE, {
    id: 'fixed',
    capabilities: { ...TUI_SHAPED, floats: 'window', freeRect: false },
  }))

  for (const frame of withRects.floats) assert.equal(frame.rectHonoured, true)
  assert.equal(withRects.degradations.some((entry) => entry.kind === 'rect-ignored'), false)

  for (const frame of without.floats) assert.equal(frame.rectHonoured, false)
  assert.equal(without.degradations.filter((entry) => entry.kind === 'rect-ignored').length, without.floats.length)

  // The rectangle itself is never dropped: it is the model's, and a target that
  // cannot use it must not be able to lose it.
  assert.deepEqual(without.floats.map((frame) => frame.rect), withRects.floats.map((frame) => frame.rect))
})

/**
 * Whether a target arranges frames with a pointer is not a drawing fact.
 *
 * `drag` tells the interaction layer what gestures exist; the projection is what
 * a target draws. So the honest assertion is that it changes nothing here — and
 * that is worth pinning, because a capability that quietly leaked into the
 * projection would make one saved preset look different on two targets that see
 * the same things.
 */
test('drag is not a drawing capability, so it never changes the projection', () => {
  for (const floats of FLOAT_MODES) {
    for (const freeRect of [true, false]) {
      for (const maxDockPanes of [1, 4]) {
        const shared = { floats, freeRect, maxDockPanes, minPaneSize: 8, detachable: false }
        const withDrag = project(withPlatform(FIXTURE, { id: 'a', capabilities: { ...shared, drag: true } }))
        const without = project(withPlatform(FIXTURE, { id: 'a', capabilities: { ...shared, drag: false } }))

        assert.deepEqual(withDrag, without, `drag changed the drawing at floats=${floats}`)
      }
    }
  }
})

test('a terminal target projects the same tree a browser does, minus what it cannot draw', () => {
  // The same model, two targets: one saved preset has to load on both.
  const browser = project(withPlatform(FIXTURE, { id: 'react', capabilities: REACT_CAPABILITIES }))
  const terminal = project(withPlatform(FIXTURE, { id: 'tui', capabilities: TUI_SHAPED }))

  assert.deepEqual(
    terminal.docked.map((pane) => pane.id),
    browser.docked.map((pane) => pane.id),
    'every pane the browser draws, the terminal draws too',
  )
  assert.deepEqual(
    terminal.docked.map((pane) => pane.rect),
    browser.docked.map((pane) => pane.rect),
    'and in the same place: the geometry is normalized, so it crosses targets',
  )
  // What it cannot draw: the floating frames keep their rectangles but lose the
  // right to place them.
  assert.equal(terminal.floats.length, browser.floats.length)
  assert.equal(terminal.floats.every((frame) => !frame.rectHonoured), true)
  assert.equal(browser.floats.every((frame) => frame.rectHonoured), true)
})

test('a tab keeps its identity across targets, so a view can be pointed at one again', () => {
  const browser = project(withPlatform(FIXTURE, { id: 'react', capabilities: REACT_CAPABILITIES }))
  const terminal = project(withPlatform(FIXTURE, { id: 'tui', capabilities: TUI_SHAPED }))

  const ids = (view: typeof browser): readonly string[] =>
    view.docked.flatMap((pane) => pane.tabs.map((tab) => `${tab.id}:${tab.typeId}`))

  assert.deepEqual(ids(terminal), ids(browser))
})

test('a target that reports no viewport is told nothing is split-capable', () => {
  const cold = project(FIXTURE)
  const detached = project(createFrameState({ startup: CONVERSATION, types: [CONVERSATION] }))

  assert.equal(detached.platform, 'unattached')
  assert.equal(detached.viewport, undefined)
  assert.equal(cold.viewport !== undefined, true, 'the fixture is measured')
  assert.equal(detached.docked.every((pane) => !pane.canSplit), true)
  assert.equal(detached.docked.every((pane) => pane.splitBlockedBy === 'narrow'), true)
})

/** The capability set a terminal declares, as the contract records it. */
const TUI_SHAPED: FrameCapabilities = {
  floats: 'overlay',
  freeRect: false,
  drag: false,
  maxDockPanes: 4,
  minPaneSize: 8,
  detachable: false,
}
