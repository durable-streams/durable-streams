/**
 * @durable-streams/tanstack-db-sync
 *
 * Sync TanStack DB collection changes to Durable Streams.
 *
 * This package provides utilities to subscribe to changes on TanStack DB
 * collections and append them to a Durable Stream in the State Protocol format.
 *
 * @example
 * ```typescript
 * import { syncCollectionToStream } from '@durable-streams/tanstack-db-sync'
 * import { createCollection } from '@tanstack/db'
 * import { DurableStream } from '@durable-streams/client'
 *
 * // Create your TanStack DB collection
 * const usersCollection = createCollection({
 *   id: 'users',
 *   getKey: (user) => user.id,
 *   // ... other options
 * })
 *
 * // Create your durable stream
 * const stream = new DurableStream({
 *   url: 'https://api.example.com/streams/users',
 *   contentType: 'application/json',
 * })
 *
 * // Start syncing changes to the stream
 * const subscription = syncCollectionToStream({
 *   collection: usersCollection,
 *   stream,
 *   entityType: 'user',
 *   primaryKeyField: 'id',
 * })
 *
 * // When done, unsubscribe
 * subscription.unsubscribe()
 * ```
 *
 * @packageDocumentation
 */

export {
  syncCollectionToStream,
  syncCollectionsToStream,
  changesToStateEvents,
  changeToStateEvent,
} from "./sync"

export type {
  SyncCollectionOptions,
  SyncCollectionsOptions,
  CollectionSyncDefinition,
  SyncSubscription,
} from "./sync"

// Re-export useful types from dependencies for convenience
export type { ChangeEvent, Operation } from "@durable-streams/state"
export type { ChangeMessage } from "@tanstack/db/types"
