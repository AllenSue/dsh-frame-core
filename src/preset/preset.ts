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
import type { LayoutState } from '../vendor/ui-dockkit/contract/types.ts'
import { createIdMinter } from '../vendor/ui-dockkit/engine/initial.ts'
import { EMPTY_HISTORY } from '../ops/history.ts'
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
  return {
    ...state,
    // Adopted through the same canonical form, so the shell's live tree and the
    // record on disk are the same shape and a re-save writes identical bytes.
    layout: canonicalLayout(preset.layout),
    minter: createIdMinter(preset.mint),
    history: EMPTY_HISTORY,
    activePresetId: preset.name,
    revision: state.revision + 1,
  }
}
