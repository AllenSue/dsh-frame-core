/**
 * The frame manager core: a window layout that is a tree of plain data, where
 * every runtime change is an invertible operation and every renderer draws the
 * same projection.
 *
 * Nothing here knows about React, the DOM, `ui-layout`, or any particular kind
 * of content. A renderer declares what it can do; the core degrades for it in
 * the projection alone.
 *
 * @module
 */
export type { FloatPresentation, FrameCapabilities, FramePlatform } from './model/platform.ts'
export { REACT_CAPABILITIES, TUI_CAPABILITIES } from './model/platform.ts'

export type { FrameTypeDefinition, FrameTypeErrorCode, FrameTypePolicy, FrameTypeRegistry } from './model/types.ts'
export {
  EMPTY_REGISTRY, FrameTypeError, getType, hasType, registerType, requireType, typeIds,
} from './model/types.ts'

export type { FrameMeasurements, FrameState, FrameStateOptions } from './model/state.ts'
export {
  createFrameState, withContents, withLayout, withMeasurements, withPlatform,
} from './model/state.ts'

export type { ContentId, ContentRegistry, FrameContent } from './model/content.ts'
export {
  contentList, EMPTY_CONTENTS, forgetContent, getContent, registerContent,
} from './model/content.ts'

export type { Extent, NormalizedRect } from './geometry/rect.ts'
export {
  clampFloatRect, dividerRect, FULL_RECT, MIN_FLOAT_FRACTION, splitRect, toExtent,
} from './geometry/rect.ts'

export type { PlacedDivider, PlacedPane } from './geometry/rects.ts'
export { layoutRects, placedPanes } from './geometry/rects.ts'

// The dock regions a pointer can release in, and the two limits a drag answers
// to. A renderer needs them to turn pointer coordinates into an intent; they are
// re-exported rather than reached for, so the renderer imports one module only.
export { clampSizes, DOCK_EDGE_FRACTION, DOCK_ZONES, MIN_PANE_FRACTION, zoneAt } from './vendor/ui-dockkit/engine/constraints.ts'
export type {
  DockZone, NodeId, PaneId, SplitId, TabId,
} from './vendor/ui-dockkit/contract/types.ts'

export type { FrameErrorCode, FrameResult } from './ops/result.ts'
export { fail, ok } from './ops/result.ts'

export type { FrameHistory, HistoryEntry } from './ops/history.ts'
export { applyOps, canRedo, canUndo, EMPTY_HISTORY, pushIntent } from './ops/history.ts'

export type { DropTarget, FocusDirection, OpenOptions, Placement } from './ops/intents.ts'
export {
  closeFrame, dockFrame, dropFrame, floatFrame, focusFrame, forgetFrame, moveFocus, neighbour,
  openContent, placeFloat, placeTab, placementSplit, redo, registerFrame, resizeSplit, splitFrame,
  undo,
} from './ops/intents.ts'

export type {
  Degradation, FrameBodyProps, FrameViewProjection, ProjectedDivider, ProjectedFloat,
  ProjectedPane, ProjectedTab, SplitBlock,
} from './project/project.ts'
// The projection's own name for how a float is presented; the capability type
// above shares the word, so it is re-exported under a distinct one.
export type { FloatPresentation as ProjectedFloatPresentation } from './project/project.ts'
export { project } from './project/project.ts'

export type { FramesHost, FramesService, FramesServiceOptions } from './service/service.ts'
export { createFramesService, provideFramesService } from './service/service.ts'

export type { Preset, PresetPort } from './preset/preset.ts'
export {
  canonicalLayout, mintedThrough, parsePreset, PRESET_FORMAT_VERSION, toPreset, withPreset,
} from './preset/preset.ts'
