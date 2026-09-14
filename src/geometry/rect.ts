/**
 * Normalized rectangles.
 *
 * Every rectangle the core stores or hands a renderer is expressed as a
 * fraction of the drawable area, so the same numbers mean the same layout on a
 * pixel grid and on a character grid. A renderer multiplies by its own extent.
 */

/** A rectangle in fractions of the drawable area; `width` and `height` are above zero. */
export interface NormalizedRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The whole drawable area. */
export const FULL_RECT: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 }

/** Extent in a platform's own unit. */
export interface Extent {
  readonly width: number
  readonly height: number
}

/**
 * Cut `rect` into one rectangle per fraction.
 *
 * A split's sizes are fractions of the *parent*, so the result stays inside the
 * parent at every depth.
 * @param rect - the area to divide.
 * @param axis - `row` divides left to right, `column` top to bottom.
 * @param fractions - each above zero and summing to one.
 * @returns one rectangle per fraction, in order.
 */
export function splitRect(
  rect: NormalizedRect,
  axis: 'row' | 'column',
  fractions: readonly number[],
): readonly NormalizedRect[] {
  const out: NormalizedRect[] = []
  let offset = 0
  for (const fraction of fractions) {
    out.push(axis === 'row'
      ? { x: rect.x + rect.width * offset, y: rect.y, width: rect.width * fraction, height: rect.height }
      : { x: rect.x, y: rect.y + rect.height * offset, width: rect.width, height: rect.height * fraction })
    offset += fraction
  }
  return out
}

/**
 * The zero-thickness line a divider draws on, at the boundary after the child
 * at `index`.
 * @param rect - the parent's area.
 * @param axis - the split's axis.
 * @param fractions - the split's sizes.
 * @param index - the child whose trailing edge the divider sits on.
 */
export function dividerRect(
  rect: NormalizedRect,
  axis: 'row' | 'column',
  fractions: readonly number[],
  index: number,
): NormalizedRect {
  let offset = 0
  for (let i = 0; i <= index; i += 1) offset += fractions[i] ?? 0
  return axis === 'row'
    ? { x: rect.x + rect.width * offset, y: rect.y, width: 0, height: rect.height }
    : { x: rect.x, y: rect.y + rect.height * offset, width: rect.width, height: 0 }
}

/**
 * `rect` measured in a platform's own unit.
 * @param rect - a normalized rectangle.
 * @param extent - the drawable area in that unit.
 */
export function toExtent(rect: NormalizedRect, extent: Extent): Extent {
  return { width: rect.width * extent.width, height: rect.height * extent.height }
}

/** Smallest a floating frame may become, as a fraction of the drawable area. */
export const MIN_FLOAT_FRACTION = { width: 0.15, height: 0.15 } as const

/**
 * Force a rectangle inside the drawable area and above the floating size floor.
 *
 * The model keeps a *normalized* rectangle, so the engine's pixel minimum cannot
 * be used directly; this is the core's own floor. Position is clamped against the
 * clamped size, so the result is always fully inside the area.
 * @param rect - the rectangle a gesture reached.
 * @returns the rectangle the model may hold.
 */
export function clampFloatRect(rect: NormalizedRect): NormalizedRect {
  const width = Math.min(1, Math.max(MIN_FLOAT_FRACTION.width, rect.width))
  const height = Math.min(1, Math.max(MIN_FLOAT_FRACTION.height, rect.height))
  return {
    width,
    height,
    x: Math.min(Math.max(0, rect.x), 1 - width),
    y: Math.min(Math.max(0, rect.y), 1 - height),
  }
}
