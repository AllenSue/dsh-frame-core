/**
 * The operations the core accepts.
 *
 * Every one of them is planned, governed, and recorded: a pure planner turns the
 * intent into engine operations, the policy of the affected frame type may refuse
 * it, and an accepted intent becomes exactly one history entry. A refusal returns
 * a result and leaves the state untouched.
 */
import { canSplit, clampSizes, MAX_DOCK_PANES, zoneSplit } from '../vendor/ui-dockkit/engine/constraints.ts'
import type { TabFactory } from '../vendor/ui-dockkit/engine/initial.ts'
import {
  planDropTab, planFloatTab, planPlaceTab, planResizeSplit, planSettle, planSplitPane, planUnfloatPane,
} from '../vendor/ui-dockkit/engine/planner.ts'
import type {
  DockZone, LayoutOp, PaneId, PaneNode, SplitAxis, SplitId, TabId, TabRecord,
} from '../vendor/ui-dockkit/contract/types.ts'
import type { NormalizedRect } from '../geometry/rect.ts'
import { clampFloatRect } from '../geometry/rect.ts'
import { placedPanes } from '../geometry/rects.ts'
import type { FrameState } from '../model/state.ts'
import { withContents, withLayout } from '../model/state.ts'
import type { ContentId, ContentRegistry, FrameContent } from '../model/content.ts'
import { forgetContent, getContent, registerContent } from '../model/content.ts'
import { getType } from '../model/types.ts'
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

/** Record one accepted intent: apply it, advance the revision, push one entry. */
function commit(state: FrameState, ops: readonly LayoutOp[]): FrameResult<FrameState> {
  if (ops.length === 0) return fail('frames/unknown-target', 'the intent produced no operation')
  const applied = applyOps(state.layout, ops)
  const entry: HistoryEntry = { forward: ops, inverse: applied.inverse }
  const next = withLayout(state, applied.layout)
  return ok({ ...next, contents: materialise(state.contents, ops), history: pushIntent(state.history, entry) })
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
 * @param axis - `row` puts the new pane to the right, `column` below it.
 * @returns the next state, or why the split was refused.
 */
function splitWith(
  state: FrameState,
  paneId: PaneId,
  makeTab: TabFactory | undefined,
  axis: SplitAxis,
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
  return commit(state, planSplitPane(state.layout, state.minter.next, paneId, makeTab, axis))
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
 * Close every tab of a pane and drop the pane if it was not the root.
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
  if (node.tabs.length === 0) {
    return fail('frames/unknown-target', `pane "${target}" holds nothing to close`)
  }
  if (activePolicy(state, target).closable === false) {
    return fail('frames/policy-refused', `the content of pane "${target}" refuses to be closed`)
  }

  const ops: LayoutOp[] = node.tabs.map((tabId) => ({ type: 'closeTab', tabId }))
  // A docked pane that is not the root merges away once its last tab is gone.
  if (node.host === 'dock' && target !== state.layout.rootId) {
    ops.push({ type: 'merge', paneId: target })
  }
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

/** The pane holding `tabId`, docked or floating. */
function paneHolding(state: FrameState, tabId: TabId): PaneId | undefined {
  for (const node of Object.values(state.layout.nodes)) {
    if (node.kind === 'pane' && node.tabs.includes(tabId)) return node.id
  }
  return undefined
}

/**
 * Release a dragged frame on a target.
 *
 * This is the one semantic operation every pointer release produces, whatever
 * the pointer did: the geometry lives in the renderer, and the *decision* — move
 * the frame into a pane, split a pane to seat it, or take it out into a window —
 * is made here, once, under the same governance as the keyboard paths. A drop
 * the model cannot carry out is refused and changes nothing.
 * @param state - the state to change.
 * @param tabId - the tab that was dragged.
 * @param target - what the pointer released on.
 * @param seed - type that backfills a pane the drop would otherwise empty; the
 *   content side names it, exactly as `splitFrame` asks it to.
 * @returns the next state, or why the release was refused.
 */
export function dropFrame(
  state: FrameState,
  tabId: TabId,
  target: DropTarget,
  seed?: string,
): FrameResult<FrameState> {
  const sourceId = paneHolding(state, tabId)
  const source = sourceId === undefined ? undefined : state.layout.nodes[sourceId]
  if (sourceId === undefined || source === undefined || source.kind !== 'pane') {
    return fail('frames/unknown-target', `tab "${tabId}" is not drawn anywhere`)
  }
  if (seed !== undefined && getType(state.types, seed) === undefined) {
    return fail('frames/unknown-type', `type "${seed}" is not registered`)
  }
  const makeTab = seedFactory(state, seed)

  if (target.kind === 'float') {
    const capabilities = state.platform?.capabilities
    if (capabilities === undefined) {
      return fail('frames/not-measured', 'no renderer has declared its capabilities yet')
    }
    if (capabilities.floats === 'none') {
      return fail('frames/unsupported-on-platform', 'this target cannot draw a floating frame')
    }
    // Already the only thing in a window: pulling it out would move nothing.
    if (source.host === 'float' && source.tabs.length === 1) return ok(state)
    const definition = getType(state.types, state.layout.tabs[tabId]?.kind ?? '')
    if (definition?.hosts !== undefined && !definition.hosts.includes('float')) {
      return fail('frames/policy-refused', `the content of tab "${tabId}" refuses to float`)
    }
    const planned = planFloatTab(state.layout, state.minter.next, tabId, target.rect ?? nextFloatRect(state))
    const ops: LayoutOp[] = [...planned.ops]
    // A docked pane that is not the root merges away once its last tab leaves,
    // exactly as it does when that tab is closed or floated by the key map.
    if (source.host === 'dock' && sourceId !== state.layout.rootId && source.tabs.length === 1) {
      ops.push({ type: 'merge', paneId: sourceId })
    }
    return commit(state, ops)
  }

  const paneId = target.paneId
  const node = state.layout.nodes[paneId]
  if (node === undefined || node.kind !== 'pane' || node.host !== 'dock') {
    return fail('frames/unknown-target', `pane "${paneId}" is not a docked pane`)
  }
  if (zoneSplit(target.zone) !== undefined) {
    // An edge release is a split, so it answers to the same three limits a
    // keyboard split does — and refuses in the same words.
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
    // The engine keeps its own cap, so a platform that declares none is still
    // bounded — and says so rather than quietly changing nothing.
    if (!canSplit(state.layout)) {
      return fail('frames/pane-budget-exhausted', `the docked area allows ${MAX_DOCK_PANES} pane(s)`)
    }
    if (!roomForTwo(placed.rect, state)) {
      return fail('frames/too-narrow', `pane "${paneId}" has no room for two halves`)
    }
  }

  const ops = planDropTab(state.layout, state.minter.next, tabId, paneId, target.zone, makeTab)
  // A release that changes nothing is not a refusal: the frame lands where it
  // already was, and recording that would be one undo step for no movement.
  if (ops.length === 0) return ok(state)
  // Emptying a pane is the drop's *consequence*, not its intent, so the cleanup
  // rides along in the same history entry rather than becoming its own step.
  const settled = planSettle(applyOps(state.layout, ops).layout, state.minter.next, makeTab)
  return commit(state, [...ops, ...settled])
}

/**
 * Move a chip to another caret slot in the strip it already sits in.
 *
 * Crossing panes is a *drop*, not a placement: a drop carries the frame's host
 * with it and settles the pane it empties, which a slot index cannot express.
 * @param state - the state to change.
 * @param tabId - the tab being moved.
 * @param toPaneId - the strip it lands in; must be the one it is already in.
 * @param index - caret slot counted over the chips as drawn.
 * @returns the next state; a placement that changes nothing is accepted as-is.
 */
export function placeTab(
  state: FrameState,
  tabId: TabId,
  toPaneId: PaneId,
  index: number,
): FrameResult<FrameState> {
  const node = state.layout.nodes[toPaneId]
  if (node === undefined || node.kind !== 'pane' || node.host !== 'dock') {
    return fail('frames/unknown-target', `pane "${toPaneId}" is not a docked pane`)
  }
  if (!node.tabs.includes(tabId)) {
    return fail('frames/unknown-target', `tab "${tabId}" is not in pane "${toPaneId}"`)
  }
  const ops = planPlaceTab(state.layout, tabId, toPaneId, index)
  if (ops.length === 0) return ok(state)
  return commit(state, ops)
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
 * @param axis - which way a new half runs when one has to be made.
 * @returns the next state, or why the content could not be shown.
 */
export function openContent(
  state: FrameState,
  contentId: ContentId,
  axis: SplitAxis = 'row',
): FrameResult<FrameState> {
  const content = getContent(state.contents, contentId)
  if (content === undefined) {
    return fail('frames/unknown-content', `no content "${contentId}" is registered`)
  }

  const showing = Object.values(state.layout.nodes)
    .find((node): node is PaneNode => node.kind === 'pane'
      && node.tabs.some((tabId) => state.layout.tabs[tabId]?.contentId === contentId))
  if (showing !== undefined) return focusFrame(state, showing.id)

  // The new view names the content, not the type: a type is how to draw it, and
  // the content is which one — the distinction the whole registry exists for.
  const makeTab = (id: TabId): TabRecord => ({
    id,
    kind: content.kind,
    contentId: content.id,
    title: content.title,
  })
  return splitWith(state, state.layout.activePaneId, makeTab, axis)
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
