/**
 * What an operation reports. An operation never throws across this boundary: a
 * refusal is an outcome a caller can act on, and it never changes state.
 */

/** Why an operation was refused. */
export type FrameErrorCode =
  | 'frames/unknown-type'
  | 'frames/unknown-target'
  | 'frames/unsupported-on-platform'
  | 'frames/pane-budget-exhausted'
  | 'frames/too-narrow'
  | 'frames/policy-refused'
  | 'frames/unknown-preset'
  | 'frames/not-measured'
  | 'frames/nothing-to-undo'
  | 'frames/nothing-to-redo'

/** The outcome of one operation. */
export type FrameResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: FrameErrorCode; readonly message: string }

/** A successful outcome. */
export function ok<T>(value: T): FrameResult<T> {
  return { ok: true, value }
}

/** A refusal that changed nothing. */
export function fail<T>(code: FrameErrorCode, message: string): FrameResult<T> {
  return { ok: false, code, message }
}
