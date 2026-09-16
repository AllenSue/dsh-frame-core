import { test } from 'node:test'
import assert from 'node:assert/strict'

import { REACT_CAPABILITIES } from '../src/model/platform.ts'
import { createFrameState, withMeasurements } from '../src/model/state.ts'
import type { FrameState } from '../src/model/state.ts'
import type { FrameTypeDefinition } from '../src/model/types.ts'
import { contentList, getContent } from '../src/model/content.ts'
import type { PaneId, TabId } from '../src/vendor/ui-dockkit/contract/types.ts'
import {
  closeFrame, dockFrame, floatFrame, forgetFrame, openContent, registerFrame, splitFrame,
} from '../src/ops/intents.ts'
import type { FocusDirection } from '../src/ops/intents.ts'
import { placedPanes } from '../src/geometry/rects.ts'
import { createFramesService } from '../src/service/service.ts'
import { project } from '../src/project/project.ts'

const CONVERSATION: FrameTypeDefinition = { id: 'conversation', title: () => 'Conversation' }
const NOTES: FrameTypeDefinition = { id: 'notes', title: () => 'Notes' }

const PLATFORM = { id: 'react', capabilities: REACT_CAPABILITIES }
const VIEWPORT = { viewport: { width: 1000, height: 800 } }

/** A measured browser-target state with both types registered. */
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

/** Unwrap a refusal, failing the test on an acceptance. */
function refused(result: { ok: boolean } & Record<string, any>): string {
  assert.equal(result.ok, false, 'expected a refusal')
  return result.ok === false ? (result.code as string) : ''
}

/** A service with both types registered and a viewport reported. */
function service(): ReturnType<typeof createFramesService> {
  const built = createFramesService({ startup: CONVERSATION, platform: PLATFORM })
  built.registerType(NOTES)
  built.reportMeasurements(VIEWPORT)
  return built
}

/** Whether any live view shows `contentId`. */
function shown(state: FrameState, contentId: string): boolean {
  return Object.values(state.layout.tabs).some((tab) => tab.contentId === contentId)
}

// -------------------------------------------------- a content outlives a view

test('the startup frame seeds a content, not just a tab', () => {
  const state = ready()

  assert.deepEqual(contentList(state.contents).map((content) => content.id), ['conversation'])
  assert.deepEqual(getContent(state.contents, 'conversation'), {
    id: 'conversation',
    kind: 'conversation',
    title: 'Conversation',
  })
})

test('closing the last frame onto a content leaves the content alone', () => {
  const state = ready()
  const closed = accepted(closeFrame(state))

  assert.deepEqual(project(closed).docked[0]?.tabs, [], 'the view is gone')
  assert.equal(getContent(closed.contents, 'conversation') !== undefined, true, 'the content is not')
  assert.equal(shown(closed, 'conversation'), false)
})

test('a content lives through float, dock and close of every view of it', () => {
  const floated = accepted(floatFrame(ready()))
  assert.equal(floated.layout.floats.length, 1)
  const dockedBack = accepted(dockFrame(floated))
  const closed = accepted(closeFrame(dockedBack))

  assert.deepEqual(contentList(closed.contents).map((content) => content.id), ['conversation'])
})

test('two views can show one content, and closing one leaves the other', () => {
  const split = accepted(splitFrame(ready(), undefined, 'notes'))
  const panes = [...placedPanes(split.layout)]
  const left = panes[0]?.id as PaneId
  const right = panes[1]?.id as PaneId

  // A second view of the conversation, seated beside the first. Nothing in the
  // core mints one — duplicating a view is a deliberate request — so the fixture
  // builds it the way the engine's own `planDuplicateTab` would.
  const original = Object.values(split.layout.tabs).find((tab) => tab.contentId === 'conversation')
  assert.notEqual(original, undefined)
  const twin = { ...original!, id: `${original!.id}-twin` as TabId }
  const rightNode = split.layout.nodes[right]
  assert.equal(rightNode?.kind, 'pane')
  const twoViews: FrameState = {
    ...split,
    layout: {
      ...split.layout,
      tabs: { ...split.layout.tabs, [twin.id]: twin },
      nodes: { ...split.layout.nodes, [right]: { ...rightNode as object, tabs: [twin.id], activeTabId: twin.id } },
    },
  }

  const conversationViews = (state: FrameState): number =>
    Object.values(state.layout.tabs).filter((tab) => tab.contentId === 'conversation').length
  assert.equal(conversationViews(twoViews), 2)

  // Closing one view closes exactly one: the content and the other view remain.
  const closedOne = accepted(closeFrame(twoViews, right))
  assert.equal(conversationViews(closedOne), 1)
  assert.equal(getContent(closedOne.contents, 'conversation') !== undefined, true)
  assert.equal(placedPanes(closedOne.layout).length, 1, 'the emptied pane merged away')

  // And the surviving view is still the one a second open would focus.
  const focused = accepted(openContent(closedOne, 'conversation'))
  assert.equal(focused.layout.activePaneId, left)
})

// ------------------------------------------------------------ open by content

test('opening a content nothing shows makes a view that names the content', () => {
  const state = ready()
  const closed = accepted(closeFrame(state))
  const reopened = accepted(openContent(closed, 'conversation'))

  const pane = project(reopened).docked.find((candidate) => candidate.tabs.length > 0)
  assert.notEqual(pane, undefined)
  assert.deepEqual(pane?.tabs.map((tab) => tab.typeId), ['conversation'])
  // The view names the content, not merely a type that happens to match it.
  const tab = Object.values(reopened.layout.tabs)[0]
  assert.equal(tab?.contentId, 'conversation')
})

test('opening a content a frame already shows focuses that frame instead of adding one', () => {
  const split = accepted(splitFrame(ready(), undefined, 'notes'))
  const before = placedPanes(split.layout).length
  const left = placedPanes(split.layout)[0]?.id as PaneId

  // Focus is on the pane the split created; opening the conversation must move
  // focus back rather than split again.
  const reopened = accepted(openContent(split, 'conversation'))

  assert.equal(placedPanes(reopened.layout).length, before, 'no new pane')
  assert.equal(reopened.layout.activePaneId, left, 'focus moved to the frame already showing it')
})

test('a content the owner named itself is opened under that name', () => {
  const state = ready()
  const registered = accepted(registerFrame(state, { id: 'notes-7', kind: 'notes', title: 'Notes 7' }))
  assert.deepEqual(contentList(registered.contents).map((content) => content.id), ['conversation', 'notes-7'])

  const opened = accepted(openContent(registered, 'notes-7'))
  const tab = Object.values(opened.layout.tabs).find((candidate) => candidate.contentId === 'notes-7')

  assert.notEqual(tab, undefined)
  assert.equal(tab?.kind, 'notes', 'the kind is how to draw it')
  assert.equal(tab?.title, 'Notes 7', 'the title is the content own')
})

test('opening a content nobody registered is refused, not invented', () => {
  const state = ready()

  assert.equal(refused(openContent(state, 'never-registered')), 'frames/unknown-content')
  assert.equal(state.history.past.length, 0)
})

test('a content with no view is still listed', () => {
  const state = ready()
  const registered = accepted(registerFrame(state, { id: 'background', kind: 'notes', title: 'Background' }))

  assert.equal(shown(registered, 'background'), false)
  assert.deepEqual(contentList(registered.contents).map((content) => content.id), ['background', 'conversation'])
})

test('registering the same content twice is not an error and keeps the first', () => {
  const state = ready()
  const once = accepted(registerFrame(state, { id: 'notes-1', kind: 'notes', title: 'First' }))
  const twice = accepted(registerFrame(once, { id: 'notes-1', kind: 'notes', title: 'Second' }))

  assert.equal(twice, once, 'nothing changed, so nothing is published')
  assert.equal(getContent(twice.contents, 'notes-1')?.title, 'First')
})

test('a content needs an id and a kind', () => {
  const state = ready()

  assert.equal(refused(registerFrame(state, { id: '', kind: 'notes', title: 'x' })), 'frames/unknown-content')
  assert.equal(refused(registerFrame(state, { id: 'x', kind: '', title: 'x' })), 'frames/unknown-content')
})

// ------------------------------------------------------------ forgetting

test('forgetting is the only thing that ends a content', () => {
  const state = ready()
  const split = accepted(splitFrame(state, undefined, 'notes'))
  const forgotten = accepted(forgetFrame(split, 'conversation'))

  assert.equal(getContent(forgotten.contents, 'conversation'), undefined)
  // The view is untouched: the frame is still there, with nothing behind it.
  assert.equal(shown(forgotten, 'conversation'), true)
})

test('forgetting records no history, because it is not a layout change', () => {
  const state = ready()

  const forgotten = accepted(forgetFrame(state, 'conversation'))

  assert.deepEqual(project(forgotten).docked, project(state).docked)
  assert.equal(forgotten.history.past.length, 0)
})

test('forgetting a content the shell does not hold changes nothing', () => {
  const state = ready()

  assert.equal(accepted(forgetFrame(state, 'never-registered')), state)
})

test('a forgotten content can be registered again', () => {
  const state = ready()
  const forgotten = accepted(forgetFrame(state, 'conversation'))
  const again = accepted(registerFrame(forgotten, { id: 'conversation', kind: 'conversation', title: 'Back' }))

  assert.equal(getContent(again.contents, 'conversation')?.title, 'Back')
  // The frame that was left showing it can be pointed at it again by opening it.
  assert.equal(openContent(again, 'conversation').ok, true)
})

// --------------------------------------------------------------- the service

test('the service reports contents and drives them', () => {
  const frames = service()
  frames.split(undefined, 'notes')

  assert.deepEqual(frames.contents().map((content) => content.id).sort(), ['conversation', 'notes'])
  assert.equal(frames.content('notes')?.title, 'Notes')

  const pane = frames.project().docked[0]?.id as PaneId
  frames.close(pane)
  assert.equal(frames.content('conversation') !== undefined, true, 'closing a frame does not close its content')

  assert.equal(frames.openContent('conversation').ok, true)
  assert.equal(frames.content('never')?.id, undefined)
})

test('a content the service never saw cannot be opened', () => {
  const frames = service()
  const before = frames.project()

  assert.equal(frames.openContent('ghost').ok, false)
  assert.equal(frames.project(), before)
})

test('a drop that seats a view also takes up its content', () => {
  const frames = service()
  frames.split(undefined, 'notes')
  const panes = frames.project().docked
  const left = panes[0]?.id as PaneId
  const right = panes[1]?.id as PaneId
  const dragged = frames.project().docked.find((pane) => pane.id === right)?.tabs[0]?.id as TabId

  frames.drop(dragged, { kind: 'dock', paneId: left, zone: 'center' })

  assert.deepEqual(frames.contents().map((content) => content.id).sort(), ['conversation', 'notes'])
})

// ------------------------------------------------------------------ far edge

test('a content survives a whole arrangement of moves', () => {
  const frames = service()
  frames.split(undefined, 'notes')
  frames.float()
  frames.moveFocus('left' as FocusDirection)
  frames.split(undefined, 'notes')
  frames.close()

  assert.deepEqual(frames.contents().map((content) => content.id).sort(), ['conversation', 'notes'])
})
