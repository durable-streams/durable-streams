import { createCollection } from "@tanstack/db"
import { isChangeEvent, isControlEvent } from "./types"
import type { Collection, SyncConfig } from "@tanstack/db"
import type { ChangeEvent, StateEvent } from "./types"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { DurableStream, StreamResponse } from "@durable-streams/client"

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Definition for a single collection in the stream state
 */
export interface CollectionDefinition<T = unknown> {
  /** Standard Schema for validating values */
  schema: StandardSchemaV1<T>
  /** The type field value in change events that map to this collection */
  type: string
}

/**
 * Helper methods for creating change events for a collection
 */
export interface CollectionEventHelpers<T> {
  /**
   * Create an insert change event
   */
  insert: (params: {
    key: string
    value: T
    headers?: Omit<Record<string, string>, `operation`>
  }) => ChangeEvent<T>
  /**
   * Create an update change event
   */
  update: (params: {
    key: string
    value: T
    oldValue?: T
    headers?: Omit<Record<string, string>, `operation`>
  }) => ChangeEvent<T>
  /**
   * Create a delete change event
   */
  delete: (params: {
    key: string
    oldValue?: T
    headers?: Omit<Record<string, string>, `operation`>
  }) => ChangeEvent<T>
}

/**
 * Collection definition enhanced with event creation helpers
 */
export type CollectionWithHelpers<T = unknown> = CollectionDefinition<T> &
  CollectionEventHelpers<T>

/**
 * Stream state definition containing all collections
 */
export interface StreamStateDefinition {
  collections: Record<string, CollectionDefinition>
}

/**
 * Stream state schema with helper methods for creating change events
 */
export type StateSchema<T extends Record<string, CollectionDefinition>> = {
  collections: {
    [K in keyof T]: CollectionWithHelpers<
      T[K] extends CollectionDefinition<infer U> ? U : unknown
    >
  }
}

/**
 * Options for creating a stream DB
 */
export interface CreateStreamDBOptions<
  TDef extends StreamStateDefinition = StreamStateDefinition,
> {
  /** The durable stream to subscribe to */
  stream: DurableStream
  /** The stream state definition */
  state: TDef
}

/**
 * Extract the value type from a CollectionDefinition
 */
type ExtractCollectionType<T extends CollectionDefinition> =
  T extends CollectionDefinition<infer U> ? U : unknown

/**
 * Map collection definitions to TanStack DB Collection types
 */
type CollectionMap<TDef extends StreamStateDefinition> = {
  [K in keyof TDef[`collections`]]: Collection<
    ExtractCollectionType<TDef[`collections`][K]> & object,
    string
  >
}

/**
 * The StreamDB interface - provides typed access to collections
 */
export type StreamDB<TDef extends StreamStateDefinition> = CollectionMap<TDef> &
  StreamDBMethods

/**
 * Methods available on a StreamDB instance
 */
export interface StreamDBMethods {
  /**
   * Preload all collections by consuming the stream until up-to-date
   */
  preload: () => Promise<void>

  /**
   * Close the stream connection and cleanup
   */
  close: () => void
}

// ============================================================================
// Key Storage
// ============================================================================

/**
 * Symbol used to store the key on value objects.
 * Symbols don't appear in Object.keys() or JSON.stringify(),
 * keeping the returned values clean.
 */
const KEY_SYMBOL = Symbol.for(`durable-streams:key`)

/**
 * Value object with embedded key via Symbol
 */
interface ValueWithKey {
  [KEY_SYMBOL]?: string
}

/**
 * Store a key on a value object using Symbol
 */
function setValueKey(value: object, key: string): void {
  ;(value as ValueWithKey)[KEY_SYMBOL] = key
}

/**
 * Get the key from a value object
 */
function getValueKey(value: object): string {
  const key = (value as ValueWithKey)[KEY_SYMBOL]
  if (key === undefined) {
    throw new Error(`No key found for value - this should not happen`)
  }
  return key
}

// ============================================================================
// Internal Event Dispatcher
// ============================================================================

/**
 * Handler for collection sync events
 */
interface CollectionSyncHandler {
  begin: () => void
  write: (value: object, type: `insert` | `update` | `delete`) => void
  commit: () => void
  markReady: () => void
  truncate: () => void
}

/**
 * Internal event dispatcher that routes stream events to collection handlers
 */
class EventDispatcher {
  /** Map from event type to collection handler */
  private handlers = new Map<string, CollectionSyncHandler>()

  /** Handlers that have pending writes (need commit) */
  private pendingHandlers = new Set<CollectionSyncHandler>()

  /** Whether we've received the initial up-to-date signal */
  private isUpToDate = false

  /** Resolvers and rejecters for preload promises */
  private preloadResolvers: Array<() => void> = []
  private preloadRejecters: Array<(error: Error) => void> = []

  /**
   * Register a handler for a specific event type
   */
  registerHandler(eventType: string, handler: CollectionSyncHandler): void {
    this.handlers.set(eventType, handler)
  }

  /**
   * Dispatch a change event to the appropriate collection.
   * Writes are buffered until commit() is called via markUpToDate().
   */
  dispatchChange(event: StateEvent): void {
    if (!isChangeEvent(event)) return

    const handler = this.handlers.get(event.type)
    if (!handler) {
      // Unknown event type - ignore silently
      return
    }

    const operation = event.headers.operation

    // Validate that values are objects (required for KEY_SYMBOL storage)
    if (operation !== `delete`) {
      if (typeof event.value !== `object` || event.value === null) {
        throw new Error(
          `StreamDB collections require object values; got ${typeof event.value} for type=${event.type}, key=${event.key}`
        )
      }
    }

    // Get value, ensuring it's an object
    const value = (event.value ?? {}) as object

    // Store the key on the value so getKey can retrieve it
    setValueKey(value, event.key)

    // Begin transaction on first write to this handler
    if (!this.pendingHandlers.has(handler)) {
      handler.begin()
      this.pendingHandlers.add(handler)
    }

    handler.write(value, operation)
  }

  /**
   * Handle control events from the stream JSON items
   */
  dispatchControl(event: StateEvent): void {
    if (!isControlEvent(event)) return

    switch (event.headers.control) {
      case `reset`:
        // Truncate all collections
        for (const handler of this.handlers.values()) {
          handler.truncate()
        }
        this.pendingHandlers.clear()
        this.isUpToDate = false
        break

      case `snapshot-start`:
      case `snapshot-end`:
        // These are hints for snapshot boundaries
        break
    }
  }

  /**
   * Commit all pending writes and handle up-to-date signal
   */
  markUpToDate(): void {
    // Commit all handlers that have pending writes
    for (const handler of this.pendingHandlers) {
      handler.commit()
    }
    this.pendingHandlers.clear()

    if (!this.isUpToDate) {
      this.isUpToDate = true
      // Mark all collections as ready
      for (const handler of this.handlers.values()) {
        handler.markReady()
      }
      // Resolve all preload promises
      for (const resolve of this.preloadResolvers) {
        resolve()
      }
      this.preloadResolvers = []
    }
  }

  /**
   * Wait for the stream to reach up-to-date state
   */
  waitForUpToDate(): Promise<void> {
    if (this.isUpToDate) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      this.preloadResolvers.push(resolve)
      this.preloadRejecters.push(reject)
    })
  }

  /**
   * Reject all waiting preload promises with an error
   */
  rejectAll(error: Error): void {
    for (const reject of this.preloadRejecters) {
      reject(error)
    }
    this.preloadResolvers = []
    this.preloadRejecters = []
  }

  /**
   * Check if we've received up-to-date
   */
  get ready(): boolean {
    return this.isUpToDate
  }
}

// ============================================================================
// Sync Factory
// ============================================================================

/**
 * Create a sync config for a stream-backed collection
 */
function createStreamSyncConfig<T extends object>(
  eventType: string,
  dispatcher: EventDispatcher
): SyncConfig<T, string> {
  return {
    sync: ({ begin, write, commit, markReady, truncate }) => {
      // Register this collection's handler with the dispatcher
      dispatcher.registerHandler(eventType, {
        begin,
        write: (value, type) => {
          write({
            value: value as T,
            type,
          })
        },
        commit,
        markReady,
        truncate,
      })

      // If the dispatcher is already up-to-date, mark ready immediately
      if (dispatcher.ready) {
        markReady()
      }

      // Return cleanup function
      return () => {
        // No cleanup needed - stream lifecycle managed by StreamDB
      }
    },
  }
}

// ============================================================================
// Main Implementation
// ============================================================================

/**
 * Reserved collection names that would collide with StreamDB methods
 */
const RESERVED_COLLECTION_NAMES = new Set([`preload`, `close`])

/**
 * Create helper functions for a collection
 */
function createCollectionHelpers<T>(
  eventType: string
): CollectionEventHelpers<T> {
  return {
    insert: ({ key, value, headers }): ChangeEvent<T> => ({
      type: eventType,
      key,
      value,
      headers: { operation: `insert`, ...headers },
    }),
    update: ({ key, value, oldValue, headers }): ChangeEvent<T> => ({
      type: eventType,
      key,
      value,
      old_value: oldValue,
      headers: { operation: `update`, ...headers },
    }),
    delete: ({ key, oldValue, headers }): ChangeEvent<T> => ({
      type: eventType,
      key,
      old_value: oldValue,
      headers: { operation: `delete`, ...headers },
    }),
  }
}

/**
 * Create a state schema definition with typed collections and event helpers
 */
export function createStateSchema<
  T extends Record<string, CollectionDefinition>,
>(definition: { collections: T }): StateSchema<T> {
  // Validate no reserved collection names
  for (const name of Object.keys(definition.collections)) {
    if (RESERVED_COLLECTION_NAMES.has(name)) {
      throw new Error(
        `Reserved collection name "${name}" - this would collide with StreamDB methods (${Array.from(RESERVED_COLLECTION_NAMES).join(`, `)})`
      )
    }
  }

  // Validate no duplicate event types
  const typeToCollection = new Map<string, string>()
  for (const [collectionName, def] of Object.entries(definition.collections)) {
    const existing = typeToCollection.get(def.type)
    if (existing) {
      throw new Error(
        `Duplicate event type "${def.type}" - used by both "${existing}" and "${collectionName}" collections`
      )
    }
    typeToCollection.set(def.type, collectionName)
  }

  // Enhance collections with helper methods
  const enhancedCollections: any = {}
  for (const [name, collectionDef] of Object.entries(definition.collections)) {
    enhancedCollections[name] = {
      ...collectionDef,
      ...createCollectionHelpers(collectionDef.type),
    }
  }

  return { collections: enhancedCollections }
}

/**
 * Create a stream-backed database with TanStack DB collections
 *
 * @example
 * ```typescript
 * const stateSchema = createStateSchema({
 *   collections: {
 *     users: { schema: userSchema, type: "user" },
 *     messages: { schema: messageSchema, type: "message" },
 *   },
 * })
 *
 * // Create change events using schema helpers
 * const insertEvent = stateSchema.collections.users.insert({
 *   key: "123",
 *   value: { name: "Kyle", email: "kyle@example.com" }
 * })
 * await stream.append(insertEvent)
 *
 * // Create a stream DB
 * const db = await createStreamDB({
 *   stream: durableStream,
 *   state: stateSchema,
 * })
 *
 * await db.preload()
 * const user = db.users.get("123")
 * ```
 */
export async function createStreamDB<TDef extends StreamStateDefinition>(
  options: CreateStreamDBOptions<TDef>
): Promise<StreamDB<TDef>> {
  const { stream, state } = options

  // Create the event dispatcher
  const dispatcher = new EventDispatcher()

  // Create TanStack DB collections for each definition
  const collections: Record<string, Collection<object, string>> = {}

  for (const [name, definition] of Object.entries(state.collections)) {
    const collection = createCollection({
      id: `stream-db:${name}`,
      schema: definition.schema as StandardSchemaV1<object>,
      getKey: (item: object) => getValueKey(item),
      sync: createStreamSyncConfig(definition.type, dispatcher),
      startSync: true, // Start syncing immediately
      // Disable GC - we manage lifecycle via db.close()
      // DB would otherwise clean up the collections independently of each other, we
      // cant recover one and not the others from a single log.
      gcTime: 0,
    })

    collections[name] = collection
  }

  // Stream consumer state (lazy initialization)
  let streamResponse: StreamResponse<StateEvent> | null = null
  const abortController = new AbortController()
  let consumerStarted = false

  /**
   * Start the stream consumer (called lazily on first preload)
   */
  const startConsumer = async (): Promise<void> => {
    if (consumerStarted) return
    consumerStarted = true

    // Connect to the stream
    streamResponse = await stream.stream<StateEvent>({
      live: `auto`,
      signal: abortController.signal,
    })

    // Process events as they come in
    streamResponse.subscribeJson(async (batch) => {
      try {
        for (const event of batch.items) {
          if (isChangeEvent(event)) {
            dispatcher.dispatchChange(event)
          } else if (isControlEvent(event)) {
            dispatcher.dispatchControl(event)
          }
        }

        // Check batch-level up-to-date signal
        if (batch.upToDate) {
          dispatcher.markUpToDate()
        }
      } catch (error) {
        // Reject all waiting preload promises
        dispatcher.rejectAll(error as Error)
        // Abort the stream to stop further processing
        abortController.abort()
        // Don't rethrow - we've already rejected the promise
      }
    })
  }

  // Build the StreamDB object with methods
  const dbMethods: StreamDBMethods = {
    preload: async () => {
      await startConsumer()
      await dispatcher.waitForUpToDate()
    },
    close: () => {
      abortController.abort()
    },
  }

  // Combine collections with methods
  const db = {
    ...collections,
    ...dbMethods,
  } as unknown as StreamDB<TDef>

  return db
}
