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
  | 'frames/unknown-content'
  | 'frames/kind-mismatch'
  | 'frames/instance-limit'
  | 'frames/not-measured'
  | 'frames/nothing-to-undo'
  | 'frames/nothing-to-redo'
  /**
   * Asked for a tab-level move in a shell that has no tab level.
   *
   * A frame shows one content; whether a content has tabs inside it is its own
   * plugin's business. So there is no strip to reorder and nothing to drop among
   * a pane's tabs — the operations that used to mean those are refused rather
   * than quietly doing something else.
   */
  | 'frames/one-content-per-frame'

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
