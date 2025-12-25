import type { Collection } from "@tanstack/db"
import type { ChangeMessage } from "@tanstack/db/types"
import type { DurableStream } from "@durable-streams/client"
import type { ChangeEvent, Operation } from "@durable-streams/state"

/**
 * Options for syncing a single collection to a stream
 */
export interface SyncCollectionOptions<
  T extends object,
  TKey extends string | number,
> {
  /**
   * The TanStack DB collection to subscribe to
   */
  collection: Collection<T, TKey>

  /**
   * The durable stream to append changes to
   */
  stream: DurableStream

  /**
   * The entity type discriminator for the State Protocol.
   * This is used as the `type` field in change events.
   * @example "user", "message", "order"
   */
  entityType: string

  /**
   * Whether to include the current collection state as initial insert events.
   * When true, all existing items in the collection are appended as inserts
   * before subscribing to future changes.
   * @default false
   */
  includeInitialState?: boolean

  /**
   * Optional function to transform headers for each change event.
   * Useful for adding txid, timestamp, or other metadata.
   */
  transformHeaders?: (
    change: ChangeMessage<T, TKey>
  ) => Omit<Record<string, string>, `operation`>

  /**
   * Optional function to transform the value before appending.
   * The key field will be automatically excluded from the value.
   */
  transformValue?: (value: T) => unknown

  /**
   * The primary key field name in the value object.
   * If provided, this field will be excluded from the value
   * to avoid duplication since it's already in the `key` field.
   */
  primaryKeyField?: keyof T & string
}

/**
 * Return type for sync subscriptions
 */
export interface SyncSubscription {
  /**
   * Unsubscribe from the collection and stop syncing
   */
  unsubscribe: () => void
}

/**
 * Convert a TanStack DB ChangeMessage to a Durable Streams State Protocol ChangeEvent
 */
function toChangeEvent<T extends object, TKey extends string | number>(
  change: ChangeMessage<T, TKey>,
  entityType: string,
  options: {
    transformHeaders?: (
      change: ChangeMessage<T, TKey>
    ) => Omit<Record<string, string>, `operation`>
    transformValue?: (value: T) => unknown
    primaryKeyField?: keyof T & string
  }
): ChangeEvent<unknown> {
  const { transformHeaders, transformValue, primaryKeyField } = options

  // Get base headers from transform function or empty object
  const extraHeaders = transformHeaders ? transformHeaders(change) : {}

  // Merge metadata into headers if present
  const metadataHeaders: Record<string, string> = {}
  if (change.metadata) {
    for (const [key, value] of Object.entries(change.metadata)) {
      if (typeof value === `string`) {
        metadataHeaders[key] = value
      } else if (value != null) {
        metadataHeaders[key] = String(value)
      }
    }
  }

  // Prepare value - optionally transform and exclude primary key field
  let value: unknown = change.value
  if (value !== undefined) {
    if (transformValue) {
      value = transformValue(change.value)
    } else if (primaryKeyField && typeof change.value === `object`) {
      // Create a shallow copy without the primary key field
      const { [primaryKeyField]: _omitted, ...rest } = change.value as Record<
        string,
        unknown
      >
      value = rest
    }
  }

  // Prepare old_value - same transformation
  let oldValue: unknown = change.previousValue
  if (oldValue !== undefined) {
    if (transformValue) {
      oldValue = transformValue(change.previousValue as T)
    } else if (primaryKeyField && typeof change.previousValue === `object`) {
      const { [primaryKeyField]: _omitted, ...rest } =
        change.previousValue as Record<string, unknown>
      oldValue = rest
    }
  }

  const event: ChangeEvent<unknown> = {
    type: entityType,
    key: String(change.key),
    headers: {
      ...metadataHeaders,
      ...extraHeaders,
      operation: change.type as Operation,
    },
  }

  // Handle value and old_value based on operation type
  if (change.type === `insert`) {
    // Insert: only value
    if (value !== undefined) {
      event.value = value
    }
  } else if (change.type === `update`) {
    // Update: value and optionally old_value
    if (value !== undefined) {
      event.value = value
    }
    if (oldValue !== undefined) {
      event.old_value = oldValue
    }
  } else if (change.type === `delete`) {
    // Delete: for TanStack DB, change.value contains the deleted item
    // In State Protocol, this goes to old_value (the previous state)
    if (value !== undefined) {
      event.old_value = value
    }
  }

  return event
}

/**
 * Sync a TanStack DB collection to a Durable Stream.
 *
 * This function subscribes to changes on a TanStack DB collection and
 * appends them to a durable stream in the State Protocol format.
 *
 * @example
 * ```typescript
 * import { syncCollectionToStream } from '@durable-streams/tanstack-db-sync'
 *
 * const subscription = syncCollectionToStream({
 *   collection: usersCollection,
 *   stream: durableStream,
 *   entityType: 'user',
 *   primaryKeyField: 'id',
 * })
 *
 * // Later, to stop syncing:
 * subscription.unsubscribe()
 * ```
 */
export function syncCollectionToStream<
  T extends object,
  TKey extends string | number,
>(options: SyncCollectionOptions<T, TKey>): SyncSubscription {
  const {
    collection,
    stream,
    entityType,
    includeInitialState = false,
    transformHeaders,
    transformValue,
    primaryKeyField,
  } = options

  const transformOpts = { transformHeaders, transformValue, primaryKeyField }

  // Subscribe to changes and append to stream
  const subscription = collection.subscribeChanges(
    async (changes) => {
      for (const change of changes) {
        const event = toChangeEvent(change, entityType, transformOpts)
        await stream.append(event)
      }
    },
    { includeInitialState }
  )

  return {
    unsubscribe: () => {
      subscription.unsubscribe()
    },
  }
}

/**
 * Definition for a collection to sync
 */
export interface CollectionSyncDefinition<
  T extends object = object,
  TKey extends string | number = string | number,
> {
  /**
   * The TanStack DB collection
   */
  collection: Collection<T, TKey>

  /**
   * The entity type discriminator for the State Protocol
   */
  entityType: string

  /**
   * Optional primary key field to exclude from values
   */
  primaryKeyField?: keyof T & string

  /**
   * Optional value transformer
   */
  transformValue?: (value: T) => unknown

  /**
   * Optional headers transformer
   */
  transformHeaders?: (
    change: ChangeMessage<T, TKey>
  ) => Omit<Record<string, string>, `operation`>
}

/**
 * Options for syncing multiple collections to a stream
 */
export interface SyncCollectionsOptions {
  /**
   * Map of collection names to their sync definitions
   */
  collections: Record<string, CollectionSyncDefinition>

  /**
   * The durable stream to append changes to
   */
  stream: DurableStream

  /**
   * Whether to include current state as initial insert events
   * @default false
   */
  includeInitialState?: boolean
}

/**
 * Sync multiple TanStack DB collections to a single Durable Stream.
 *
 * Changes from all collections are appended to the same stream,
 * with the `type` field discriminating between entity types.
 *
 * @example
 * ```typescript
 * import { syncCollectionsToStream } from '@durable-streams/tanstack-db-sync'
 *
 * const subscription = syncCollectionsToStream({
 *   collections: {
 *     users: {
 *       collection: usersCollection,
 *       entityType: 'user',
 *       primaryKeyField: 'id',
 *     },
 *     messages: {
 *       collection: messagesCollection,
 *       entityType: 'message',
 *       primaryKeyField: 'id',
 *     },
 *   },
 *   stream: durableStream,
 *   includeInitialState: true,
 * })
 *
 * // Later, to stop syncing:
 * subscription.unsubscribe()
 * ```
 */
export function syncCollectionsToStream(
  options: SyncCollectionsOptions
): SyncSubscription {
  const { collections, stream, includeInitialState = false } = options

  const subscriptions: Array<SyncSubscription> = []

  for (const [_name, def] of Object.entries(collections)) {
    const subscription = syncCollectionToStream({
      collection: def.collection,
      stream,
      entityType: def.entityType,
      primaryKeyField: def.primaryKeyField,
      transformValue: def.transformValue,
      transformHeaders: def.transformHeaders,
      includeInitialState,
    })
    subscriptions.push(subscription)
  }

  return {
    unsubscribe: () => {
      for (const sub of subscriptions) {
        sub.unsubscribe()
      }
    },
  }
}

/**
 * Convert an array of TanStack DB changes to State Protocol events.
 *
 * This is a utility function for manual conversion without automatic streaming.
 *
 * @example
 * ```typescript
 * const events = changesToStateEvents(changes, 'user', { primaryKeyField: 'id' })
 * for (const event of events) {
 *   await stream.append(event)
 * }
 * ```
 */
export function changesToStateEvents<
  T extends object,
  TKey extends string | number,
>(
  changes: Array<ChangeMessage<T, TKey>>,
  entityType: string,
  options: {
    transformHeaders?: (
      change: ChangeMessage<T, TKey>
    ) => Omit<Record<string, string>, `operation`>
    transformValue?: (value: T) => unknown
    primaryKeyField?: keyof T & string
  } = {}
): Array<ChangeEvent<unknown>> {
  return changes.map((change) => toChangeEvent(change, entityType, options))
}

/**
 * Convert a single TanStack DB change to a State Protocol event.
 *
 * @example
 * ```typescript
 * const event = changeToStateEvent(change, 'user', { primaryKeyField: 'id' })
 * await stream.append(event)
 * ```
 */
export function changeToStateEvent<
  T extends object,
  TKey extends string | number,
>(
  change: ChangeMessage<T, TKey>,
  entityType: string,
  options: {
    transformHeaders?: (
      change: ChangeMessage<T, TKey>
    ) => Omit<Record<string, string>, `operation`>
    transformValue?: (value: T) => unknown
    primaryKeyField?: keyof T & string
  } = {}
): ChangeEvent<unknown> {
  return toChangeEvent(change, entityType, options)
}
