/**
 * The projection: everything a renderer needs for one frame of output, already
 * flattened and already degraded for that renderer's capabilities.
 *
 * `project` is a pure function of state. A capability limit is applied here and
 * never written back to the model, so one saved preset loads on every target.
 */
import type { PaneId, SplitId, TabId } from '../vendor/ui-dockkit/contract/types.ts'
import { dividerRect, FULL_RECT, splitRect, toExtent, type NormalizedRect } from '../geometry/rect.ts'
import type { FrameState } from '../model/state.ts'
import { getType } from '../model/types.ts'

/** Why a split of this pane would be refused now. */
export type SplitBlock = 'budget' | 'narrow'

/** One tab as a renderer draws it. */
export interface ProjectedTab {
  /** The tab's identity: what a drag names when it moves this chip. */
  readonly id: TabId
  readonly typeId: string
  readonly title: string
  readonly active: boolean
}

/** One docked pane, with its area already resolved. */
export interface ProjectedPane {
  readonly id: PaneId
  readonly rect: NormalizedRect
  readonly tabs: readonly ProjectedTab[]
  /** Whether the core would accept a split of this pane right now. */
  readonly canSplit: boolean
  /** Why it would not, when `canSplit` is false. */
  readonly splitBlockedBy: SplitBlock | undefined
}

/** One divider between two siblings of a split. */
export interface ProjectedDivider {
  readonly splitId: SplitId
  readonly axis: 'row' | 'column'
  /** Which divider of that split this is: it sits after child `index`. */
  readonly index: number
  /** Boundary position along the parent's axis, as a fraction of the parent. */
  readonly at: number
  /** The split's shares, so a drag can compute where the boundary would land. */
  readonly sizes: readonly number[]
  /** The split's own area; a share is a fraction of this, not of the window. */
  readonly parent: NormalizedRect
  readonly rect: NormalizedRect
}

/** How a target draws a floating frame. */
export type FloatPresentation = 'window' | 'overlay'

/** One floating frame. */
export interface ProjectedFloat {
  readonly id: PaneId
  readonly rect: NormalizedRect
  /** What the target should do with it: draw a positioned panel, or a switchable overlay. */
  readonly presentation: FloatPresentation
  readonly tabs: readonly ProjectedTab[]
  /** Whether the target may honour `rect`; false means it places the frame itself. */
  readonly rectHonoured: boolean
}

/** A fact the target cannot draw, reported rather than silently dropped. */
export interface Degradation {
  readonly kind: 'pane-dropped' | 'float-dropped' | 'rect-ignored'
  readonly target: string
  readonly message: string
}

/** Everything a renderer needs for one frame of output. */
export interface FrameViewProjection {
  readonly revision: number
  /** The target's id, or `unattached` before one declares its capabilities. */
  readonly platform: string
  readonly docked: readonly ProjectedPane[]
  /** Floating frames, bottom to top. */
  readonly floats: readonly ProjectedFloat[]
  readonly dividers: readonly ProjectedDivider[]
  readonly active: PaneId | undefined
  /** Whether the docked area is shown. */
  readonly expanded: boolean
  /** How the docked area is presented. */
  readonly mode: 'push' | 'fullscreen'
  readonly degradations: readonly Degradation[]
  readonly empty: boolean
}

/** Mutable accumulator for one traversal. */
interface Walk {
  readonly state: FrameState
  readonly budget: number | undefined
  readonly docked: ProjectedPane[]
  readonly floats: ProjectedFloat[]
  readonly dividers: ProjectedDivider[]
  readonly degradations: Degradation[]
  paneCount: number
}

/** Boundary position after the child at `through`, as a fraction of the parent. */
function boundaryAt(fractions: readonly number[], through: number): number {
  let offset = 0
  for (let index = 0; index <= through; index += 1) offset += fractions[index] ?? 0
  return offset
}

/** Whether this pane could be split now, and why not when it could not. */
function splitVerdict(walk: Walk, rect: NormalizedRect): { canSplit: boolean; blockedBy: SplitBlock | undefined } {
  if (walk.budget !== undefined && walk.paneCount >= walk.budget) {
    return { canSplit: false, blockedBy: 'budget' }
  }
  const capabilities = walk.state.platform?.capabilities
  const measurements = walk.state.measurements
  if (capabilities === undefined || measurements === undefined) {
    return { canSplit: false, blockedBy: 'narrow' }
  }
  const extent = toExtent(rect, measurements.viewport)
  const need = capabilities.minPaneSize * 2
  return extent.width >= need || extent.height >= need
    ? { canSplit: true, blockedBy: undefined }
    : { canSplit: false, blockedBy: 'narrow' }
}

/** One pane's tabs, in the order the pane holds them. */
function projectTabs(walk: Walk, paneId: PaneId): readonly ProjectedTab[] {
  const pane = walk.state.layout.nodes[paneId]
  if (pane === undefined || pane.kind !== 'pane') return []
  const tabs: ProjectedTab[] = []
  for (const tabId of pane.tabs) {
    const record = walk.state.layout.tabs[tabId]
    if (record === undefined) continue
    const definition = getType(walk.state.types, record.kind)
    tabs.push({
      id: record.id,
      typeId: record.kind,
      title: definition === undefined ? record.title : definition.title(),
      active: tabId === pane.activeTabId,
    })
  }
  return tabs
}

/** Visit one node, placing it inside `rect`. */
function visit(walk: Walk, nodeId: string, rect: NormalizedRect): void {
  const node = walk.state.layout.nodes[nodeId as PaneId]
  if (node === undefined) return

  if (node.kind === 'pane') {
    if (walk.budget !== undefined && walk.paneCount >= walk.budget) {
      walk.degradations.push({
        kind: 'pane-dropped',
        target: node.id,
        message: `the docked area allows ${walk.budget} pane(s); this one is not drawn`,
      })
      return
    }
    walk.paneCount += 1
    const verdict = splitVerdict(walk, rect)
    walk.docked.push({
      id: node.id,
      rect,
      tabs: projectTabs(walk, node.id),
      canSplit: verdict.canSplit,
      splitBlockedBy: verdict.blockedBy,
    })
    return
  }

  const rects = splitRect(rect, node.axis, node.sizes)
  node.children.forEach((childId, index) => {
    if (index > 0) {
      walk.dividers.push({
        splitId: node.id,
        axis: node.axis,
        index: index - 1,
        at: boundaryAt(node.sizes, index - 1),
        sizes: node.sizes,
        parent: rect,
        rect: dividerRect(rect, node.axis, node.sizes, index - 1),
      })
    }
    visit(walk, childId, rects[index] ?? rect)
  })
}

/** Where a floating frame sits when the model recorded no rectangle for it. */
const FLOAT_FALLBACK: NormalizedRect = { x: 0.55, y: 0.15, width: 0.4, height: 0.5 }

/**
 * Floating frames, bottom to top.
 *
 * A target that cannot float at all loses them, and one that cannot place them
 * keeps the rectangle unread — both are reported rather than silently dropped,
 * and neither changes the model.
 */
function collectFloats(walk: Walk): void {
  const capabilities = walk.state.platform?.capabilities
  const floats = capabilities?.floats ?? 'none'
  for (const paneId of walk.state.layout.floats) {
    const node = walk.state.layout.nodes[paneId]
    if (node === undefined || node.kind !== 'pane') continue
    if (floats === 'none') {
      walk.degradations.push({
        kind: 'float-dropped',
        target: paneId,
        message: 'this target cannot draw a floating frame',
      })
      continue
    }
    const rectHonoured = capabilities?.freeRect === true
    if (!rectHonoured) {
      walk.degradations.push({
        kind: 'rect-ignored',
        target: paneId,
        message: 'this target places a floating frame itself; the saved rectangle is kept but not used',
      })
    }
    walk.floats.push({
      id: paneId,
      rect: node.rect ?? FLOAT_FALLBACK,
      presentation: floats === 'overlay' ? 'overlay' : 'window',
      tabs: projectTabs(walk, paneId),
      rectHonoured,
    })
  }
}

/**
 * Project `state` for its attached platform.
 * @param state - the state to project; it is not modified.
 * @returns the flattened, already-degraded view a renderer draws.
 */
export function project(state: FrameState): FrameViewProjection {
  const walk: Walk = {
    state,
    budget: state.platform?.capabilities.maxDockPanes,
    docked: [],
    floats: [],
    dividers: [],
    degradations: [],
    paneCount: 0,
  }
  visit(walk, state.layout.rootId, FULL_RECT)
  collectFloats(walk)

  const active = walk.docked.some((pane) => pane.id === state.layout.activePaneId)
    ? state.layout.activePaneId
    : undefined

  return {
    revision: state.revision,
    platform: state.platform?.id ?? 'unattached',
    docked: walk.docked,
    floats: walk.floats,
    dividers: walk.dividers,
    active,
    expanded: state.layout.expanded,
    mode: state.layout.mode,
    degradations: walk.degradations,
    empty: walk.docked.length === 0,
  }
}
