import { test } from 'node:test'
import assert from 'node:assert/strict'

import { REACT_CAPABILITIES } from '../src/model/platform.ts'
import { createFrameState, withMeasurements } from '../src/model/state.ts'
import type { FrameState } from '../src/model/state.ts'
import type { FrameTypeDefinition } from '../src/model/types.ts'
import { contentList, getContent } from '../src/model/content.ts'
import type { PaneId } from '../src/vendor/ui-dockkit/contract/types.ts'
import {
  closeFrame, createContent, kindOfPane, registerFrame, showContent, splitFrame,
} from '../src/ops/intents.ts'
import { placedPanes } from '../src/geometry/rects.ts'
import { project } from '../src/project/project.ts'
import { createFramesService } from '../src/service/service.ts'

/** A type whose instances are files, the way an editor plugin would declare one. */
function editorType(): { definition: FrameTypeDefinition; made: string[] } {
  const made: string[] = []
  return {
    made,
    definition: {
      id: 'editor',
      title: () => 'Editor',
      create: () => {
        const file = `/tmp/file-${String(made.length + 1)}.ts`
        made.push(file)
        return { id: file, kind: 'editor', title: file }
      },
    },
  }
}

/** A type that cannot be instantiated: displayable, but never brought into being. */
const CONSOLE_TYPE: FrameTypeDefinition = { id: 'console', title: () => 'Console' }

const CONVERSATION: FrameTypeDefinition = { id: 'conversation', title: () => 'Conversation' }

const PLATFORM = { id: 'react', capabilities: REACT_CAPABILITIES }
const VIEWPORT = { viewport: { width: 1000, height: 800 } }

/** A measured frame holding one empty pane, with the given types registered. */
function emptyPane(types: readonly FrameTypeDefinition[]): FrameState {
  const state = withMeasurements(
    createFrameState({ startup: CONVERSATION, platform: PLATFORM, types }),
    VIEWPORT,
  )
  // An empty pane is what a freshly split frame is: the picker's home.
  const split = splitFrame(state, undefined, undefined)
  assert.equal(split.ok, true)
  return (split as { ok: true; value: FrameState }).value
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

/** What a pane displays, as a list so a test can say "exactly one of these". */
function kindsOf(state: FrameState, paneId: PaneId): readonly string[] {
  const node = state.layout.nodes[paneId]
  if (node === undefined || node.kind !== 'pane') return []
  return node.tabs.map((tabId) => state.layout.tabs[tabId]?.kind ?? '?')
}

/** The content a pane displays, by id. */
function shownContent(state: FrameState, paneId: PaneId): string | undefined {
  const node = state.layout.nodes[paneId]
  if (node === undefined || node.kind !== 'pane') return undefined
  const tabId = node.tabs[0]
  return tabId === undefined ? undefined : state.layout.tabs[tabId]?.contentId
}

// ------------------------------------------------------------ instantiation

test('an empty pane has no kind, and takes the kind of what is seated in it', () => {
  const editor = editorType()
  const state = emptyPane([CONVERSATION, editor.definition])
  const pane = placedPanes(state.layout).find((candidate) => {
    const node = state.layout.nodes[candidate.id]
    return node?.kind === 'pane' && node.tabs.length === 0
  })?.id as PaneId

  assert.equal(kindOfPane(state, pane), undefined)

  const made = accepted(createContent(state, 'editor', pane))

  assert.equal(kindOfPane(made, pane), 'editor')
  assert.deepEqual(kindsOf(made, pane), ['editor'])
  assert.deepEqual(editor.made, ['/tmp/file-1.ts'])
})

test('the type says what a new instance is, and the core registers exactly that', () => {
  const editor = editorType()
  const state = emptyPane([CONVERSATION, editor.definition])
  const pane = placedPanes(state.layout)[1]?.id as PaneId

  const made = accepted(createContent(state, 'editor', pane))

  // The plugin named it; the core did not invent a `content7`.
  assert.deepEqual(contentList(made.contents).map((content) => content.id).sort(), ['/tmp/file-1.ts', 'conversation'])
  assert.equal(getContent(made.contents, '/tmp/file-1.ts')?.title, '/tmp/file-1.ts')
})

test('a second instance of the same type replaces the first in that pane', () => {
  const editor = editorType()
  const state = emptyPane([CONVERSATION, editor.definition])
  const pane = placedPanes(state.layout)[1]?.id as PaneId

  const one = accepted(createContent(state, 'editor', pane))
  const two = accepted(createContent(one, 'editor', pane))

  assert.deepEqual(kindsOf(two, pane), ['editor'])
  assert.deepEqual(editor.made, ['/tmp/file-1.ts', '/tmp/file-2.ts'])
  // The one that was put down is not destroyed: the shell still holds both files,
  // and only one frame is showing one of them.
  assert.deepEqual(
    contentList(two.contents).map((content) => content.id).sort(),
    ['/tmp/file-1.ts', '/tmp/file-2.ts', 'conversation'],
  )
  assert.equal(shownContent(two, pane), '/tmp/file-2.ts')
})

test('a type that declares no factory cannot be instantiated', () => {
  const state = emptyPane([CONVERSATION, CONSOLE_TYPE])
  const pane = placedPanes(state.layout)[1]?.id as PaneId

  assert.equal(refused(createContent(state, 'console', pane)), 'frames/unknown-type')
  assert.equal(refused(createContent(state, 'never-registered', pane)), 'frames/unknown-type')
})

test("a type's own instance limit is what refuses the next one", () => {
  const editor = editorType()
  const limited: FrameTypeDefinition = {
    ...editor.definition,
    id: 'once',
    policy: { maxInstances: 1 },
    create: () => ({ id: 'once-one', kind: 'once', title: 'One' }),
  }
  const state = emptyPane([CONVERSATION, limited])
  const pane = placedPanes(state.layout)[1]?.id as PaneId

  const made = accepted(createContent(state, 'once', pane))

  assert.equal(refused(createContent(made, 'once', pane)), 'frames/instance-limit')
})

test('a singleton type refuses a second instance, by its own declaration', () => {
  const single: FrameTypeDefinition = {
    id: 'the-one',
    title: () => 'The one',
    singleton: true,
    create: () => ({ id: 'the-one-a', kind: 'the-one', title: 'A' }),
  }
  const state = emptyPane([CONVERSATION, single])
  const pane = placedPanes(state.layout)[1]?.id as PaneId

  const made = accepted(createContent(state, 'the-one', pane))

  assert.equal(refused(createContent(made, 'the-one', pane)), 'frames/instance-limit')
})

// ---------------------------------------------------------------- switching

test('switching shows another content in the same pane and keeps the old one', () => {
  const editor = editorType()
  const state = emptyPane([CONVERSATION, editor.definition])
  const pane = placedPanes(state.layout)[1]?.id as PaneId
  const one = accepted(createContent(state, 'editor', pane))
  const two = accepted(createContent(one, 'editor', pane))

  // The second file is showing; switch back to the first.
  assert.equal(shownContent(two, pane), '/tmp/file-2.ts')
  const back = accepted(showContent(two, pane, '/tmp/file-1.ts'))

  assert.equal(shownContent(back, pane), '/tmp/file-1.ts')
  assert.equal(getContent(back.contents, '/tmp/file-2.ts') !== undefined, true, 'the other is still held')
})

test('switching to a content the shell holds but no frame shows replaces what that frame was showing', () => {
  const editor = editorType()
  const state = emptyPane([CONVERSATION, editor.definition])
  const pane = placedPanes(state.layout)[1]?.id as PaneId
  const made = accepted(createContent(state, 'editor', pane))
  // A content held by the shell but shown nowhere.
  const parked = accepted(registerFrame(made, { id: '/tmp/parked.ts', kind: 'editor', title: '/tmp/parked.ts' }))

  const shown = accepted(showContent(parked, pane, '/tmp/parked.ts'))

  assert.equal(shownContent(shown, pane), '/tmp/parked.ts')
  assert.equal(getContent(shown.contents, '/tmp/file-1.ts') !== undefined, true, 'what it replaced is put down, not destroyed')
})

test('switching to a content of another kind is not a conflict any more', () => {
  // A pane holds one content, so there is nothing for a second kind to clash
  // with: the frame simply stops displaying one thing and displays another.
  const state = emptyPane([CONVERSATION])
  const pane = placedPanes(state.layout)[1]?.id as PaneId
  const seated = accepted(showContent(state, pane, 'conversation'))
  const withConsole = accepted(registerFrame(seated, { id: 'console-1', kind: 'console', title: 'Console' }))

  const swapped = accepted(showContent(withConsole, pane, 'console-1'))

  assert.equal(shownContent(swapped, pane), 'console-1')
  assert.equal(getContent(swapped.contents, 'conversation') !== undefined, true)
})

test('switching to a content the shell does not hold is refused', () => {
  const state = emptyPane([CONVERSATION])
  const pane = placedPanes(state.layout)[1]?.id as PaneId

  assert.equal(refused(showContent(state, pane, 'nobody-has-this')), 'frames/unknown-content')
})

// ------------------------------------------------------------- the picker

test('the projection lists every type and says which can be instantiated', () => {
  const editor = editorType()
  const state = withMeasurements(
    createFrameState({ startup: CONVERSATION, platform: PLATFORM, types: [CONVERSATION, editor.definition, CONSOLE_TYPE] }),
    VIEWPORT,
  )

  assert.deepEqual(project(state).types, [
    { id: 'conversation', title: 'Conversation', instantiable: false },
    { id: 'editor', title: 'Editor', instantiable: true },
    { id: 'console', title: 'Console', instantiable: false },
  ])
})

test('the projection lists every content the shell holds', () => {
  const editor = editorType()
  const state = emptyPane([CONVERSATION, editor.definition])
  const pane = placedPanes(state.layout)[1]?.id as PaneId

  // A fresh shell holds the content its first frame was seeded with, even though
  // the pane doing the asking is a different one.
  assert.deepEqual(project(state).contents, [
    { id: 'conversation', kind: 'conversation', title: 'Conversation' },
  ])

  const made = accepted(createContent(state, 'editor', pane))
  assert.deepEqual(project(made).contents.map((content) => content.id), ['/tmp/file-1.ts', 'conversation'])

  // And one closed away is still listed: that is where it comes back from.
  const closed = accepted(closeFrame(made, pane))
  assert.equal(project(closed).contents.length, 2)
})

test('a type registered after mounting shows up in the list without anything being told', () => {
  const service = createFramesService({ startup: CONVERSATION, platform: PLATFORM })
  service.reportMeasurements(VIEWPORT)
  // The startup type seeds the first frame but is not registered on its behalf,
  // so the list starts empty and is filled entirely by registrations.
  assert.deepEqual(service.project().types, [])

  service.registerType(CONVERSATION)
  assert.deepEqual(service.project().types.map((type) => type.id), ['conversation'])

  const editor = editorType()
  service.registerType(editor.definition)

  assert.deepEqual(service.project().types.map((type) => type.id), ['conversation', 'editor'])
})

test('a pane holding one kind keeps it through a split and a close', () => {
  const editor = editorType()
  const state = emptyPane([CONVERSATION, editor.definition])
  const pane = placedPanes(state.layout)[1]?.id as PaneId
  const one = accepted(createContent(state, 'editor', pane))

  const closed = accepted(closeFrame(one, pane))

  assert.equal(kindOfPane(closed, pane), undefined, 'the pane is empty again, so it has no kind')
  assert.equal(getContent(closed.contents, '/tmp/file-1.ts') !== undefined, true, 'the content outlives it')
})

// ------------------------------------------------------------- the service

test('the service carries instantiation, switching and the kind query through', () => {
  const editor = editorType()
  const service = createFramesService({ startup: CONVERSATION, platform: PLATFORM })
  service.registerType(editor.definition)
  service.reportMeasurements(VIEWPORT)
  service.split(undefined, undefined)
  const pane = service.project().docked.find((candidate) => candidate.content === undefined)?.id as PaneId

  assert.equal(service.paneKind(pane), undefined)
  assert.equal(service.createContent('editor', pane).ok, true)
  assert.equal(service.paneKind(pane), 'editor')

  const first = '/tmp/file-1.ts'
  assert.equal(service.createContent('editor', pane).ok, true)
  assert.equal(service.showContent(pane, first).ok, true)
  assert.equal(service.paneKind(pane), 'editor')
})
