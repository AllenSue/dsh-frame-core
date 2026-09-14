/**
 * One traversal of the docked tree that hands every pane its area.
 *
 * `project` and directional focus both need the same geometry, so the walk lives
 * here once.
 */
import type { LayoutState, PaneId, SplitId } from '../vendor/ui-dockkit/contract/types.ts'
import { dividerRect, FULL_RECT, splitRect, type NormalizedRect } from './rect.ts'

/** A pane and the area it occupies. */
export interface PlacedPane {
  readonly id: PaneId
  readonly rect: NormalizedRect
}

/** A divider between two siblings of a split. */
export interface PlacedDivider {
  readonly splitId: SplitId
  readonly axis: 'row' | 'column'
  /** Boundary position along the parent's axis, as a fraction of the parent. */
  readonly at: number
  readonly rect: NormalizedRect
}

/**
 * Visit every docked pane in draw order.
 * @param layout - the layout to walk.
 * @param visit - called once per pane, in depth-first order.
 * @returns the dividers, which the caller positions rather than visits.
 */
export function layoutRects(
  layout: LayoutState,
  visit: (id: PaneId, rect: NormalizedRect) => void,
): readonly PlacedDivider[] {
  const dividers: PlacedDivider[] = []
  const walk = (nodeId: string, rect: NormalizedRect): void => {
    const node = layout.nodes[nodeId as PaneId]
    if (node === undefined) return
    if (node.kind === 'pane') {
      visit(node.id, rect)
      return
    }
    const rects = splitRect(rect, node.axis, node.sizes)
    node.children.forEach((childId, index) => {
      if (index > 0) {
        let at = 0
        for (let i = 0; i < index; i += 1) at += node.sizes[i] ?? 0
        dividers.push({
          splitId: node.id,
          axis: node.axis,
          at,
          rect: dividerRect(rect, node.axis, node.sizes, index - 1),
        })
      }
      walk(childId, rects[index] ?? rect)
    })
  }
  walk(layout.rootId, FULL_RECT)
  return dividers
}

/** Every docked pane with its area, in draw order. */
export function placedPanes(layout: LayoutState): readonly PlacedPane[] {
  const panes: PlacedPane[] = []
  layoutRects(layout, (id, rect) => { panes.push({ id, rect }) })
  return panes
}
