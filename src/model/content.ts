/**
 * Contents: what a frame can display, as opposed to the frame displaying it.
 *
 * A frame is a place; a content is a thing. They are separate because a content
 * outlives every frame that ever showed it — close the last window onto it and
 * it is still there, ready to be shown again in any frame.
 *
 * The core holds only identity: an id, the kind that says how to draw it, and a
 * title. Everything else about a content belongs to whoever owns it, which is
 * the only arrangement that works when the content is a plugin's own state.
 *
 * Ids are plain strings chosen by the owner, not minted here: a content usually
 * *is* something the owner already names — a session, a file, a column — and
 * giving it a second core-made name would only mean keeping the two in step.
 */
/**
 * Identity of one content.
 *
 * A plain string, not a branded mint: the owner names its own contents — a
 * session, a file, a column — and a second core-made name would only be one more
 * thing to keep in step with the first.
 */
export type ContentId = string

/** One content the shell knows about. */
export interface FrameContent {
  /** Identity, chosen by the owner and unique among contents. */
  readonly id: ContentId
  /** The frame type that draws it; an unregistered kind draws a titled frame. */
  readonly kind: string
  readonly title: string
}

/** Every content the shell is holding, by id. */
export type ContentRegistry = ReadonlyMap<ContentId, FrameContent>

/** A registry holding nothing. */
export const EMPTY_CONTENTS: ContentRegistry = new Map()

/**
 * Add or replace one content.
 * @param registry - the registry to extend; it is not modified.
 * @param content - the content to hold.
 * @returns the registry with that content present.
 */
export function registerContent(registry: ContentRegistry, content: FrameContent): ContentRegistry {
  const next = new Map(registry)
  next.set(content.id, content)
  return next
}

/**
 * Destroy one content outright.
 *
 * Deliberately not the same thing as closing the frame that shows it: this is
 * the only way a content stops existing, and every view of it is left pointing
 * at something gone — so a caller destroys contents whose views it has already
 * closed.
 * @param registry - the registry to shrink; it is not modified.
 * @param id - the content to drop.
 * @returns the registry without that content.
 */
export function forgetContent(registry: ContentRegistry, id: ContentId): ContentRegistry {
  if (!registry.has(id)) return registry
  const next = new Map(registry)
  next.delete(id)
  return next
}

/** One content, or `undefined` when the shell is not holding it. */
export function getContent(registry: ContentRegistry, id: ContentId): FrameContent | undefined {
  return registry.get(id)
}

/**
 * Every content, in a stable order.
 *
 * Sorted by id so a list a person reads does not reshuffle when an unrelated
 * content is registered.
 * @param registry - the registry to read.
 * @returns the contents, ordered by id.
 */
export function contentList(registry: ContentRegistry): readonly FrameContent[] {
  return [...registry.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}
