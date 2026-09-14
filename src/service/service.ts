/**
 * The service face: `ctx.frames`.
 *
 * This is the one contract the three repositories share. The renderers call it to
 * declare what they can draw and to report what they measured; the compatibility
 * layer calls it to drive the tree behind `ui-layout`'s interface; a terminal
 * renderer mounts the same plugin in its own composition.
 *
 * The core stays dependency-free: it publishes itself through the narrow host
 * shape below rather than importing a container.
 */
import type { PaneId, PaneNode, SplitAxis, SplitId, TabId } from '../vendor/ui-dockkit/contract/types.ts'
import type { FramePlatform } from '../model/platform.ts'
import type { FrameMeasurements, FrameState } from '../model/state.ts'
import { createFrameState, withMeasurements, withPlatform } from '../model/state.ts'
import type { FrameTypeDefinition } from '../model/types.ts'
import { registerType } from '../model/types.ts'
import type { FrameResult } from '../ops/result.ts'
import { fail } from '../ops/result.ts'
import type { DropTarget, FocusDirection } from '../ops/intents.ts'
import {
  closeFrame, dockFrame, dropFrame, floatFrame, focusFrame, moveFocus, placeFloat, placeTab, resizeSplit,
  splitFrame,
} from '../ops/intents.ts'
import type { NormalizedRect } from '../geometry/rect.ts'
import { project } from '../project/project.ts'
import type { FrameViewProjection } from '../project/project.ts'

/** What the service needs from its host to publish itself. */
export interface FramesHost {
  readonly reflect: {
    /** Publish `value` under `name`; the returned disposer settles the name. */
    provide(name: string, value: unknown): () => void
  }
}

/** The frame tree, as every renderer and the compatibility layer see it. */
export interface FramesService {
  /** Declare a frame type. Called once per type by its owning plugin. */
  registerType(definition: FrameTypeDefinition): void
  /** The renderer declares what it can draw. */
  attachRenderer(platform: FramePlatform): void
  /** The renderer reports its drawable extent, in its own unit. */
  reportMeasurements(measurements: FrameMeasurements): void
  /** The current projection, already degraded for the attached renderer. */
  project(): FrameViewProjection
  /** Subscribe to projection changes; the reference only changes on a change. */
  subscribe(listener: () => void): () => void

  split(paneId?: PaneId, seed?: string, axis?: SplitAxis): FrameResult<FrameState>
  close(paneId?: PaneId): FrameResult<FrameState>
  float(paneId?: PaneId): FrameResult<FrameState>
  dock(paneId?: PaneId): FrameResult<FrameState>
  focus(paneId: PaneId): FrameResult<FrameState>
  moveFocus(direction: FocusDirection): FrameResult<FrameState>
  /** Open a frame of `typeId`, or focus the one already showing it. */
  open(typeId: string): FrameResult<FrameState>

  /**
   * The one operation a pointer release produces, whatever the gesture was.
   * Geometry stays in the renderer; the decision is made here.
   */
  drop(tabId: TabId, target: DropTarget, seed?: string): FrameResult<FrameState>
  /** Move a chip to another caret slot in a strip. */
  placeTab(tabId: TabId, toPaneId: PaneId, index: number): FrameResult<FrameState>
  /** Record where a divider drag left a split. */
  resizeSplit(splitId: SplitId, sizes: readonly number[]): FrameResult<FrameState>
  /** Move or resize a floating frame; the gesture decides which. */
  placeFloat(paneId: PaneId, rect: NormalizedRect): FrameResult<FrameState>

  /** The type of the focused frame, or `undefined` when nothing is focused. */
  activeTypeId(): string | undefined
  /** Whether a frame of `typeId` is open anywhere. */
  isOpen(typeId: string): boolean
}

/** Where a fresh shell's first frame comes from. */
export interface FramesServiceOptions {
  /** The type the configuration-free shell opens. */
  readonly startup: FrameTypeDefinition
  /** The renderer's declaration, when it is already known at mount time. */
  readonly platform?: FramePlatform
}

/** What the service needs from a state to answer its queries. */
function activeType(state: FrameState): string | undefined {
  const pane = state.layout.nodes[state.layout.activePaneId]
  if (pane === undefined || pane.kind !== 'pane' || pane.activeTabId === undefined) return undefined
  return state.layout.tabs[pane.activeTabId]?.kind
}

/** Whether any pane, docked or floating, holds a tab of `typeId`. */
function holdsType(state: FrameState, typeId: string): boolean {
  return Object.values(state.layout.tabs).some((tab) => tab.kind === typeId)
}

/**
 * Build the service over one frame tree.
 * @param options - the startup type and an optional renderer declaration.
 * @returns the service, ready to publish.
 */
export function createFramesService(options: FramesServiceOptions): FramesService {
  let state = createFrameState({ startup: options.startup, platform: options.platform })
  const listeners = new Set<() => void>()
  let snapshot: FrameViewProjection = project(state)

  const publish = (): void => {
    snapshot = project(state)
    for (const listener of listeners) listener()
  }

  /**
   * Adopt an accepted intent and publish only when it moved the tree.
   *
   * The core answers a no-op intent (focusing the frame that already has focus,
   * floating one that already floats) with the same state object, so reference
   * inequality is what says the layout changed. Publishing on "accepted" alone
   * would redraw without a change and break the projection's reference contract.
   */
  const adopt = (result: FrameResult<FrameState>): FrameResult<FrameState> => {
    if (result.ok && result.value !== state) {
      state = result.value
      publish()
    }
    return result
  }

  return {
    registerType(definition: FrameTypeDefinition): void {
      state = { ...state, types: registerType(state.types, definition) }
      publish()
    },
    attachRenderer(platform: FramePlatform): void {
      state = withPlatform(state, platform)
      publish()
    },
    reportMeasurements(measurements: FrameMeasurements): void {
      state = withMeasurements(state, measurements)
      publish()
    },
    project: (): FrameViewProjection => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    split: (paneId?: PaneId, seed?: string, axis?: SplitAxis): FrameResult<FrameState> =>
      adopt(splitFrame(state, paneId, seed, axis)),
    close: (paneId?: PaneId): FrameResult<FrameState> => adopt(closeFrame(state, paneId)),
    float: (paneId?: PaneId): FrameResult<FrameState> => adopt(floatFrame(state, paneId)),
    dock: (paneId?: PaneId): FrameResult<FrameState> => adopt(dockFrame(state, paneId)),
    focus: (paneId: PaneId): FrameResult<FrameState> => adopt(focusFrame(state, paneId)),
    moveFocus: (direction: FocusDirection): FrameResult<FrameState> => adopt(moveFocus(state, direction)),
    drop: (tabId: TabId, target: DropTarget, seed?: string): FrameResult<FrameState> =>
      adopt(dropFrame(state, tabId, target, seed)),
    placeTab: (tabId: TabId, toPaneId: PaneId, index: number): FrameResult<FrameState> =>
      adopt(placeTab(state, tabId, toPaneId, index)),
    resizeSplit: (splitId: SplitId, sizes: readonly number[]): FrameResult<FrameState> =>
      adopt(resizeSplit(state, splitId, sizes)),
    placeFloat: (paneId: PaneId, rect: NormalizedRect): FrameResult<FrameState> =>
      adopt(placeFloat(state, paneId, rect)),

    open(typeId: string): FrameResult<FrameState> {
      const pane = Object.values(state.layout.nodes)
        .find((node): node is PaneNode =>
          node.kind === 'pane' && node.tabs.some((tabId) => state.layout.tabs[tabId]?.kind === typeId))
      if (pane !== undefined) return adopt(focusFrame(state, pane.id))
      if (state.layout.nodes[state.layout.rootId] === undefined) {
        return fail('frames/unknown-target', 'the layout has no root pane')
      }
      return adopt(splitFrame(state, undefined, typeId))
    },

    activeTypeId: (): string | undefined => activeType(state),
    isOpen: (typeId: string): boolean => holdsType(state, typeId),
  }
}

/**
 * Publish the service as `frames` on `host`.
 *
 * The host mounts this; the core never mounts itself, which is what lets a
 * terminal client mount the same service in its own composition.
 * @param host - the container to publish into.
 * @param options - the startup type and an optional renderer declaration.
 * @returns the service and the disposer that withdraws it.
 */
export function provideFramesService(
  host: FramesHost,
  options: FramesServiceOptions,
): { readonly service: FramesService; readonly dispose: () => void } {
  const service = createFramesService(options)
  const dispose = host.reflect.provide('frames', service)
  // The service holds no host registration of its own; withdrawing the name is
  // the whole teardown, and the host settles that asynchronously.
  return { service, dispose: () => { void dispose() } }
}
