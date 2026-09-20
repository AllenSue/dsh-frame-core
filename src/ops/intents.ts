/**
 * The operations the core accepts.
 *
 * Every one of them is planned, governed, and recorded: a pure planner turns the
 * intent into engine operations, the policy of the affected frame type may refuse
 * it, and an accepted intent becomes exactly one history entry. A refusal returns
 * a result and leaves the state untouched.
 */
import { clampSizes } from '../vendor/ui-dockkit/engine/constraints.ts'
import type { TabFactory } from '../vendor/ui-dockkit/engine/initial.ts'
import {
  planFloatTab, planResizeSplit, planSplitPane, planUnfloatPane,
} from '../vendor/ui-dockkit/engine/planner.ts'
import type {
  DockZone, LayoutOp, LayoutState, NodeId, PaneId, PaneNode, SplitAxis, SplitDirection, SplitId, TabId,
  TabRecord,
} from '../vendor/ui-dockkit/contract/types.ts'
import type { NormalizedRect } from '../geometry/rect.ts'
import { clampFloatRect } from '../geometry/rect.ts'
import { placedPanes } from '../geometry/rects.ts'
import type { FrameState } from '../model/state.ts'
import { withContents, withLayout } from '../model/state.ts'
import type { ContentId, ContentRegistry, FrameContent } from '../model/content.ts'
import { forgetContent, getContent, registerContent } from '../model/content.ts'
import { getType } from '../model/types.ts'
import type { FrameTypeDefinition } from '../model/types.ts'
import { applyOps, canRedo, canUndo, pushIntent, type HistoryEntry } from './history.ts'
import { fail, ok, type FrameResult } from './result.ts'

/** A screen direction, in the renderer's frame of reference. */
export type FocusDirection = 'left' | 'right' | 'up' | 'down'

/** The type of the pane's active tab, when it has one. */
function activeTypeId(state: FrameState, paneId: PaneId): string | undefined {
  const node = state.layout.nodes[paneId]
  if (node === undefined || node.kind !== 'pane' || node.activeTabId === undefined) return undefined
  return state.layout.tabs[node.activeTabId]?.kind
}

/** The policy of the pane's active tab, when it has one. */
function activePolicy(state: FrameState, paneId: PaneId): { closable?: boolean; splittable?: boolean } {
  const typeId = activeTypeId(state, paneId)
  return typeId === undefined ? {} : getType(state.types, typeId)?.policy ?? {}
}

/**
 * The kind a pane's content is drawn by, or `undefined` when it holds none.
 *
 * A pane holds one content — one kind — so this is simply what is displayed
 * there. It stays a question worth asking because an empty pane, one waiting for
 * a choice, has no kind yet.
 * @param state - the state to read.
 * @param paneId - the pane to ask.
 * @returns the kind, or `undefined` for an empty pane.
 */
export function kindOfPane(state: FrameState, paneId: PaneId): string | undefined {
  const node = state.layout.nodes[paneId]
  if (node === undefined || node.kind !== 'pane') return undefined
  const first = node.tabs[0]
  return first === undefined ? undefined : state.layout.tabs[first]?.kind
}

/**
 * The view a pane is displaying: its one tab, if it has one.
 *
 * A frame shows one content. The engine underneath keeps a tab list per pane and
 * the shell keeps it at exactly one entry — which is also how the engine's own
 * floating panes work ("capacity 1 tab, drawn without a tab strip"). Everything
 * above this line talks about contents, never about tabs.
 * @param state - the state to read.
 * @param paneId - the pane to ask.
 * @returns the tab record it displays, or `undefined` for an empty pane.
 */
function displayedTab(state: FrameState, paneId: PaneId) {
  const node = state.layout.nodes[paneId]
  if (node === undefined || node.kind !== 'pane') return undefined
  const first = node.tabs[0]
  return first === undefined ? undefined : state.layout.tabs[first]
}

/**
 * The operations that put `record` in `paneId` in place of whatever it displays.
 *
 * One intent, and one history entry: the old view goes and the new one arrives
 * together, so stepping back lands on the frame showing what it showed before —
 * never on an empty frame that briefly existed.
 * @param state - the state to change.
 * @param paneId - the pane that changes what it displays.
 * @param record - the tab record to seat.
 * @returns the operations, oldest first.
 */
function planReplace(state: FrameState, paneId: PaneId, record: TabRecord): readonly LayoutOp[] {
  const node = state.layout.nodes[paneId]
  const showing = node === undefined || node.kind !== 'pane' ? undefined : node.tabs[0]
  const open: LayoutOp = { type: 'openTab', paneId, tab: record, index: 0 }
  return showing === undefined ? [open] : [{ type: 'closeTab', tabId: showing }, open]
}

/** How many contents of `kind` the shell is holding. */
function instancesOfKind(state: FrameState, kind: string): number {
  return [...state.contents.values()].filter((content) => content.kind === kind).length
}

/**
 * Whether a type's own limits allow one more instance.
 * @param state - the state to read.
 * @param definition - the declaring type.
 * @returns `undefined` when one more is allowed, else the refusal.
 */
function withinInstanceLimit(
  state: FrameState,
  definition: FrameTypeDefinition,
): FrameResult<FrameState> | undefined {
  const existing = instancesOfKind(state, definition.id)
  if (definition.singleton === true && existing > 0) {
    return fail('frames/instance-limit', `only one "${definition.id}" may exist`)
  }
  const limit = definition.policy?.maxInstances
  if (limit !== undefined && existing >= limit) {
    return fail('frames/instance-limit', `at most ${limit} "${definition.id}" may exist`)
  }
  return undefined
}

/** Whether a pane's content wants a share of the space freed beside it. */
function growsIn(state: FrameState, paneId: PaneId): boolean {
  const kind = kindOfPane(state, paneId)
  if (kind === undefined) return true
  return getType(state.types, kind)?.policy?.grows !== false
}

/**
 * Give back the shares a collapse should not have taken.
 *
 * Collapsing a split renormalises what is left, so every survivor takes a
 * proportional bite of the space that opened up. That is right for content that
 * can use the room and wrong for a column told to stay put: a 280px navigation
 * rail becomes 350px because the frame beside it closed.
 *
 * So the survivors are put back where they were and the freed share is handed
 * only to those that grow. With nobody to take it — every survivor fixed — the
 * proportional result stands, because the row still has to add up.
 * @param before - the layout the intent started from.
 * @param after - the layout the operations produced.
 * @param grows - whether a child absorbs freed space.
 * @returns the resize operations that undo the renormalisation.
 */
function settledSizes(
  before: LayoutState,
  after: LayoutState,
  grows: (childId: NodeId) => boolean,
): readonly LayoutOp[] {
  const ops: LayoutOp[] = []
  for (const node of Object.values(after.nodes)) {
    if (node.kind !== 'split') continue
    const was = before.nodes[node.id]
    if (was === undefined || was.kind !== 'split') continue
    if (node.children.length >= was.children.length) continue

    const share = new Map(was.children.map((childId, at) => [childId, was.sizes[at] ?? 0]))
    const kept = node.children
    const held = kept.reduce((sum, childId) => sum + (share.get(childId) ?? 0), 0)
    const freed = 1 - held
    const takers = kept.filter((childId) => grows(childId))
    const takerTotal = takers.reduce((sum, childId) => sum + (share.get(childId) ?? 0), 0)

    const sizes = kept.map((childId) => {
      const own = share.get(childId) ?? 0
      if (freed <= 1e-9 || takers.length === 0 || !takers.includes(childId)) return own
      // A taker with nothing to be proportional to still has to take something,
      // or the row would not add up.
      return takerTotal > 0 ? own + freed * (own / takerTotal) : own + freed / takers.length
    })
    ops.push({ type: 'resize', splitId: node.id, sizes: clampSizes(sizes, MIN_RESIZE_FRACTION) })
  }
  return ops
}

/** Record one accepted intent: apply it, advance the revision, push one entry. */
function commit(state: FrameState, ops: readonly LayoutOp[]): FrameResult<FrameState> {
  if (ops.length === 0) return fail('frames/unknown-target', 'the intent produced no operation')
  const planned = applyOps(state.layout, ops)
  // A collapse renormalises what survives; anything that asked to stay put gets
  // its share back, in the same history entry as the collapse itself.
  const sized = settledSizes(
    state.layout,
    planned.layout,
    // A nested split has no content of its own, so nothing can ask it to stay
    // put: it grows, and whatever is inside it decides for itself.
    (childId) => state.layout.nodes[childId]?.kind !== 'pane' || growsIn(state, childId as PaneId),
  )
  const forward = sized.length === 0 ? ops : [...ops, ...sized]
  const applied = sized.length === 0 ? planned : applyOps(state.layout, forward)
  const entry: HistoryEntry = { forward, inverse: applied.inverse }
  const next = withLayout(state, applied.layout)
  return ok({
    ...next,
    contents: materialise(state.contents, forward),
    history: pushIntent(state.history, entry),
  })
}

/**
 * Take up every content the operations seat a view for.
 *
 * This is the one place a content enters the registry *by being shown*, and it
 * is deliberately one-way: nothing here removes one. Closing a view is not
 * closing its content, and the only thing that ends a content is `forgetFrame`.
 * @param registry - the registry as it stands.
 * @param ops - the operations the intent is about to apply.
 * @returns the registry with every seated tab's content present.
 */
function materialise(registry: ContentRegistry, ops: readonly LayoutOp[]): ContentRegistry {
  let next = registry
  for (const op of ops) {
    if (op.type !== 'openTab' && op.type !== 'insertTab') continue
    if (next.has(op.tab.contentId)) continue
    next = registerContent(next, { id: op.tab.contentId, kind: op.tab.kind, title: op.tab.title })
  }
  return next
}

/**
 * The tab factory for a seeding type.
 *
 * Seeding is the content side's decision: the core is told which *type* should
 * fill a pane it would otherwise leave empty, and never decides that itself.
 * @param state - the state holding the registry.
 * @param seed - the type id to seed with, or `undefined` to seed nothing.
 * @returns the factory, or `undefined` when no type was named.
 */
function seedFactory(state: FrameState, seed: string | undefined): TabFactory | undefined {
  if (seed === undefined) return undefined
  const definition = getType(state.types, seed)
  if (definition === undefined) return undefined
  return (id: TabId): TabRecord => ({
    id,
    kind: definition.id,
    contentId: definition.id,
    title: definition.title(),
  })
}

/** Whether the renderer has reported enough for the core to judge geometry. */
function hasGeometry(state: FrameState): boolean {
  return state.platform !== undefined && state.measurements !== undefined
}

/** Whether two halves of `rect` would each fit this platform's minimum. */
function roomForTwo(rect: NormalizedRect, state: FrameState): boolean {
  const capabilities = state.platform?.capabilities
  const viewport = state.measurements?.viewport
  if (capabilities === undefined || viewport === undefined) return false
  const need = capabilities.minPaneSize * 2
  return rect.width * viewport.width >= need || rect.height * viewport.height >= need
}

/**
 * Which side of a reference frame a new one takes.
 *
 * A vocabulary of sides rather than of axes and directions, because that is what
 * a caller knows: a navigation column goes on the left, a panel on the right,
 * and which way that happens to run in the tree is the core's business.
 */
export type Placement = 'left' | 'right' | 'above' | 'below'

/**
 * How a placement splits the reference pane.
 * @param place - the side the new frame takes.
 * @returns the axis and the side of the reference pane it lands on.
 */
export function placementSplit(place: Placement): { axis: SplitAxis; direction: SplitDirection } {
  switch (place) {
    case 'left': return { axis: 'row', direction: 'before' }
    case 'right': return { axis: 'row', direction: 'after' }
    case 'above': return { axis: 'column', direction: 'before' }
    case 'below': return { axis: 'column', direction: 'after' }
  }
}

/**
 * Split a pane along an axis, seeding the new half with whatever `makeTab`
 * builds.
 *
 * The governance is the same for every caller — this is the one place the three
 * limits are applied — and what goes in the new half is the caller's business,
 * because a frame type and a named content both need to open a view and only
 * differ in the record they seat.
 * @param state - the state to change.
 * @param paneId - the reference pane.
 * @param makeTab - builds the tab the new pane starts with; omit for an empty pane.
 * @param axis - `row` splits left/right, `column` top/bottom.
 * @param direction - which side of the reference pane the new one takes.
 * @returns the next state, or why the split was refused.
 */
function splitWith(
  state: FrameState,
  paneId: PaneId,
  makeTab: TabFactory | undefined,
  axis: SplitAxis,
  direction: SplitDirection = 'after',
): FrameResult<FrameState> {
  if (!hasGeometry(state)) {
    return fail('frames/not-measured', 'no renderer has reported its drawable extent yet')
  }
  const panes = placedPanes(state.layout)
  const placed = panes.find((pane) => pane.id === paneId)
  if (placed === undefined) return fail('frames/unknown-target', `pane "${paneId}" is not drawn`)
  if (activePolicy(state, paneId).splittable === false) {
    return fail('frames/policy-refused', `the content of pane "${paneId}" refuses to be split`)
  }
  const budget = state.platform?.capabilities.maxDockPanes
  if (budget !== undefined && panes.length >= budget) {
    return fail('frames/pane-budget-exhausted', `the docked area allows ${budget} pane(s)`)
  }
  if (!roomForTwo(placed.rect, state)) {
    return fail('frames/too-narrow', `pane "${paneId}" has no room for two halves`)
  }
  // The engine keeps its own pane cap, so this budget can only tighten it.
  return commit(
    state,
    planSplitPane(state.layout, state.minter.next, paneId, makeTab, axis, direction),
  )
}

/**
 * Split a pane along an axis, seeding the new half with a type.
 * @param state - the state to change.
 * @param paneId - the reference pane; defaults to the focused one.
 * @param seed - frame type the new pane starts with; omit for an empty pane.
 * @param axis - `row` puts the new pane to the right, `column` below it.
 * @returns the next state, or why the split was refused.
 */
export function splitFrame(
  state: FrameState,
  paneId?: PaneId,
  seed?: string,
  axis: SplitAxis = 'row',
): FrameResult<FrameState> {
  if (seed !== undefined && getType(state.types, seed) === undefined) {
    return fail('frames/unknown-type', `type "${seed}" is not registered`)
  }
  return splitWith(state, paneId ?? state.layout.activePaneId, seedFactory(state, seed), axis)
}

/**
 * Close a frame: take down what it displays, and take the frame away with it.
 *
 * Two things this must not confuse. The **root pane is the shell** — closing it
 * takes down what it was showing and leaves the shell standing, because there is
 * no parent for it to collapse into and a shell with no docked area is nothing to
 * draw. Every other frame is a frame: it goes.
 *
 * A frame **with nothing in it** used to be refused here ("holds nothing to
 * close"), from a time when an empty pane could only be the shell itself. Frames
 * made by `split` start empty and wait for a choice, so that refusal left frames
 * a user could create and then not remove — deleting a frame is exactly what the
 * chord means.
 * @param state - the state to change.
 * @param paneId - the pane to close; defaults to the focused one.
 * @returns the next state, or why the close was refused.
 */
export function closeFrame(state: FrameState, paneId?: PaneId): FrameResult<FrameState> {
  const target = paneId ?? state.layout.activePaneId
  const node = state.layout.nodes[target]
  if (node === undefined || node.kind !== 'pane') {
    return fail('frames/unknown-target', `pane "${target}" does not exist`)
  }
  if (activePolicy(state, target).closable === false) {
    return fail('frames/policy-refused', `the content of pane "${target}" refuses to be closed`)
  }

  const ops: LayoutOp[] = node.tabs.map((tabId) => ({ type: 'closeTab', tabId }))
  // A docked pane that is not the root merges away — whether it still holds a
  // view being taken down or holds nothing at all, which is how an empty frame
  // is deleted.
  if (node.host === 'dock' && target !== state.layout.rootId) {
    ops.push({ type: 'merge', paneId: target })
  }
  // Nothing to take down and nowhere to merge: this is the shell, already in the
  // state the close would leave it in.
  if (ops.length === 0) return ok(state)
  return commit(state, ops)
}

/**
 * Move the focus to one pane.
 * @param state - the state to change.
 * @param paneId - the pane to focus.
 * @returns the next state; focusing the pane that already has focus changes nothing.
 */
export function focusFrame(state: FrameState, paneId: PaneId): FrameResult<FrameState> {
  if (state.layout.activePaneId === paneId) return ok(state)
  const node = state.layout.nodes[paneId]
  if (node === undefined) return fail('frames/unknown-target', `pane "${paneId}" does not exist`)
  return commit(state, [{ type: 'focusPane', paneId }])
}

/** Half-open overlap across the axis the movement does not use. */
function overlapsAcross(a: NormalizedRect, b: NormalizedRect, axis: 'x' | 'y'): boolean {
  return axis === 'x'
    ? Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0
    : Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0
}

/** Where a rectangle's centre sits on one axis. */
function centre(rect: NormalizedRect, axis: 'x' | 'y'): number {
  return axis === 'x' ? rect.x + rect.width / 2 : rect.y + rect.height / 2
}

/**
 * The nearest pane in `direction`: it must overlap the current pane across the
 * perpendicular axis and its centre must lie strictly on the far side.
 * @param state - the state to read.
 * @param direction - which way to look.
 * @returns the neighbour, or `undefined` when there is none.
 */
export function neighbour(state: FrameState, direction: FocusDirection): PaneId | undefined {
  const panes = placedPanes(state.layout)
  const current = panes.find((pane) => pane.id === state.layout.activePaneId)
  if (current === undefined) return undefined

  const axis = direction === 'left' || direction === 'right' ? 'x' : 'y'
  const forward = direction === 'right' || direction === 'down' ? 1 : -1
  let best: { readonly id: PaneId; readonly distance: number } | undefined

  for (const pane of panes) {
    if (pane.id === current.id) continue
    if (!overlapsAcross(current.rect, pane.rect, axis)) continue
    const distance = (centre(pane.rect, axis) - centre(current.rect, axis)) * forward
    if (distance <= 0) continue
    if (best === undefined || distance < best.distance) best = { id: pane.id, distance }
  }
  return best?.id
}

/**
 * Move the focus to the nearest pane in a direction.
 * @param state - the state to change.
 * @param direction - which way to move.
 * @returns the next state; with no neighbour the focus does not move.
 */
export function moveFocus(state: FrameState, direction: FocusDirection): FrameResult<FrameState> {
  const target = neighbour(state, direction)
  return target === undefined ? ok(state) : focusFrame(state, target)
}

/** Where the first floating frame sits, in fractions of the drawable area. */
const FLOAT_START: NormalizedRect = { x: 0.55, y: 0.15, width: 0.4, height: 0.5 }

/** Each further floating frame steps up and left, then wraps. */
const FLOAT_CASCADE = 0.04

/**
 * A normalized rectangle for the next floating frame.
 *
 * The engine's own default is expressed in pixels, which a normalized model
 * cannot use, so the core supplies its own rather than reading those constants.
 */
function nextFloatRect(state: FrameState): NormalizedRect {
  const step = (state.layout.floats.length % 4) * FLOAT_CASCADE
  return {
    x: FLOAT_START.x - step,
    y: FLOAT_START.y + step,
    width: FLOAT_START.width,
    height: FLOAT_START.height,
  }
}

/**
 * Move a docked pane's content into a floating frame.
 * @param state - the state to change.
 * @param paneId - the pane to float; defaults to the focused one.
 * @returns the next state, or why the move was refused.
 */
export function floatFrame(state: FrameState, paneId?: PaneId): FrameResult<FrameState> {
  const capabilities = state.platform?.capabilities
  if (capabilities === undefined) {
    return fail('frames/not-measured', 'no renderer has declared its capabilities yet')
  }
  if (capabilities.floats === 'none') {
    return fail('frames/unsupported-on-platform', 'this target cannot draw a floating frame')
  }
  const target = paneId ?? state.layout.activePaneId
  const node = state.layout.nodes[target]
  if (node === undefined || node.kind !== 'pane') {
    return fail('frames/unknown-target', `pane "${target}" does not exist`)
  }
  if (node.host === 'float') return ok(state)
  if (node.activeTabId === undefined) {
    return fail('frames/unknown-target', `pane "${target}" holds nothing to float`)
  }

  const typeId = activeTypeId(state, target)
  const definition = typeId === undefined ? undefined : getType(state.types, typeId)
  if (definition?.hosts !== undefined && !definition.hosts.includes('float')) {
    return fail('frames/policy-refused', `the content of pane "${target}" refuses to float`)
  }

  const planned = planFloatTab(state.layout, state.minter.next, node.activeTabId, nextFloatRect(state))
  // A docked pane that is not the root merges away once its last tab leaves,
  // exactly as it does when that tab is closed.
  const ops: LayoutOp[] = target !== state.layout.rootId && node.tabs.length === 1
    ? [...planned.ops, { type: 'merge', paneId: target }]
    : [...planned.ops]
  return commit(state, ops)
}

/**
 * Send a floating frame's content back into the docked tree.
 * @param state - the state to change.
 * @param paneId - the floating pane; defaults to the focused one.
 * @returns the next state, or why the move was refused.
 */
export function dockFrame(state: FrameState, paneId?: PaneId): FrameResult<FrameState> {
  const target = paneId ?? state.layout.activePaneId
  const node = state.layout.nodes[target]
  if (node === undefined || node.kind !== 'pane') {
    return fail('frames/unknown-target', `pane "${target}" does not exist`)
  }
  if (node.host !== 'float') return ok(state)
  return commit(state, planUnfloatPane(state.layout, target))
}

/**
 * Where a dragged frame may be released.
 *
 * `dock` names both halves of the release in one value: which pane is under the
 * pointer and which of its five regions the pointer sits in. `float` is the
 * release over nothing — the frame leaves the docked tree and becomes a window.
 */
export type DropTarget =
  | { readonly kind: 'dock'; readonly paneId: PaneId; readonly zone: DockZone }
  | { readonly kind: 'float'; readonly rect?: NormalizedRect }

/**
 * Release a dragged frame on a target.
 *
 * Retired with the tab strip. A release used to name the *tab* that was dragged,
 * because the thing a pointer picked up was a chip in a frame's strip — and a
 * shell that shows one content per frame has no such chip. Moving a content
 * between frames is now `showContent(paneId, contentId)` (one call, which a
 * plugin's own tab strip can make just as well as a shell gesture could), and
 * splitting a frame is the keyboard's `C-x right` / `C-x down`.
 *
 * The intent stays in the vocabulary and refuses, rather than disappearing: a
 * caller that still asks for it deserves to be told why, in the tree's own words.
 * @param state - the state to change; it is not modified.
 * @param tabId - the tab that was dragged.
 * @param target - what the pointer released on.
 * @param seed - type that backfills a pane the drop would otherwise empty.
 * @returns the refusal.
 */
export function dropFrame(
  state: FrameState,
  tabId: TabId,
  target: DropTarget,
  seed?: string,
): FrameResult<FrameState> {
  void state
  void tabId
  void target
  void seed
  return fail(
    'frames/one-content-per-frame',
    'a frame displays one content; there is no strip to drop a tab into or out of',
  )
}

/**
 * Move a chip to another caret slot in the strip it already sits in.
 *
 * Retired with the strip, for the same reason `dropFrame` was: there are no
 * chips. Reordering what a content shows inside itself is that content's own
 * business — the plugin draws its own tabs and moves them in its own way.
 * @param state - the state to change; it is not modified.
 * @param tabId - the tab being moved.
 * @param toPaneId - the strip it lands in.
 * @param index - the caret slot it lands at.
 * @returns the refusal.
 */
export function placeTab(
  state: FrameState,
  tabId: TabId,
  toPaneId: PaneId,
  index: number,
): FrameResult<FrameState> {
  void state
  void tabId
  void toPaneId
  void index
  return fail(
    'frames/one-content-per-frame',
    'a frame displays one content; there is no strip to reorder within',
  )
}

/**
 * Record the net sizes a divider drag reached.
 * @param state - the state to change.
 * @param splitId - the split whose divider moved.
 * @param sizes - the fractions the drag reached, already clamped by the renderer.
 * @returns the next state, or why the resize was refused.
 */
export function resizeSplit(
  state: FrameState,
  splitId: SplitId,
  sizes: readonly number[],
): FrameResult<FrameState> {
  const node = state.layout.nodes[splitId]
  if (node === undefined || node.kind !== 'split') {
    return fail('frames/unknown-target', `split "${splitId}" does not exist`)
  }
  if (sizes.length !== node.sizes.length) {
    return fail('frames/unknown-target', `split "${splitId}" has ${node.sizes.length} child(ren), not ${sizes.length}`)
  }
  const clamped = clampSizes(sizes)
  const unchanged = clamped.every((size, index) => Math.abs(size - (node.sizes[index] ?? 0)) < 1e-9)
  if (unchanged) return ok(state)
  return commit(state, planResizeSplit(splitId, clamped))
}

/**
 * Move or resize a floating frame.
 *
 * One intent covers both because one pointer gesture drives both: dragging the
 * title bar changes the position alone, dragging a corner changes the rectangle.
 * The operation recorded is whichever one the pointer actually produced, so
 * stepping back restores exactly what moved.
 * @param state - the state to change.
 * @param paneId - the floating pane.
 * @param rect - where the gesture left it, in fractions of the drawable area.
 * @returns the next state, or why the move was refused.
 */
export function placeFloat(
  state: FrameState,
  paneId: PaneId,
  rect: NormalizedRect,
): FrameResult<FrameState> {
  const node = state.layout.nodes[paneId]
  if (node === undefined || node.kind !== 'pane' || node.host !== 'float') {
    return fail('frames/unknown-target', `pane "${paneId}" is not floating`)
  }
  const current = node.rect ?? FLOAT_START
  // The gesture previews with the same clamp, so what the user let go of is
  // exactly what the model records.
  const next = clampFloatRect(rect)
  const same = current.x === next.x && current.y === next.y
    && current.width === next.width && current.height === next.height
  if (same) return ok(state)
  const op: LayoutOp = current.width === next.width && current.height === next.height
    ? { type: 'moveFloat', paneId, x: next.x, y: next.y }
    : { type: 'resizeFloat', paneId, rect: next }
  return commit(state, [op])
}

/**
 * Register a content without showing it.
 *
 * A content that is never registered can still enter the registry by being
 * shown; registering it first is what lets it exist with no view at all, which
 * is how a shell opens onto a layout that does not include everything it holds.
 * @param state - the state to change.
 * @param content - the content to hold.
 * @returns the next state; it is not a layout change and records no history.
 */
export function registerFrame(state: FrameState, content: FrameContent): FrameResult<FrameState> {
  if (content.id === '') return fail('frames/unknown-content', 'a content needs an id')
  if (content.kind === '') return fail('frames/unknown-content', `content "${content.id}" needs a kind`)
  if (getContent(state.contents, content.id) !== undefined) return ok(state)
  return ok(withContents(state, registerContent(state.contents, content)))
}

/**
 * Destroy a content outright, whatever is showing it.
 *
 * The one intent that ends a content. It touches no view — a frame left showing
 * a forgotten content draws its own "gone" state — so a caller that means "make
 * this disappear" closes the views first.
 *
 * It records no history: the history is a sequence of *layout* operations, and
 * this is not one. Undoing a layout change cannot bring a content back.
 * @param state - the state to change.
 * @param id - the content to end.
 * @returns the next state; forgetting a content that is not held changes nothing.
 */
export function forgetFrame(state: FrameState, id: ContentId): FrameResult<FrameState> {
  if (getContent(state.contents, id) === undefined) return ok(state)
  return ok(withContents(state, forgetContent(state.contents, id)))
}

/**
 * Show a content, or bring a frame already showing it into focus.
 *
 * This is `switch-to-buffer`: the content is the subject, and the frame is
 * whatever ends up displaying it. A content two frames already show is focused
 * rather than shown a third time — opening another view of it is a different
 * request, and a deliberate one.
 * @param state - the state to change.
 * @param contentId - the content to show; it must be registered.
 * @param options - which side of which frame a new one takes when it has to be made.
 * @returns the next state, or why the content could not be shown.
 */
export function openContent(
  state: FrameState,
  contentId: ContentId,
  options: OpenOptions = {},
): FrameResult<FrameState> {
  const content = getContent(state.contents, contentId)
  if (content === undefined) {
    return fail('frames/unknown-content', `no content "${contentId}" is registered`)
  }

  const showing = Object.values(state.layout.nodes)
    .find((node): node is PaneNode => node.kind === 'pane'
      && node.tabs.some((tabId) => state.layout.tabs[tabId]?.contentId === contentId))
  if (showing !== undefined) return focusFrame(state, showing.id)

  const beside = options.beside ?? state.layout.activePaneId
  const { axis, direction } = placementSplit(options.place ?? 'right')
  // The new view names the content, not the type: a type is how to draw it, and
  // the content is which one — the distinction the whole registry exists for.
  const makeTab = (id: TabId): TabRecord => ({
    id,
    kind: content.kind,
    contentId: content.id,
    title: content.title,
  })
  return splitWith(state, beside, makeTab, axis, direction)
}

/**
 * Make one new instance of a type and show it in a pane.
 *
 * This is what a picker does when the user chooses a type, and what a "new
 * editor" command does afterwards: the type's own factory says what the
 * instance *is*, and the core registers it and shows it in the pane —
 * **replacing what that frame was displaying**, the same swap `showContent`
 * makes. What is replaced is put down rather than destroyed.
 *
 * Everything the core checks is the type's own declaration: that it is
 * instantiable, and that it is within its instance limit.
 * @param state - the state to change.
 * @param typeId - the type to instantiate.
 * @param paneId - the pane to show it in; defaults to the focused one.
 * @returns the next state, or why it was refused.
 */
export function createContent(
  state: FrameState,
  typeId: string,
  paneId?: PaneId,
): FrameResult<FrameState> {
  const definition = getType(state.types, typeId)
  if (definition === undefined) return fail('frames/unknown-type', `type "${typeId}" is not registered`)
  if (definition.create === undefined) {
    return fail('frames/unknown-type', `type "${typeId}" cannot be instantiated`)
  }
  const target = paneId ?? state.layout.activePaneId
  const node = state.layout.nodes[target]
  if (node === undefined || node.kind !== 'pane') {
    return fail('frames/unknown-target', `pane "${target}" does not exist`)
  }

  const limit = withinInstanceLimit(state, definition)
  if (limit !== undefined) return limit

  // The factory runs before anything is committed, so a plugin that throws
  // leaves the tree untouched rather than half-changed.
  const content = definition.create()
  const record: TabRecord = {
    id: state.minter.next('tab'),
    kind: content.kind,
    contentId: content.id,
    title: content.title,
  }
  // Registered first, then seated: the seat's `materialise` would take it up
  // anyway, but a content the shell holds is what makes it switchable back to.
  const registered = registerFrame(state, content)
  if (!registered.ok) return registered
  return commit(registered.value, planReplace(registered.value, target, record))
}

/**
 * Show a content in a pane, replacing what it was displaying.
 *
 * The counterpart to `openContent`, which is `switch-to-buffer` without saying
 * where: this one names the frame, because "show this here" is a different
 * request from "show this somewhere".
 *
 * **It replaces, and that is the model rather than a simplification.** A frame
 * displays one content; a content that has tabs inside it — an editor with its
 * files, a panel with its pages — draws them itself, because they are its own
 * state and the shell has no business holding them. So "show this here" is a
 * swap: the frame displays the new content, and the old one is not destroyed but
 * *put down* — it stays in the registry, and showing it again is one call
 * (T15's window/buffer guarantee, unchanged).
 * @param state - the state to change.
 * @param paneId - the pane to show it in.
 * @param contentId - the content to show; it must be registered.
 * @returns the next state, or why it was refused.
 */
export function showContent(
  state: FrameState,
  paneId: PaneId,
  contentId: ContentId,
): FrameResult<FrameState> {
  const content = getContent(state.contents, contentId)
  if (content === undefined) {
    return fail('frames/unknown-content', `no content "${contentId}" is registered`)
  }
  const node = state.layout.nodes[paneId]
  if (node === undefined || node.kind !== 'pane') {
    return fail('frames/unknown-target', `pane "${paneId}" does not exist`)
  }

  // Already displayed here: this is a focus, not a swap.
  const showing = displayedTab(state, paneId)
  if (showing?.contentId === contentId) {
    return commit(state, [{ type: 'focusTab', tabId: showing.id }])
  }
  return commit(state, planReplace(state, paneId, {
    id: state.minter.next('tab'),
    kind: content.kind,
    contentId: content.id,
    title: content.title,
  }))
}

/** Where a frame goes when one has to be made for it. */
export interface OpenOptions {
  /** Which side of the reference frame it takes; defaults to `right`. */
  readonly place?: Placement
  /** The frame it goes beside; defaults to the focused one. */
  readonly beside?: PaneId
}

/**
 * The smallest share a deliberate resize may leave a pane.
 *
 * Much smaller than the divider-drag floor, and deliberately so. That floor
 * exists to stop a *gesture* from swallowing a neighbour by accident; a caller
 * naming a share is stating what it wants, and the thing it wants may well be a
 * 56px navigation rail — which is below `minPaneSize`, because `minPaneSize`
 * governs whether a *split* leaves two usable halves and says nothing about a
 * resize. Emacs lets a window be one line tall for the same reason.
 */
export const MIN_RESIZE_FRACTION = 0.02

/**
 * Give one pane a share of its parent split.
 *
 * The caller names a share of the parent, not pixels: it has no way to know the
 * split that holds the pane, and the core does. What it does know is how wide it
 * wants to be, in its own unit — so it converts once, against the viewport.
 *
 * The difference comes out of the siblings in proportion to what they already
 * hold, so a pane that was twice its neighbour stays twice its neighbour.
 * @param state - the state to change.
 * @param paneId - the pane to resize.
 * @param fraction - the share of its parent split it should take.
 * @param minimum - smallest share any child may be left; defaults to the resize floor.
 * @returns the next state, or why the resize was refused.
 */
export function resizePane(
  state: FrameState,
  paneId: PaneId,
  fraction: number,
  minimum: number = MIN_RESIZE_FRACTION,
): FrameResult<FrameState> {
  const node = state.layout.nodes[paneId]
  if (node === undefined) return fail('frames/unknown-target', `pane "${paneId}" does not exist`)
  const parent = Object.values(state.layout.nodes)
    .find((candidate) => candidate.kind === 'split' && candidate.children.includes(paneId))
  // The root pane fills the frame and has no parent, so there is no share to
  // change. That is not an error, it is a request with nothing to do.
  if (parent === undefined || parent.kind !== 'split') return ok(state)

  const index = parent.children.indexOf(paneId)
  const current = parent.sizes[index]
  if (current === undefined) return fail('frames/unknown-target', `split "${parent.id}" has no share for "${paneId}"`)

  const others = parent.children.reduce((sum, childId, at) => (
    childId === paneId ? sum : sum + (parent.sizes[at] ?? 0)
  ), 0)
  const remaining = 1 - fraction
  const next = parent.children.map((childId, at) => {
    if (childId === paneId) return fraction
    const share = parent.sizes[at] ?? 0
    // With nothing left to take from, the remainder is split evenly — which only
    // happens when every sibling is already at zero.
    return others > 0 ? (share / others) * remaining : remaining / (parent.children.length - 1)
  })

  const clamped = clampSizes(next, minimum)
  if (clamped.every((size, at) => Math.abs(size - (parent.sizes[at] ?? 0)) < 1e-9)) return ok(state)
  return commit(state, planResizeSplit(parent.id, clamped, minimum))
}

/**
 * Step the last intent back.
 * @param state - the state to change.
 * @returns the state before that intent, or why nothing was undone.
 */
export function undo(state: FrameState): FrameResult<FrameState> {
  const history = state.history
  if (!canUndo(history)) return fail('frames/nothing-to-undo', 'there is no layout change to undo')
  const entry = history.past[history.past.length - 1] as HistoryEntry
  const next = withLayout(state, applyOps(state.layout, entry.inverse).layout)
  return ok({
    ...next,
    history: { past: history.past.slice(0, -1), future: [...history.future, entry] },
  })
}

/**
 * Step an undone intent forward again.
 * @param state - the state to change.
 * @returns the state with that intent re-applied, or why nothing was redone.
 */
export function redo(state: FrameState): FrameResult<FrameState> {
  const history = state.history
  if (!canRedo(history)) return fail('frames/nothing-to-redo', 'there is no layout change to redo')
  const entry = history.future[history.future.length - 1] as HistoryEntry
  const next = withLayout(state, applyOps(state.layout, entry.forward).layout)
  return ok({
    ...next,
    history: { past: [...history.past, entry], future: history.future.slice(0, -1) },
  })
}
