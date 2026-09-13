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
export { createFrameState, withLayout, withMeasurements, withPlatform } from './model/state.ts'

export type { Extent, NormalizedRect } from './geometry/rect.ts'
export { dividerRect, FULL_RECT, splitRect, toExtent } from './geometry/rect.ts'

export type {
  Degradation, FrameViewProjection, ProjectedDivider, ProjectedPane, ProjectedTab, SplitBlock,
} from './project/project.ts'
export { project } from './project/project.ts'
