/**
 * Frame types: what content a frame may hold, and the registry that holds the
 * declarations.
 *
 * A declaration names no role. A caller that wants a surface on the left asks
 * for a frame on the left with a size; the core never learns the word sidebar.
 */
import type { PaneHost } from '../vendor/ui-dockkit/contract/types.ts'

/** Bounds a frame type puts on the operations the core accepts. */
export interface FrameTypePolicy {
  /** Whether the user may close it. Defaults to true. */
  readonly closable?: boolean
  /** Whether it may be the reference pane of a split. Defaults to true. */
  readonly splittable?: boolean
  /** Whether new content may take its place. Defaults to false. */
  readonly preemptible?: boolean
  /** Instances allowed at once. */
  readonly maxInstances?: number
}

/**
 * One kind of displayable content, declared without reference to a platform.
 *
 * The React body of a type is a second, platform-specific registration into the
 * `frames.body` keyed slot; both registrations share `id`.
 */
export interface FrameTypeDefinition {
  /** Stable identity, shared with the keyed slot that supplies the body. */
  readonly id: string
  /** Localized display name. */
  readonly title: () => string
  /** At most one instance, when true. */
  readonly singleton?: boolean
  /** Hosts the type may occupy; both when omitted. */
  readonly hosts?: readonly PaneHost[]
  /** Operation limits. */
  readonly policy?: FrameTypePolicy
}

/** Why a registration or a lookup failed. */
export type FrameTypeErrorCode = 'frames/duplicate-type' | 'frames/unknown-type'

/** A registration conflict or a lookup for a type that was never registered. */
export class FrameTypeError extends Error {
  readonly code: FrameTypeErrorCode

  constructor(code: FrameTypeErrorCode, message: string) {
    super(message)
    this.name = 'FrameTypeError'
    this.code = code
  }
}

/** The frame types currently registered, keyed by id. */
export interface FrameTypeRegistry {
  readonly byId: ReadonlyMap<string, FrameTypeDefinition>
}

/** A registry with nothing registered. */
export const EMPTY_REGISTRY: FrameTypeRegistry = { byId: new Map() }

/** Whether `id` names a registered type. */
export function hasType(registry: FrameTypeRegistry, id: string): boolean {
  return registry.byId.has(id)
}

/** The declaration for `id`, or `undefined`. */
export function getType(registry: FrameTypeRegistry, id: string): FrameTypeDefinition | undefined {
  return registry.byId.get(id)
}

/** Registered ids in registration order. */
export function typeIds(registry: FrameTypeRegistry): readonly string[] {
  return [...registry.byId.keys()]
}

/**
 * A registry with `definition` added.
 * @param registry - registry to extend; it is not modified.
 * @param definition - the declaration to add.
 * @returns a new registry.
 * @throws FrameTypeError when the id is already registered.
 */
export function registerType(
  registry: FrameTypeRegistry,
  definition: FrameTypeDefinition,
): FrameTypeRegistry {
  if (registry.byId.has(definition.id)) {
    throw new FrameTypeError(
      'frames/duplicate-type',
      `frames.registerType: type "${definition.id}" is already registered`,
    )
  }
  const byId = new Map(registry.byId)
  byId.set(definition.id, definition)
  return { byId }
}

/**
 * The declaration for `id`.
 * @throws FrameTypeError when the id is not registered.
 */
export function requireType(registry: FrameTypeRegistry, id: string): FrameTypeDefinition {
  const definition = registry.byId.get(id)
  if (definition === undefined) {
    throw new FrameTypeError('frames/unknown-type', `frames: type "${id}" is not registered`)
  }
  return definition
}
