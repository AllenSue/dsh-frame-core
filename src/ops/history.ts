/**
 * Intent-level history.
 *
 * One entry per intent, never per operation: the operations one intent produced
 * undo and redo together, so a split that needed three operations steps back in
 * one move. An entry carries both directions because the inverse of the inverse
 * is the way forward again.
 */
import { applyOp } from '../vendor/ui-dockkit/engine/operations.ts'
import type { LayoutOp, LayoutState } from '../vendor/ui-dockkit/contract/types.ts'

/** One intent, in both directions. */
export interface HistoryEntry {
  readonly forward: readonly LayoutOp[]
  /** The operations that undo `forward`, in the order they must be applied. */
  readonly inverse: readonly LayoutOp[]
}

/** Everything the session can step through. */
export interface FrameHistory {
  /** Oldest first; the last entry is the next undo. */
  readonly past: readonly HistoryEntry[]
  /** The next redo, oldest first. */
  readonly future: readonly HistoryEntry[]
}

/** A history with nothing recorded. */
export const EMPTY_HISTORY: FrameHistory = { past: [], future: [] }

/** The result of applying a run of operations. */
export interface AppliedOps {
  readonly layout: LayoutState
  /** The operations that undo the whole run, in application order. */
  readonly inverse: readonly LayoutOp[]
}

/**
 * Apply operations in order, collecting the inverse of the whole run.
 * @param layout - the layout to change.
 * @param ops - the operations, in order.
 * @returns the next layout and the operations that undo it.
 */
export function applyOps(layout: LayoutState, ops: readonly LayoutOp[]): AppliedOps {
  let next = layout
  const inverse: LayoutOp[] = []
  for (const op of ops) {
    const applied = applyOp(next, op)
    next = applied.state
    // An operation's own inverse must itself be undone last-first.
    inverse.unshift(...applied.inverse)
  }
  return { layout: next, inverse }
}

/**
 * Record one intent.
 * @param history - history to extend; it is not modified.
 * @param entry - the intent's operations in both directions.
 * @returns a history whose redo branch is dropped, as any new intent does.
 */
export function pushIntent(history: FrameHistory, entry: HistoryEntry): FrameHistory {
  return { past: [...history.past, entry], future: [] }
}

/** Whether an intent is available to undo. */
export function canUndo(history: FrameHistory): boolean {
  return history.past.length > 0
}

/** Whether an undone intent is available to redo. */
export function canRedo(history: FrameHistory): boolean {
  return history.future.length > 0
}
