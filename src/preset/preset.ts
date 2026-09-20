/**
 * Named layouts.
 *
 * A preset is a whole `LayoutState` plus the id counter it was minted from.
 * Storing the tree rather than the operations that built it is what makes a
 * preset load identically everywhere: replaying operations needs the ids to come
 * out the same, and a saved tree already has them.
 *
 * Nothing here touches a medium. The core says what a preset *is* and how a
 * stored one is validated and migrated; where it is kept is a port the host
 * answers, because the same preset has to load in a browser and in a terminal.
 */
import type { LayoutNode, LayoutOp, LayoutState, TabId, TabRecord } from '../vendor/ui-dockkit/contract/types.ts'
import { createIdMinter } from '../vendor/ui-dockkit/engine/initial.ts'
import type { ContentRegistry } from '../model/content.ts'
import { registerContent } from '../model/content.ts'
import { getType } from '../model/types.ts'
import type { FrameTypeRegistry } from '../model/types.ts'
import { applyOps, EMPTY_HISTORY } from '../ops/history.ts'
import { fail, ok, type FrameResult } from '../ops/result.ts'
import type { FrameState } from '../model/state.ts'

/** The stored format's own version; it moves independently of the package. */
export const PRESET_FORMAT_VERSION = 1

/** One named layout, as it is stored and as it is read back. */
export interface Preset {
  readonly version: number
  /** The preset's name, which is also the key it is stored under. */
  readonly name: string
  readonly layout: LayoutState
  /** The id counter the layout's ids were minted from. */
  readonly mint: number
}

/**
 * Where named presets are kept.
 *
 * Every method is async because every medium is: one is `localStorage`, another
 * is a file, another is a column. `read` hands back whatever the medium held and
 * validates nothing — telling a preset apart from a corrupt record is the core's
 * job, not the medium's.
 */
export interface PresetPort {
  /** The names the medium currently holds. */
  list(): Promise<readonly string[]>
  /** One stored record, still unvalidated, or `undefined` when the medium has none. */
  read(name: string): Promise<unknown>
  write(name: string, preset: Preset): Promise<void>
  remove(name: string): Promise<void>
}

/**
 * The largest counter any id in the tree was minted from.
 *
 * Ids are `<prefix><n>` over one shared counter, so the largest `n` anywhere in
 * the tree is a safe floor to restart from: a fresh mint steps past every id
 * that is still there, which is the only collision that could matter.
 * @param layout - the tree to scan.
 * @returns the counter, or 0 for a tree with no numbered ids.
 */
export function mintedThrough(layout: LayoutState): number {
  let highest = 0
  const consider = (id: string): void => {
    const digits = /(\d+)$/.exec(id)
    if (digits === null) return
    const value = Number(digits[1])
    if (Number.isFinite(value) && value > highest) highest = value
  }
  for (const id of Object.keys(layout.nodes)) consider(id)
  for (const id of Object.keys(layout.tabs)) consider(id)
  return highest
}

/**
 * Snapshot a state as a named preset.
 *
 * The layout is put through JSON on the way in. That is not a formality: the
 * model writes absent optionals as `undefined` properties, and a medium drops
 * them, so a preset that skipped this step would differ from its own reload.
 * Canonicalising at the write means the record, the value in memory, and the
 * value read back are the same object shape by construction.
 * @param state - the state to capture; it is not modified.
 * @param name - the name to store it under.
 * @returns a preset that survives a medium unchanged.
 */
export function toPreset(state: FrameState, name: string): Preset {
  const layout = JSON.parse(JSON.stringify(state.layout)) as LayoutState
  return {
    version: PRESET_FORMAT_VERSION,
    name,
    layout,
    mint: mintedThrough(layout),
  }
}

/** A layout in the shape a medium stores it, for comparing two of them. */
export function canonicalLayout(layout: LayoutState): LayoutState {
  return JSON.parse(JSON.stringify(layout)) as LayoutState
}

/** A string that can stand as an id or a key. */
function isId(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** Whether a value is a table. */
function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a stored value is a layout the core can actually drive.
 *
 * Deliberately stricter than "it has the right keys": a preset is authoritative
 * data, and a tree with a dangling child or a tab the registry has no record for
 * would be handed to the engine and fail there, far from the write that caused
 * it. Every reference is followed here instead.
 * @param value - the value to check.
 * @returns whether it is a complete, self-consistent layout.
 */
function isLayout(value: unknown): value is LayoutState {
  if (!isTable(value)) return false
  const { nodes, tabs, floats, rootId, activePaneId, expanded, mode } = value as Record<string, unknown>
  if (!isTable(nodes) || !isTable(tabs)) return false
  if (!Array.isArray(floats) || typeof expanded !== 'boolean') return false
  if (mode !== 'push' && mode !== 'fullscreen') return false
  if (!isId(rootId) || !isId(activePaneId)) return false
  if (nodes[rootId] === undefined) return false

  for (const [key, node] of Object.entries(nodes)) {
    if (!isTable(node)) return false
    // The engine looks nodes up by id, so an id that does not match its key is
    // a tree that reads differently depending on how you reach it.
    if (node.id !== key) return false
    if (node.kind === 'pane') {
      if (node.host !== 'dock' && node.host !== 'float') return false
      if (!Array.isArray(node.tabs)) return false
      if (node.rect !== undefined && node.rect !== null && !isTable(node.rect)) return false
      for (const tabId of node.tabs) {
        if (!isId(tabId) || tabs[tabId] === undefined) return false
      }
      if (node.activeTabId !== undefined && node.activeTabId !== null && !isId(node.activeTabId)) return false
      continue
    }
    if (node.kind === 'split') {
      if (node.axis !== 'row' && node.axis !== 'column') return false
      if (!Array.isArray(node.children) || !Array.isArray(node.sizes)) return false
      if (node.children.length !== node.sizes.length) return false
      for (const childId of node.children) {
        if (!isId(childId) || nodes[childId] === undefined) return false
      }
      continue
    }
    return false
  }

  for (const floatId of floats) {
    if (!isId(floatId) || nodes[floatId] === undefined) return false
  }
  return true
}

/**
 * Read a stored record back as a preset.
 *
 * Four things can be wrong with a stored preset and each gets its own answer:
 * it is not an object, it carries no usable version, it was written by a format
 * this build does not know, or its layout does not hold together. A version
 * *below* the current one is refused too, because the migration chain is empty
 * while v1 is the only format — guessing at an older shape would be worse than
 * saying so.
 * @param raw - the value the medium returned.
 * @returns the preset, normalised to the current format, or why it was refused.
 */
export function parsePreset(raw: unknown): FrameResult<Preset> {
  if (!isTable(raw)) {
    return fail('frames/unknown-preset', 'a stored preset must be an object')
  }
  if (!isId(raw.name)) {
    return fail('frames/unknown-preset', 'a stored preset must carry a name')
  }
  const name = raw.name
  const { version } = raw
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return fail('frames/unknown-preset', `preset "${name}" carries no usable format version`)
  }
  if (version > PRESET_FORMAT_VERSION) {
    return fail(
      'frames/unknown-preset',
      `preset "${name}" is v${version}, newer than v${PRESET_FORMAT_VERSION}; this build cannot read it`,
    )
  }
  if (version < PRESET_FORMAT_VERSION) {
    // The one line a v2 format adds its first step in front of.
    return fail(
      'frames/unknown-preset',
      `preset "${name}" is v${version} and no migration to v${PRESET_FORMAT_VERSION} is registered`,
    )
  }
  if (!isLayout(raw.layout)) {
    return fail('frames/unknown-preset', `preset "${name}" does not hold a layout this build can drive`)
  }

  const stored = typeof raw.mint === 'number' && Number.isFinite(raw.mint) ? raw.mint : 0
  // The tree is the floor: a medium that lost the counter, or one written before
  // the counter existed, must not be allowed to hand out an id the tree is using.
  const mint = Math.max(stored, mintedThrough(raw.layout))
  return ok({ version: PRESET_FORMAT_VERSION, name, layout: raw.layout, mint })
}

/**
 * Adopt a preset as the current layout.
 *
 * The preset becomes a *baseline*, not one more step: the operations that built
 * the previous tree cannot be replayed against this one, so the history is
 * dropped rather than left holding inverses into a tree that is gone.
 * @param state - the state to derive from.
 * @param preset - the preset to adopt, already validated.
 * @returns the state holding that layout, with nothing left to undo.
 */
export function withPreset(state: FrameState, preset: Preset): FrameState {
  // Adopted through the same canonical form, so the shell's live tree and the
  // record on disk are the same shape and a re-save writes identical bytes.
  const canonical = oneContentPerPane(canonicalLayout(preset.layout))
  // A preset says which *kinds* of frame were open; it cannot say that the plugins
  // supplying them are mounted here. Frames whose kind this shell does not have
  // are closed rather than kept as a titled empty box (see `withoutUnregistered`).
  const layout = withoutUnregistered(canonical, state.types)
  return {
    ...state,
    layout,
    // A restored tree's views name contents, and a view with no content behind it
    // has nothing to draw. A preset carries only the layout, so the contents it
    // references are taken up from it — and whatever the shell already held is
    // left alone, because restoring an arrangement is not the same request as
    // killing everything the arrangement does not mention.
    contents: adoptContents(state.contents, layout),
    minter: createIdMinter(preset.mint),
    history: EMPTY_HISTORY,
    activePresetId: preset.name,
    revision: state.revision + 1,
  }
}

/**
 * Close every frame whose content names a type this shell has not registered.
 *
 * `adoptContents` registers the *contents* a preset references, so a content is
 * never missing — which is exactly why a preset from a shell with more plugins
 * used to come back as a box with nothing in it but a title. What is missing is
 * the plugin that supplies the type, and a frame of a type nobody draws is not a
 * frame worth keeping: the user's requirement is that loading a preset **closes**
 * those frames.
 *
 * Docked frames go through the same operations a close gesture does
 * (`closeTab` + `merge`), so the split they leave collapses and the shares of
 * what remains are renormalised by the engine rather than by arithmetic here. Two
 * cases cannot: the root frame, which has no parent to collapse into and is left
 * empty (a shell with no docked area is nothing to draw — an empty root is the
 * "waiting for a choice" state), and floats, which have no parent split at all and
 * are removed outright.
 * @param layout - a validated, canonical layout.
 * @param types - the types this shell has registered.
 * @returns the layout without those frames; the same object when there are none.
 */
function withoutUnregistered(layout: LayoutState, types: FrameTypeRegistry): LayoutState {
  /** Whether this pane displays a kind the shell has not registered. */
  const unregistered = (id: string, current: LayoutState): boolean => {
    const node = current.nodes[id as keyof typeof current.nodes]
    if (node === undefined || node.kind !== 'pane') return false
    const tabId = node.tabs[0]
    const record = tabId === undefined ? undefined : current.tabs[tabId]
    return record !== undefined && getType(types, record.kind) === undefined
  }

  let current = layout
  const droppedFloats: string[] = []
  for (const id of Object.keys(layout.nodes)) {
    // One pane at a time, against the tree as it stands: a merge collapses the
    // split it leaves behind, and the root of the result may be a pane this loop
    // has not reached yet — merging *that* one is refused by the engine, which is
    // the same rule `closeFrame` follows when it leaves an emptied root alone.
    if (!unregistered(id, current)) continue
    const node = current.nodes[id as keyof typeof current.nodes]
    if (node === undefined || node.kind !== 'pane') continue
    const tabId = node.tabs[0]
    if (tabId === undefined) continue
    const ops: LayoutOp[] = [{ type: 'closeTab', tabId }]
    if (node.host === 'float') droppedFloats.push(id)
    else if (id !== current.rootId) ops.push({ type: 'merge', paneId: node.id })
    current = applyOps(current, ops).layout
  }
  if (droppedFloats.length === 0) return current

  // A float has no parent split to collapse into, so dropping one is a removal
  // rather than a close-and-merge.
  const nodes: Record<string, LayoutNode> = { ...current.nodes }
  for (const id of droppedFloats) delete nodes[id]
  const floats = current.floats.filter((id) => !droppedFloats.includes(id))
  // The focused frame may be one of the casualties; any pane will do, and the
  // root may now be a split rather than a pane.
  const survivors = Object.values(nodes).filter((node) => node.kind === 'pane')
  const activePaneId = nodes[current.activePaneId] === undefined
    ? survivors[0]?.id ?? current.activePaneId
    : current.activePaneId
  return { ...current, nodes, floats, activePaneId }
}

/**
 * Every pane left displaying exactly one content.
 *
 * A frame displays one content, so a stored tree that names several in one frame
 * is a tree from a shell that had tab strips. The view it was *showing* is the
 * one that stays — that is what the frame looked like — and the others are put
 * down: their records go, their contents stay in the registry, exactly as they
 * would if a person had switched the frame to something else.
 *
 * The normalisation is idempotent, which is what lets a preset be adopted without
 * asking which build wrote it.
 * @param layout - the layout to normalise; it is not modified.
 * @returns the same tree with one view per pane.
 */
function oneContentPerPane(layout: LayoutState): LayoutState {
  const dropped = new Set<string>()
  let changed = false
  const nodes: Record<string, LayoutNode> = { ...layout.nodes }
  for (const [id, node] of Object.entries(layout.nodes)) {
    if (node.kind !== 'pane' || node.tabs.length <= 1) continue
    const kept = node.activeTabId !== undefined && node.tabs.includes(node.activeTabId)
      ? node.activeTabId
      : node.tabs[0] as TabId
    for (const tabId of node.tabs) if (tabId !== kept) dropped.add(tabId)
    nodes[id] = { ...node, tabs: [kept], activeTabId: kept }
    changed = true
  }
  if (!changed) return layout
  const tabs: Record<string, TabRecord> = { ...layout.tabs }
  for (const tabId of dropped) delete tabs[tabId]
  // A tree whose every pane is empty has no root left to focus, so the active
  // pane is only kept when it still exists.
  const activePaneId = nodes[layout.activePaneId] === undefined ? layout.rootId as typeof layout.activePaneId : layout.activePaneId
  return { ...layout, nodes, tabs, activePaneId }
}

/**
 * Every content a layout's views reference, added to what the shell already has.
 * @param registry - the registry as it stands.
 * @param layout - the layout about to be adopted.
 * @returns the registry with each referenced content present.
 */
function adoptContents(registry: ContentRegistry, layout: LayoutState): ContentRegistry {
  let next = registry
  for (const tab of Object.values(layout.tabs)) {
    if (next.has(tab.contentId)) continue
    next = registerContent(next, { id: tab.contentId, kind: tab.kind, title: tab.title })
  }
  return next
}
