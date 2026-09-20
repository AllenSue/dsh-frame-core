/**
 * The projection: everything a renderer needs for one frame of output, already
 * flattened and already degraded for that renderer's capabilities.
 *
 * `project` is a pure function of state. A capability limit is applied here and
 * never written back to the model, so one saved preset loads on every target.
 */
import type { PaneId, SplitId } from '../vendor/ui-dockkit/contract/types.ts'
import { dividerRect, FULL_RECT, splitRect, toExtent, type Extent, type NormalizedRect } from '../geometry/rect.ts'
import type { FrameState } from '../model/state.ts'
import { getType } from '../model/types.ts'

/** Why a split of this pane would be refused now. */
export type SplitBlock = 'budget' | 'narrow'

/** What a frame displays, as a renderer draws it. */
export interface ProjectedContentRef {
  /** The content's identity: what `showContent` names to bring it back. */
  readonly contentId: string
  /** The registered type that draws it; an unregistered kind draws a titled frame. */
  readonly typeId: string
  readonly title: string
}

/** One docked pane, with its area already resolved. */
export interface ProjectedPane {
  readonly id: PaneId
  readonly rect: NormalizedRect
  /**
   * What this frame displays, or `undefined` for a frame waiting for a choice.
   *
   * **One content, not a list of them.** A frame is a place where one thing is
   * shown; a content that has tabs inside it — an editor with its files, a panel
   * with its pages — draws them itself, because they are its own state. The core
   * has no tab vocabulary, so none appears here.
   */
  readonly content: ProjectedContentRef | undefined
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
  /** What it displays; a floating frame holds one content, like any other. */
  readonly content: ProjectedContentRef | undefined
  /** Whether the target may honour `rect`; false means it places the frame itself. */
  readonly rectHonoured: boolean
}

/** A fact the target cannot draw, reported rather than silently dropped. */
export interface Degradation {
  readonly kind: 'pane-dropped' | 'float-dropped' | 'rect-ignored'
  readonly target: string
  readonly message: string
}

/**
 * What a renderer hands a frame body about the frame it is being drawn in.
 *
 * A body is content, and content sometimes has to know how much room it has — a
 * column that draws a compact rail when it is narrow, a panel that decides it no
 * longer fits. The renderer is the only thing that knows, so it passes it down.
 *
 * The area stays normalized and the viewport travels with it, so a body converts
 * to its own unit itself and the core never learns what that unit is.
 */
export interface FrameBodyProps {
  /** The frame's area, in fractions of the drawable area. */
  readonly rect: NormalizedRect
  /** The drawable area, so a body can turn fractions into its own unit. */
  readonly viewport: Extent
  /** Whether this frame currently holds focus. */
  readonly focused: boolean
}

/**
 * One content the shell is holding, as a picker or a switch would list it.
 *
 * A content is a thing that exists; a type is a thing that could. A picker shows
 * both, because "show me that one" and "make me one" are the same question asked
 * about two inventories.
 */
export interface ProjectedContent {
  readonly id: string
  readonly kind: string
  readonly title: string
  /**
   * Whether a frame displays it, or its owner draws it somewhere else.
   *
   * A picker offers only the placeable ones: showing a content whose owner draws
   * it would fill the chosen frame with whatever this renderer draws for a body
   * that returns nothing, which is an empty box. See `FrameTypePolicy.placeable`.
   */
  readonly placeable: boolean
}

/** One frame type, as a picker would list it. */
export interface ProjectedType {
  readonly id: string
  readonly title: string
  /**
   * Whether a new instance can be made from it.
   *
   * A picker offers only these under "new": a type that declares no factory is
   * one the shell can display but not bring into being, and offering it would be
   * an invitation to a refusal.
   */
  readonly instantiable: boolean
  /** Whether a frame displays it; the same question as for a content. */
  readonly placeable: boolean
}

/** Everything a renderer needs for one frame of output. */
export interface FrameViewProjection {
  readonly revision: number
  /** The target's id, or `unattached` before one declares its capabilities. */
  readonly platform: string
  /**
   * The drawable area in the target's own unit, or `undefined` before one has
   * reported it.
   *
   * Every renderer knows this and nothing else does, so it travels with the
   * projection: a body that has to be a fixed number of pixels wide reads it
   * here, and turns the width it wants into the share of the parent the core
   * asks for.
   */
  readonly viewport: Extent | undefined
  /**
   * Every registered type, in registration order.
   *
   * An empty frame draws this as its content picker — the list of things a
   * person can make here. The core lists what is registered and says which of
   * them can be instantiated; it does not decide what belongs in the list.
   */
  readonly types: readonly ProjectedType[]
  /**
   * Every content the shell holds, in id order.
   *
   * The other half of a picker: what already exists and can simply be shown. A
   * content with no frame on it is still here — that is the whole point of
   * holding contents apart from the frames that display them.
   */
  readonly contents: readonly ProjectedContent[]
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

/** What one pane displays, or `undefined` when it is waiting for a choice. */
function projectContent(walk: Walk, paneId: PaneId): ProjectedContentRef | undefined {
  const pane = walk.state.layout.nodes[paneId]
  if (pane === undefined || pane.kind !== 'pane') return undefined
  const tabId = pane.tabs[0]
  if (tabId === undefined) return undefined
  const record = walk.state.layout.tabs[tabId]
  if (record === undefined) return undefined
  const definition = getType(walk.state.types, record.kind)
  return {
    contentId: record.contentId,
    typeId: record.kind,
    title: definition === undefined ? record.title : definition.title(),
  }
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
      content: projectContent(walk, node.id),
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
      content: projectContent(walk, paneId),
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
    viewport: state.measurements?.viewport,
    // Read from the registry rather than kept: a plugin registering late is
    // reflected on the next projection without anything having to be told.
    types: [...state.types.byId.values()].map((definition) => ({
      id: definition.id,
      title: definition.title(),
      instantiable: definition.create !== undefined,
      placeable: definition.policy?.placeable !== false,
    })),
    contents: [...state.contents.values()]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((content) => ({
        id: content.id,
        kind: content.kind,
        title: content.title,
        placeable: getType(state.types, content.kind)?.policy?.placeable !== false,
      })),
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
