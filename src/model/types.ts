/**
 * Frame types: what content a frame may hold, and the registry that holds the
 * declarations.
 *
 * A declaration names no role. A caller that wants a surface on the left asks
 * for a frame on the left with a size; the core never learns the word sidebar.
 */
import type { PaneHost } from '../vendor/ui-dockkit/contract/types.ts'
import type { FrameContent } from './content.ts'

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
  /**
   * Whether this content absorbs space a departing sibling frees. Defaults to true.
   *
   * A navigation column sets this false. When the frame beside it closes, the
   * space it leaves has to go somewhere, and without a preference every survivor
   * takes a proportional share of it — so a fixed rail quietly grows while the
   * column that should have taken the room gets only part of it.
   */
  readonly grows?: boolean
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
  /**
   * Make one new instance of this type, or omit to declare it uninstantiable.
   *
   * A picker lists the types that answer this, so its absence is the whole
   * "cannot be created" declaration — one place to look rather than a flag that
   * could disagree with a factory.
   *
   * The factory names what it makes. The core mints ids for panes, splits and
   * tabs, but a content's identity is the owner's: an editor instance is a
   * *file*, and a core-made `content7` would split that knowledge in half.
   */
  readonly create?: () => FrameContent
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
