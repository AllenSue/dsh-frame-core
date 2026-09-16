/**
 * The state the core manages, and the configuration-free starting point.
 */
import { createIdMinter, createInitialState, type IdMinter } from '../vendor/ui-dockkit/engine/initial.ts'
import type { LayoutState, TabId, TabRecord } from '../vendor/ui-dockkit/contract/types.ts'
import type { Extent } from '../geometry/rect.ts'
import { EMPTY_CONTENTS, registerContent, type ContentRegistry } from './content.ts'
import { EMPTY_HISTORY, type FrameHistory } from '../ops/history.ts'
import type { FramePlatform } from './platform.ts'
import { EMPTY_REGISTRY, registerType, type FrameTypeRegistry } from './types.ts'
import type { FrameTypeDefinition } from './types.ts'

/** What a renderer reports about the space it draws into, in its own unit. */
export interface FrameMeasurements {
  readonly viewport: Extent
}

/**
 * Everything the core manages.
 *
 * Every field is replaced rather than mutated, with one exception: `minter` is
 * the monotonic id source the engine requires, because ids are minted outside
 * an operation so a recorded sequence replays to the exact same tree.
 */
export interface FrameState {
  readonly layout: LayoutState
  /**
   * What there is to display, as opposed to where it is displayed.
   *
   * A view lives in `layout.tabs`; the content it shows lives here and outlives
   * it. Closing the last frame onto a content leaves the content alone.
   */
  readonly contents: ContentRegistry
  readonly types: FrameTypeRegistry
  readonly platform: FramePlatform | undefined
  readonly measurements: FrameMeasurements | undefined
  readonly activePresetId: string | undefined
  /** Accepted intents, one entry each; the projection never reads it. */
  readonly history: FrameHistory
  /** Advances on every accepted change; the renderer's redraw signal. */
  readonly revision: number
  readonly minter: IdMinter
}

/** How the core builds its starting state. */
export interface FrameStateOptions {
  /** The type a configuration-free shell opens. */
  readonly startup: FrameTypeDefinition
  /** Further declarations to register alongside it. */
  readonly types?: readonly FrameTypeDefinition[]
  /** The rendering target, once one has declared its capabilities. */
  readonly platform?: FramePlatform
}

/**
 * The state a configuration-free shell starts in: one frame of `startup`, filling
 * the drawable area, with the docked area expanded.
 *
 * The starting tab belongs to the initial state rather than to an operation, so
 * expanding and collapsing never accumulates copies of it.
 * @param options - the startup type and any further declarations.
 * @returns a single-frame state with nothing floating.
 */
export function createFrameState(options: FrameStateOptions): FrameState {
  // The startup type seeds the first frame; registering it belongs to whoever
  // provides its body, which is a different plugin. Registering here would make
  // the renderer claim a type it does not own, and the provider's own later
  // registration would collide with it.
  let types: FrameTypeRegistry = EMPTY_REGISTRY
  for (const definition of options.types ?? []) types = registerType(types, definition)

  const minter = createIdMinter()
  const makeStartupTab = (id: TabId): TabRecord => ({
    id,
    kind: options.startup.id,
    contentId: options.startup.id,
    title: options.startup.title(),
  })
  // The factory is the only place the seeded tab's record exists, so it is
  // captured on the way past rather than minted twice.
  let startupTab: TabRecord | undefined
  const layout = createInitialState(minter, (id) => {
    startupTab = makeStartupTab(id)
    return startupTab
  })

  return {
    layout: { ...layout, expanded: true },
    // The seeded frame is not placed by any operation, so its content goes into
    // the registry here — otherwise the very first content would be the one
    // content the shell could lose track of.
    contents: startupTab === undefined
      ? EMPTY_CONTENTS
      : registerContent(EMPTY_CONTENTS, {
        id: startupTab.contentId,
        kind: startupTab.kind,
        title: startupTab.title,
      }),
    types,
    platform: options.platform,
    measurements: undefined,
    activePresetId: undefined,
    history: EMPTY_HISTORY,
    revision: 0,
    minter,
  }
}

/**
 * A state with the content registry replaced and `revision` advanced.
 * @param state - the state to derive from.
 * @param contents - the next registry.
 */
export function withContents(state: FrameState, contents: ContentRegistry): FrameState {
  return { ...state, contents, revision: state.revision + 1 }
}

/**
 * A state with `layout` replaced and `revision` advanced.
 * @param state - the state to derive from.
 * @param layout - the next layout.
 */
export function withLayout(state: FrameState, layout: LayoutState): FrameState {
  return { ...state, layout, revision: state.revision + 1 }
}

/**
 * A state with the renderer's capability declaration attached or replaced.
 * @param state - the state to derive from.
 * @param platform - the target that just attached, or `undefined` on detach.
 */
export function withPlatform(state: FrameState, platform: FramePlatform | undefined): FrameState {
  return { ...state, platform, revision: state.revision + 1 }
}

/**
 * A state with fresh measurements from the renderer.
 * @param state - the state to derive from.
 * @param measurements - what the renderer just measured.
 */
export function withMeasurements(
  state: FrameState,
  measurements: FrameMeasurements | undefined,
): FrameState {
  return { ...state, measurements, revision: state.revision + 1 }
}
