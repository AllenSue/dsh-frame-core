/**
 * The operations the core accepts.
 *
 * Every one of them is planned, governed, and recorded: a pure planner turns the
 * intent into engine operations, the policy of the affected frame type may refuse
 * it, and an accepted intent becomes exactly one history entry. A refusal returns
 * a result and leaves the state untouched.
 */
import { planSplitPane } from '../vendor/ui-dockkit/engine/planner.ts'
import type { LayoutOp, PaneId, TabId, TabRecord } from '../vendor/ui-dockkit/contract/types.ts'
import type { NormalizedRect } from '../geometry/rect.ts'
import { placedPanes } from '../geometry/rects.ts'
import type { FrameState } from '../model/state.ts'
import { withLayout } from '../model/state.ts'
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
  return ok({ ...next, history: pushIntent(state.history, entry) })
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
 * Split a pane to its right.
 * @param state - the state to change.
 * @param paneId - the reference pane; defaults to the focused one.
 * @param seed - frame type the new pane starts with; omit for an empty pane.
 * @returns the next state, or why the split was refused.
 */
export function splitFrame(state: FrameState, paneId?: PaneId, seed?: string): FrameResult<FrameState> {
  if (!hasGeometry(state)) {
    return fail('frames/not-measured', 'no renderer has reported its drawable extent yet')
  }
  const target = paneId ?? state.layout.activePaneId
  const panes = placedPanes(state.layout)
  const placed = panes.find((pane) => pane.id === target)
  if (placed === undefined) return fail('frames/unknown-target', `pane "${target}" is not drawn`)

  const seeded = seed === undefined ? undefined : getType(state.types, seed)
  if (seed !== undefined && seeded === undefined) {
    return fail('frames/unknown-type', `type "${seed}" is not registered`)
  }
  if (activePolicy(state, target).splittable === false) {
    return fail('frames/policy-refused', `the content of pane "${target}" refuses to be split`)
  }
  const budget = state.platform?.capabilities.maxDockPanes
  if (budget !== undefined && panes.length >= budget) {
    return fail('frames/pane-budget-exhausted', `the docked area allows ${budget} pane(s)`)
  }
  if (!roomForTwo(placed.rect, state)) {
    return fail('frames/too-narrow', `pane "${target}" has no room for two halves`)
  }
  const makeTab = seeded === undefined ? undefined : (id: TabId): TabRecord => ({
    id,
    kind: seeded.id,
    contentId: seeded.id,
    title: seeded.title(),
  })
  // The engine keeps its own pane cap, so this budget can only tighten it.
  return commit(state, planSplitPane(state.layout, state.minter.next, target, makeTab))
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
