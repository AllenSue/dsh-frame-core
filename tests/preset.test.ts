import { test } from 'node:test'
import assert from 'node:assert/strict'

import { REACT_CAPABILITIES } from '../src/model/platform.ts'
import { createFrameState, withMeasurements } from '../src/model/state.ts'
import type { FrameState } from '../src/model/state.ts'
import type { FrameTypeDefinition } from '../src/model/types.ts'
import type { PaneId, TabId } from '../src/vendor/ui-dockkit/contract/types.ts'
import { floatFrame, placeFloat, splitFrame } from '../src/ops/intents.ts'
import { placedPanes } from '../src/geometry/rects.ts'
import {
  canonicalLayout, mintedThrough, parsePreset, PRESET_FORMAT_VERSION, toPreset, withPreset,
} from '../src/preset/preset.ts'
import type { Preset, PresetPort } from '../src/preset/preset.ts'
import { createFramesService } from '../src/service/service.ts'
import type { FramesService, FramesServiceOptions } from '../src/service/service.ts'
import { project } from '../src/project/project.ts'

const CONVERSATION: FrameTypeDefinition = { id: 'conversation', title: () => 'Conversation' }
const NOTES: FrameTypeDefinition = { id: 'notes', title: () => 'Notes' }

/** The browser declaration the fixtures measure against. */
const PLATFORM = { id: 'react', capabilities: REACT_CAPABILITIES }

/** The viewport the fixtures report. */
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

/** A state with structure in it: a split and a window somewhere else. */
function furnished(): FrameState {
  const split = accepted(splitFrame(ready(), undefined, 'notes'))
  const floated = accepted(floatFrame(split))
  const paneId = floated.layout.floats[0] as PaneId
  return accepted(placeFloat(floated, paneId, { x: 0.1, y: 0.1, width: 0.3, height: 0.3 }))
}

/** A service over the same options, with both types registered and measured. */
function service(extra: Partial<FramesServiceOptions> = {}): FramesService {
  const built = createFramesService({ startup: CONVERSATION, platform: PLATFORM, ...extra })
  built.registerType(NOTES)
  built.reportMeasurements(VIEWPORT)
  return built
}

/** A medium held in memory, recording every write it is asked to make. */
function medium(): { port: PresetPort; written: string[]; records: Map<string, unknown> } {
  const records = new Map<string, unknown>()
  const written: string[] = []
  return {
    records,
    written,
    port: {
      list: async () => [...records.keys()],
      read: async (name) => records.get(name),
      write: async (name, preset) => {
        written.push(name)
        // Through JSON, as a real medium would: the round trip is the point.
        records.set(name, JSON.parse(JSON.stringify(preset)) as unknown)
      },
      remove: async (name) => { records.delete(name) },
    },
  }
}

// ---------------------------------------------------------------- round trip

test('a preset survives a JSON round trip field for field', () => {
  const preset = toPreset(furnished(), 'work')
  const parsed = parsePreset(JSON.parse(JSON.stringify(preset)) as unknown)

  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.ok && parsed.value, preset)
  // Writing it out again produces the same bytes, which is what makes a preset
  // safe to hand between targets.
  assert.equal(JSON.stringify(parsed.ok && parsed.value), JSON.stringify(preset))
})

test('adopting a preset reproduces the layout exactly, with nothing left to undo', () => {
  const state = furnished()
  const adopted = withPreset(ready(), toPreset(state, 'work'))

  // Field for field, in the shape a medium stores: the model writes absent
  // optionals as `undefined`, and a medium drops them, so the comparison is
  // made in the canonical form both sides agree on.
  assert.deepEqual(canonicalLayout(adopted.layout), canonicalLayout(state.layout))
  assert.deepEqual(project(adopted).docked, project(state).docked)
  assert.deepEqual(project(adopted).floats, project(state).floats)
  assert.deepEqual(project(adopted).dividers, project(state).dividers)
  assert.equal(adopted.activePresetId, 'work')
  assert.equal(adopted.history.past.length, 0, 'the preset is a baseline, not a step')
  assert.equal(adopted.history.future.length, 0)
})

test('a restored tree goes on minting without reusing an id it already holds', () => {
  const state = furnished()
  const adopted = withPreset(ready(), toPreset(state, 'work'))
  const before = new Set([
    ...Object.keys(adopted.layout.nodes),
    ...Object.keys(adopted.layout.tabs),
  ])
  // A float holds the focus after being raised, so the split names a docked pane.
  const docked = placedPanes(adopted.layout)[0]?.id
  assert.notEqual(docked, undefined)

  const after = accepted(splitFrame(adopted, docked, 'notes'))
  const added = [...Object.keys(after.layout.nodes), ...Object.keys(after.layout.tabs)]
    .filter((id) => !before.has(id))

  assert.ok(added.length > 0, 'the split minted something')
  assert.equal(added.some((id) => before.has(id)), false, 'nothing was reused')
  // And the ids really do continue past the stored counter rather than restart.
  for (const id of added) {
    const digits = /(\d+)$/.exec(id)
    assert.ok(digits !== null && Number(digits[1]) > mintedThrough(state.layout), id)
  }
})

// ------------------------------------------------------------------ counter

test('the counter is the largest id in the tree, not the number of ids', () => {
  // The startup pane is `pane1` and its tab is `tab2`: one counter, two kinds.
  assert.equal(mintedThrough(ready().layout), 2)
  assert.ok(mintedThrough(furnished().layout) > mintedThrough(ready().layout))
})

test('a counter below what the tree is already using is raised, never trusted', () => {
  const good = toPreset(furnished(), 'work')
  const understated = parsePreset({ ...good, mint: 0 })

  assert.equal(understated.ok, true)
  assert.equal(understated.ok && understated.value.mint, mintedThrough(good.layout))
})

test('a counter above what the tree is using is kept, so retired ids stay retired', () => {
  const good = toPreset(ready(), 'work')
  const generous = parsePreset({ ...good, mint: 99 })

  assert.equal(generous.ok && generous.value.mint, 99)
})

// ----------------------------------------------------------------- refusals

test('a stored record that is not a preset is refused with a reason each time', () => {
  const good = toPreset(ready(), 'work') as unknown as Record<string, unknown>

  assert.equal(refused(parsePreset('not a preset')), 'frames/unknown-preset')
  assert.equal(refused(parsePreset(null)), 'frames/unknown-preset')
  assert.equal(refused(parsePreset([good])), 'frames/unknown-preset')
  assert.equal(refused(parsePreset({ ...good, name: '' })), 'frames/unknown-preset')
  assert.equal(refused(parsePreset({ ...good, version: 'one' })), 'frames/unknown-preset')
  assert.equal(refused(parsePreset({ ...good, layout: undefined })), 'frames/unknown-preset')
})

test('a preset from a newer format is refused rather than half-read', () => {
  const future = { ...toPreset(ready(), 'work'), version: PRESET_FORMAT_VERSION + 1 }

  assert.equal(refused(parsePreset(future)), 'frames/unknown-preset')
})

test('a preset from an older format is refused, because no migration is registered', () => {
  // The migration chain is empty while v1 is the only format. The test records
  // that the answer is a refusal rather than a guess; a v2 format replaces this
  // expectation with the first real migration.
  const older = { ...toPreset(ready(), 'work'), version: PRESET_FORMAT_VERSION - 1 }

  assert.equal(refused(parsePreset(older)), 'frames/unknown-preset')
})

test('a layout whose references do not resolve is refused before it reaches the engine', () => {
  const good = toPreset(furnished(), 'work')
  const layout = good.layout as unknown as {
    nodes: Record<string, Record<string, unknown>>
    mode: string
    rootId: string
  }
  const paneId = Object.values(layout.nodes).find((node) => node.kind === 'pane')?.id as string
  assert.notEqual(paneId, undefined)

  const cases: readonly (readonly [string, unknown])[] = [
    ['a child that is not in nodes', {
      ...good,
      layout: {
        ...layout,
        nodes: {
          ...layout.nodes,
          split99: { kind: 'split', id: 'split99', axis: 'row', children: ['pane-gone'], sizes: [1] },
        },
      },
    }],
    ['a node filed under a key that is not its id', {
      ...good,
      layout: { ...layout, nodes: { ...layout.nodes, 'pane-renamed': { ...layout.nodes[paneId], id: 'pane1' } } },
    }],
    ['a root that is not there', { ...good, layout: { ...layout, rootId: 'nope' } }],
    ['a pane holding a tab no record exists for', {
      ...good,
      layout: { ...layout, nodes: { ...layout.nodes, [paneId]: { ...layout.nodes[paneId], tabs: ['tab-gone'] } } },
    }],
    ['a mode the renderer does not have', { ...good, layout: { ...layout, mode: 'floating' } }],
    ['a split whose children and sizes disagree', {
      ...good,
      layout: {
        ...layout,
        nodes: {
          ...layout.nodes,
          split98: { kind: 'split', id: 'split98', axis: 'row', children: [paneId], sizes: [0.5, 0.5] },
        },
      },
    }],
  ]

  for (const [label, value] of cases) {
    assert.equal(refused(parsePreset(value)), 'frames/unknown-preset', label)
  }
})

// ------------------------------------------------------------------ service

test('saving snapshots the tree and settles which preset the shell is on', async () => {
  const { port, written } = medium()
  const frames = service({ presets: port })
  frames.split(undefined, 'notes')
  const before = frames.project()

  const saved = await frames.savePreset('work')

  assert.equal(saved.ok, true)
  assert.deepEqual(written, ['work'])
  assert.equal(frames.activePresetId(), 'work')
  assert.equal(frames.project().docked.length, before.docked.length, 'saving copies, it does not move')
  await frames.refreshPresets()
  assert.deepEqual(frames.presetNames(), ['work'])
})

test('a refusal to save leaves the tree and the medium alone', async () => {
  const { port, written } = medium()
  const frames = createFramesService({ startup: CONVERSATION, presets: port })
  const before = frames.project()

  const nameless = await frames.savePreset('')

  assert.equal(nameless.ok, false)
  assert.deepEqual(written, [])
  assert.equal(frames.project(), before, 'the projection did not move')
  assert.equal(frames.activePresetId(), undefined)
})

test('applying a preset restores it exactly; a bad one changes nothing', async () => {
  const { port, records } = medium()
  const frames = service({ presets: port })
  frames.split(undefined, 'notes')
  const docked = frames.project().docked[0]?.id as PaneId
  frames.float(docked)
  await frames.savePreset('work')
  const saved = frames.project()

  // Wander off the saved layout by splitting a *docked* pane: after floating,
  // the focus is on the window and a split there is refused.
  frames.split(frames.project().docked[0]?.id, 'notes')
  assert.notEqual(frames.project().docked.length, saved.docked.length)

  const applied = await frames.applyPreset('work')
  assert.equal(applied.ok, true)
  assert.deepEqual(frames.project().docked, saved.docked)
  assert.deepEqual(frames.project().floats, saved.floats)
  assert.deepEqual(frames.project().dividers, saved.dividers)
  assert.equal(frames.activePresetId(), 'work')

  // A record that does not hold together refuses and leaves the tree where it is.
  records.set('broken', { version: PRESET_FORMAT_VERSION, name: 'broken', layout: { nope: true } })
  const before = frames.project()
  assert.equal((await frames.applyPreset('broken')).ok, false)
  assert.equal(frames.project(), before)

  assert.equal((await frames.applyPreset('never-written')).ok, false)
  assert.equal(frames.project(), before)
})

test('only saving writes; moving frames around does not touch the medium', async () => {
  const { port, written } = medium()
  const frames = service({ presets: port })
  await frames.refreshPresets()
  const afterMount = written.length

  frames.split(undefined, 'notes')
  frames.moveFocus('left')
  frames.close()
  const pane = frames.project().docked[0]?.id
  if (pane !== undefined) frames.split(pane, 'notes')

  assert.equal(written.length, afterMount, 'a runtime adjustment is never persisted')
})

test('a shell with no medium refuses the preset calls instead of throwing', async () => {
  const frames = createFramesService({ startup: CONVERSATION })
  const before = frames.project()

  assert.equal((await frames.savePreset('work')).ok, false)
  assert.equal((await frames.applyPreset('work')).ok, false)
  await frames.refreshPresets()
  assert.deepEqual(frames.presetNames(), [])
  assert.equal(frames.project(), before)
})

test('the medium hands the core raw records and the core decides', async () => {
  const { port, records } = medium()
  records.set('foreign', { something: 'else' })
  const frames = createFramesService({ startup: CONVERSATION, presets: port })

  await frames.refreshPresets()

  // A record the core cannot read is still listed: the medium's index is the
  // medium's business, and only applying it asks whether it is a preset.
  assert.deepEqual(frames.presetNames(), ['foreign'])
  const outcome = await frames.applyPreset('foreign')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false ? outcome.code : '', 'frames/unknown-preset')
})

test('a preset saved from one shell loads into another with the same tree', async () => {
  const { port } = medium()
  const options: FramesServiceOptions = { startup: CONVERSATION, platform: PLATFORM, presets: port }

  const author = service({ presets: port })
  author.split(undefined, 'notes')
  await author.savePreset('shared')
  const saved = author.project()

  // A second shell, as a page reload would build it.
  const reader = createFramesService(options)
  reader.registerType(NOTES)
  reader.reportMeasurements(VIEWPORT)
  await reader.refreshPresets()
  assert.deepEqual(reader.presetNames(), ['shared'])
  assert.equal((await reader.applyPreset('shared')).ok, true)

  assert.deepEqual(reader.project().docked, saved.docked)
  assert.equal(reader.project().docked.length, 2)
})

test('a preset is data, so a later state change cannot rewrite one already saved', async () => {
  const { port, records } = medium()
  const frames = service({ presets: port })
  frames.split(undefined, 'notes')
  await frames.savePreset('work')
  const asStored = JSON.stringify(records.get('work'))

  frames.split(undefined, 'notes')
  frames.moveFocus('left')

  assert.equal(JSON.stringify(records.get('work')), asStored)
})

test('a float keeps its rectangle across a save and load', async () => {
  const frames = service({ presets: medium().port })
  frames.float()
  const pane = frames.project().floats[0]?.id as PaneId
  frames.placeFloat(pane, { x: 0.2, y: 0.3, width: 0.25, height: 0.35 })
  await frames.savePreset('windowed')

  frames.placeFloat(pane, { x: 0.6, y: 0.6, width: 0.25, height: 0.35 })
  await frames.applyPreset('windowed')

  assert.deepEqual(frames.project().floats[0]?.rect, { x: 0.2, y: 0.3, width: 0.25, height: 0.35 })
})

test('two chips stacked in one pane survive a round trip', async () => {
  const frames = service({ presets: medium().port })
  frames.split(undefined, 'notes')
  const panes = frames.project().docked
  const left = panes[0]?.id as PaneId
  const right = panes[1]?.id as PaneId
  const dragged = frames.project().docked.find((pane) => pane.id === right)?.tabs[0]?.id as TabId
  frames.drop(dragged, { kind: 'dock', paneId: left, zone: 'center' })
  const stacked = frames.project()
  assert.equal(stacked.docked[0]?.tabs.length, 2, 'the fixture actually stacked two chips')
  await frames.savePreset('stacked')

  frames.split(undefined, 'notes')
  await frames.applyPreset('stacked')

  assert.deepEqual(frames.project().docked, stacked.docked)
})

test('a preset holding an empty pane is still a layout the shell can drive', async () => {
  const { port, records } = medium()
  const empty: Preset = {
    version: PRESET_FORMAT_VERSION,
    name: 'empty',
    mint: 0,
    layout: {
      nodes: {
        pane1: {
          kind: 'pane', id: 'pane1' as PaneId, host: 'dock',
          tabs: [], activeTabId: undefined, rect: undefined,
        },
      } as unknown as Preset['layout']['nodes'],
      tabs: {},
      rootId: 'pane1' as PaneId,
      floats: [],
      activePaneId: 'pane1' as PaneId,
      expanded: true,
      mode: 'push',
    },
  }
  records.set('empty', JSON.parse(JSON.stringify(empty)) as unknown)
  const frames = createFramesService({ startup: CONVERSATION, presets: port })

  assert.equal((await frames.applyPreset('empty')).ok, true)
  assert.equal(frames.project().docked.length, 1)
  assert.deepEqual(frames.project().docked[0]?.tabs, [])
})

test('a preset naming a type the shell never registered still loads', async () => {
  const { port } = medium()
  const options: FramesServiceOptions = { startup: CONVERSATION, platform: PLATFORM, presets: port }
  const author = service({ presets: port })
  author.split(undefined, 'notes')
  await author.savePreset('with-notes')

  // A preset is data about geometry; the registry is what draws it. A type with
  // no body still projects as a titled frame, so the tree loads either way.
  const reader = createFramesService(options)
  reader.reportMeasurements(VIEWPORT)
  assert.equal((await reader.applyPreset('with-notes')).ok, true)

  const kinds = reader.project().docked.flatMap((pane) => pane.tabs.map((tab) => tab.typeId))
  assert.deepEqual(kinds.sort(), ['conversation', 'notes'])
})

test('the name is the one the record carries, so a rename on disk is what loads', async () => {
  const { port, records } = medium()
  const frames = service({ presets: port })
  await frames.savePreset('work')
  const stored = records.get('work') as Preset
  records.set('renamed', { ...stored, name: 'renamed' })

  await frames.refreshPresets()
  assert.deepEqual(frames.presetNames(), ['renamed', 'work'])
  assert.equal((await frames.applyPreset('renamed')).ok, true)
  assert.equal(frames.activePresetId(), 'renamed')
})
