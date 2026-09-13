/**
 * What a rendering target can do.
 *
 * The core applies a capability limit in the projection only. The model keeps
 * the facts a target cannot draw, so one saved preset loads on every target and
 * projects differently on each.
 */

/** How a target presents a floating frame. */
export type FloatPresentation = 'window' | 'overlay' | 'none'

/** What one rendering target supports. */
export interface FrameCapabilities {
  /** How floating frames appear. `none` makes a float request fail. */
  readonly floats: FloatPresentation
  /** Whether a floating frame keeps an arbitrary rectangle. */
  readonly freeRect: boolean
  /** Whether the user arranges frames with a pointer. */
  readonly drag: boolean
  /** Docked panes allowed at once. */
  readonly maxDockPanes: number
  /** Smallest a pane may be drawn, in this target's own unit. */
  readonly minPaneSize: number
  /** Whether a frame moves between hosts by gesture. */
  readonly detachable: boolean
  /** Chords this target cannot bind; the core skips their default binding. */
  readonly reservedChords?: readonly string[]
}

/** A rendering target and what it supports. */
export interface FramePlatform {
  readonly id: string
  readonly capabilities: FrameCapabilities
}

/** Browser and desktop: one renderer, pixels, pointer drag, real floating panels. */
export const REACT_CAPABILITIES: FrameCapabilities = {
  floats: 'window',
  freeRect: true,
  drag: true,
  maxDockPanes: 4,
  minPaneSize: 72,
  detachable: true,
}

/** Terminal: cells, no pointer, floating frames degrade to a switchable overlay. */
export const TUI_CAPABILITIES: FrameCapabilities = {
  floats: 'overlay',
  freeRect: false,
  drag: false,
  maxDockPanes: 4,
  minPaneSize: 8,
  detachable: false,
}
