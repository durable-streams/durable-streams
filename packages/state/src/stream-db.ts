import { createCollection, createOptimisticAction } from "@tanstack/db"
import { DurableStream as DurableStreamClass } from "@durable-streams/client"
import { isChangeEvent, isControlEvent } from "./types"
import type { Collection, SyncConfig } from "@tanstack/db"
import type { ChangeEvent, StateEvent } from "./types"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type {
  DurableStream,
  DurableStreamOptions,
  StreamResponse,
} from "@durable-streams/client"

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
  /** The property name in T that serves as the primary key */
  primaryKey: string
}

/**
 * Helper methods for creating change events for a collection
 */
export interface CollectionEventHelpers<T> {
  /**
   * Create an insert change event
   */
  insert: (params: {
    key?: string
    value: T
    headers?: Omit<Record<string, string>, `operation`>
  }) => ChangeEvent<T>
  /**
   * Create an update change event
   */
  update: (params: {
    key?: string
    value: T
    oldValue?: T
    headers?: Omit<Record<string, string>, `operation`>
  }) => ChangeEvent<T>
  /**
   * Create a delete change event
   */
  delete: (params: {
    key?: string
    oldValue?: T
    headers?: Omit<Record<string, string>, `operation`>
  }) => ChangeEvent<T>
  /**
   * Create an upsert change event (insert or update)
   */
  upsert: (params: {
    key?: string
    value: T
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
export type StreamStateDefinition = Record<string, CollectionDefinition>

/**
 * Stream state schema with helper methods for creating change events
 */
export type StateSchema<T extends Record<string, CollectionDefinition>> = {
  [K in keyof T]: CollectionWithHelpers<
    T[K] extends CollectionDefinition<infer U> ? U : unknown
  >
}

/**
 * Definition for a single action that can be passed to createOptimisticAction
 */
export interface ActionDefinition<TParams = any, TContext = any> {
  onMutate: (params: TParams) => void
  mutationFn: (params: TParams, context: TContext) => Promise<any>
}

/**
 * Factory function for creating actions with access to db and stream context
 */
export type ActionFactory<
  TDef extends StreamStateDefinition,
  TActions extends Record<string, ActionDefinition<any>>,
> = (context: { db: StreamDB<TDef>; stream: DurableStream }) => TActions

/**
 * Map action definitions to callable action functions
 */
export type ActionMap<TActions extends Record<string, ActionDefinition<any>>> =
  {
    [K in keyof TActions]: ReturnType<typeof createOptimisticAction<any>>
  }

/**
 * Options for creating a stream DB
 */
export interface CreateStreamDBOptions<
  TDef extends StreamStateDefinition = StreamStateDefinition,
  TActions extends Record<string, ActionDefinition<any>> = Record<
    string,
    never
  >,
> {
  /** Options for creating the durable stream (stream is created lazily on preload) */
  streamOptions: DurableStreamOptions
  /** The stream state definition */
  state: TDef
  /** Optional factory function to create actions with db and stream context */
  actions?: ActionFactory<TDef, TActions>
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
  [K in keyof TDef]: Collection<ExtractCollectionType<TDef[K]> & object, string>
}

/**
 * The StreamDB interface - provides typed access to collections
 */
export type StreamDB<TDef extends StreamStateDefinition> = {
  collections: CollectionMap<TDef>
} & StreamDBMethods

/**
 * StreamDB with actions
 */
export type StreamDBWithActions<
  TDef extends StreamStateDefinition,
  TActions extends Record<string, ActionDefinition<any>>,
> = StreamDB<TDef> & {
  actions: ActionMap<TActions>
}

/**
 * Utility methods available on StreamDB
 */
export interface StreamDBUtils {
  /**
   * Wait for a specific transaction ID to be synced through the stream
   * @param txid The transaction ID to wait for (UUID string)
   * @param timeout Optional timeout in milliseconds (defaults to 5000ms)
   * @returns Promise that resolves when the txid is synced
   */
  awaitTxId: (txid: string, timeout?: number) => Promise<void>
}

/**
 * Methods available on a StreamDB instance
 */
export interface StreamDBMethods {
  /**
   * The underlying DurableStream instance
   */
  stream: DurableStream

  /**
   * Preload all collections by consuming the stream until up-to-date
   */
  preload: () => Promise<void>

  /**
   * Close the stream connection and cleanup
   */
  close: () => void

  /**
   * Utility methods for advanced stream operations
   */
  utils: StreamDBUtils
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
  primaryKey: string
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

  /** Set of all txids that have been seen and committed */
  private seenTxids = new Set<string>()

  /** Txids collected during current batch (before commit) */
  private pendingTxids = new Set<string>()

  /** Resolvers waiting for specific txids */
  private txidResolvers = new Map<
    string,
    Array<{
      resolve: () => void
      reject: (error: Error) => void
      timeoutId: ReturnType<typeof setTimeout>
    }>
  >()

  /** Track existing keys per collection for upsert logic */
  private existingKeys = new Map<string, Set<string>>()

  /**
   * Register a handler for a specific event type
   */
  registerHandler(eventType: string, handler: CollectionSyncHandler): void {
    this.handlers.set(eventType, handler)
    // Initialize key tracking for upsert logic
    if (!this.existingKeys.has(eventType)) {
      this.existingKeys.set(eventType, new Set())
    }
  }

  /**
   * Dispatch a change event to the appropriate collection.
   * Writes are buffered until commit() is called via markUpToDate().
   */
  dispatchChange(event: StateEvent): void {
    if (!isChangeEvent(event)) return

    // Check for txid in headers and collect it
    if (event.headers.txid && typeof event.headers.txid === `string`) {
      this.pendingTxids.add(event.headers.txid)
    }

    const handler = this.handlers.get(event.type)
    if (!handler) {
      // Unknown event type - ignore silently
      return
    }

    let operation = event.headers.operation

    // Validate that values are objects (required for key tracking)
    if (operation !== `delete`) {
      if (typeof event.value !== `object` || event.value === null) {
        throw new Error(
          `StreamDB collections require object values; got ${typeof event.value} for type=${event.type}, key=${event.key}`
        )
      }
    }

    // Get value, ensuring it's an object
    const originalValue = (event.value ?? {}) as object

    // Create a shallow copy to avoid mutating the original
    const value = { ...originalValue }

    // Set the primary key field on the value object from the event key
    ;(value as any)[handler.primaryKey] = event.key

    // Begin transaction on first write to this handler
    if (!this.pendingHandlers.has(handler)) {
      handler.begin()
      this.pendingHandlers.add(handler)
    }

    // Handle upsert by converting to insert or update
    if (operation === `upsert`) {
      const keys = this.existingKeys.get(event.type)
      const existing = keys?.has(event.key)
      operation = existing ? `update` : `insert`
    }

    // Track key existence for upsert logic
    const keys = this.existingKeys.get(event.type)
    if (operation === `insert` || operation === `update`) {
      keys?.add(event.key)
    } else {
      // Must be delete
      keys?.delete(event.key)
    }

    try {
      handler.write(value, operation)
    } catch (error) {
      console.error(`[StreamDB] Error in handler.write():`, error)
      console.error(`[StreamDB] Event that caused error:`, {
        type: event.type,
        key: event.key,
        operation,
      })
      throw error
    }
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
        // Clear key tracking
        for (const keys of this.existingKeys.values()) {
          keys.clear()
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
      try {
        handler.commit()
      } catch (error) {
        console.error(`[StreamDB] Error in handler.commit():`, error)

        // WORKAROUND for TanStack DB groupBy bug
        // If it's the known "already exists in collection live-query" error, log and continue
        if (
          error instanceof Error &&
          error.message.includes(`already exists in the collection`) &&
          error.message.includes(`live-query`)
        ) {
          console.warn(
            `[StreamDB] Known TanStack DB groupBy bug detected - continuing despite error`
          )
          console.warn(
            `[StreamDB] Queries with groupBy may show stale data until fixed`
          )
          continue // Don't throw, let other handlers commit
        }

        throw error
      }
    }
    this.pendingHandlers.clear()

    // Commit pending txids
    for (const txid of this.pendingTxids) {
      this.seenTxids.add(txid)

      // Resolve any promises waiting for this txid
      const resolvers = this.txidResolvers.get(txid)
      if (resolvers) {
        for (const { resolve, timeoutId } of resolvers) {
          clearTimeout(timeoutId)
          resolve()
        }
        this.txidResolvers.delete(txid)
      }
    }
    this.pendingTxids.clear()

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

    // Also reject all pending txid promises
    for (const resolvers of this.txidResolvers.values()) {
      for (const { reject, timeoutId } of resolvers) {
        clearTimeout(timeoutId)
        reject(error)
      }
    }
    this.txidResolvers.clear()
  }

  /**
   * Check if we've received up-to-date
   */
  get ready(): boolean {
    return this.isUpToDate
  }

  /**
   * Wait for a specific txid to be seen in the stream
   */
  awaitTxId(txid: string, timeout: number = 5000): Promise<void> {
    // Check if we've already seen this txid
    if (this.seenTxids.has(txid)) {
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        // Remove this resolver from the map
        const resolvers = this.txidResolvers.get(txid)
        if (resolvers) {
          const index = resolvers.findIndex((r) => r.timeoutId === timeoutId)
          if (index !== -1) {
            resolvers.splice(index, 1)
          }
          if (resolvers.length === 0) {
            this.txidResolvers.delete(txid)
          }
        }
        reject(new Error(`Timeout waiting for txid: ${txid}`))
      }, timeout)

      // Add to resolvers map
      if (!this.txidResolvers.has(txid)) {
        this.txidResolvers.set(txid, [])
      }
      this.txidResolvers.get(txid)!.push({ resolve, reject, timeoutId })
    })
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
  dispatcher: EventDispatcher,
  primaryKey: string
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
        primaryKey,
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
 * Reserved collection names that would collide with StreamDB properties
 * (collections are now namespaced, but we still prevent internal name collisions)
 */
const RESERVED_COLLECTION_NAMES = new Set([
  `collections`,
  `preload`,
  `close`,
  `utils`,
  `actions`,
])

/**
 * Create helper functions for a collection
 */
function createCollectionHelpers<T>(
  eventType: string,
  primaryKey: string,
  schema: StandardSchemaV1<T>
): CollectionEventHelpers<T> {
  return {
    insert: ({ key, value, headers }): ChangeEvent<T> => {
      // Validate value
      const result = schema[`~standard`].validate(value)
      if (`issues` in result) {
        throw new Error(
          `Validation failed for ${eventType} insert: ${result.issues?.map((i) => i.message).join(`, `) ?? `Unknown validation error`}`
        )
      }

      // Derive key from value if not explicitly provided
      const derived = (value as any)[primaryKey]
      const finalKey =
        key ?? (derived != null && derived !== `` ? String(derived) : undefined)
      if (finalKey == null || finalKey === ``) {
        throw new Error(
          `Cannot create ${eventType} insert event: must provide either 'key' or a value with a non-empty '${primaryKey}' field`
        )
      }

      return {
        type: eventType,
        key: finalKey,
        value,
        headers: { ...headers, operation: `insert` },
      }
    },
    update: ({ key, value, oldValue, headers }): ChangeEvent<T> => {
      // Validate value
      const result = schema[`~standard`].validate(value)
      if (`issues` in result) {
        throw new Error(
          `Validation failed for ${eventType} update: ${result.issues?.map((i) => i.message).join(`, `) ?? `Unknown validation error`}`
        )
      }

      // Optionally validate oldValue if provided
      if (oldValue !== undefined) {
        const oldResult = schema[`~standard`].validate(oldValue)
        if (`issues` in oldResult) {
          throw new Error(
            `Validation failed for ${eventType} update (oldValue): ${oldResult.issues?.map((i) => i.message).join(`, `) ?? `Unknown validation error`}`
          )
        }
      }

      // Derive key from value if not explicitly provided
      const derived = (value as any)[primaryKey]
      const finalKey =
        key ?? (derived != null && derived !== `` ? String(derived) : undefined)
      if (finalKey == null || finalKey === ``) {
        throw new Error(
          `Cannot create ${eventType} update event: must provide either 'key' or a value with a non-empty '${primaryKey}' field`
        )
      }

      return {
        type: eventType,
        key: finalKey,
        value,
        old_value: oldValue,
        headers: { ...headers, operation: `update` },
      }
    },
    delete: ({ key, oldValue, headers }): ChangeEvent<T> => {
      // Optionally validate oldValue if provided
      if (oldValue !== undefined) {
        const result = schema[`~standard`].validate(oldValue)
        if (`issues` in result) {
          throw new Error(
            `Validation failed for ${eventType} delete (oldValue): ${result.issues?.map((i) => i.message).join(`, `) ?? `Unknown validation error`}`
          )
        }
      }

      // Ensure we have either key or oldValue to derive the key from
      const finalKey =
        key ?? (oldValue ? String((oldValue as any)[primaryKey]) : undefined)
      if (!finalKey) {
        throw new Error(
          `Cannot create ${eventType} delete event: must provide either 'key' or 'oldValue' with a ${primaryKey} field`
        )
      }

      return {
        type: eventType,
        key: finalKey,
        old_value: oldValue,
        headers: { ...headers, operation: `delete` },
      }
    },
    upsert: ({ key, value, headers }): ChangeEvent<T> => {
      // Validate value
      const result = schema[`~standard`].validate(value)
      if (`issues` in result) {
        throw new Error(
          `Validation failed for ${eventType} upsert: ${result.issues?.map((i) => i.message).join(`, `) ?? `Unknown validation error`}`
        )
      }

      // Derive key from value if not explicitly provided
      const derived = (value as any)[primaryKey]
      const finalKey =
        key ?? (derived != null && derived !== `` ? String(derived) : undefined)
      if (finalKey == null || finalKey === ``) {
        throw new Error(
          `Cannot create ${eventType} upsert event: must provide either 'key' or a value with a non-empty '${primaryKey}' field`
        )
      }

      return {
        type: eventType,
        key: finalKey,
        value,
        headers: { ...headers, operation: `upsert` },
      }
    },
  }
}

/**
 * Create a state schema definition with typed collections and event helpers
 */
export function createStateSchema<
  T extends Record<string, CollectionDefinition>,
>(collections: T): StateSchema<T> {
  // Validate no reserved collection names
  for (const name of Object.keys(collections)) {
    if (RESERVED_COLLECTION_NAMES.has(name)) {
      throw new Error(
        `Reserved collection name "${name}" - this would collide with StreamDB properties (${Array.from(RESERVED_COLLECTION_NAMES).join(`, `)})`
      )
    }
  }

  // Validate no duplicate event types
  const typeToCollection = new Map<string, string>()
  for (const [collectionName, def] of Object.entries(collections)) {
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
  for (const [name, collectionDef] of Object.entries(collections)) {
    enhancedCollections[name] = {
      ...collectionDef,
      ...createCollectionHelpers(
        collectionDef.type,
        collectionDef.primaryKey,
        collectionDef.schema
      ),
    }
  }

  return enhancedCollections
}

/**
 * Create a stream-backed database with TanStack DB collections
 *
 * This function is synchronous - it creates the stream handle and collections
 * but does not start the stream connection. Call `db.preload()` to connect
 * and sync initial data.
 *
 * @example
 * ```typescript
 * const stateSchema = createStateSchema({
 *   users: { schema: userSchema, type: "user", primaryKey: "id" },
 *   messages: { schema: messageSchema, type: "message", primaryKey: "id" },
 * })
 *
 * // Create a stream DB (synchronous - stream is created lazily on preload)
 * const db = createStreamDB({
 *   streamOptions: {
 *     url: "https://api.example.com/streams/my-stream",
 *     contentType: "application/json",
 *   },
 *   state: stateSchema,
 * })
 *
 * // preload() creates the stream and loads initial data
 * await db.preload()
 * const user = await db.collections.users.get("123")
 * ```
 */
export function createStreamDB<
  TDef extends StreamStateDefinition,
  TActions extends Record<string, ActionDefinition<any>> = Record<
    string,
    never
  >,
>(
  options: CreateStreamDBOptions<TDef, TActions>
): TActions extends Record<string, never>
  ? StreamDB<TDef>
  : StreamDBWithActions<TDef, TActions> {
  const { streamOptions, state, actions: actionsFactory } = options

  // Create a stream handle (lightweight, doesn't connect until stream() is called)
  const stream = new DurableStreamClass(streamOptions)

  // Create the event dispatcher
  const dispatcher = new EventDispatcher()

  // Create TanStack DB collections for each definition
  const collectionInstances: Record<string, Collection<object, string>> = {}

  for (const [name, definition] of Object.entries(state)) {
    const collection = createCollection({
      id: `stream-db:${name}`,
      schema: definition.schema as StandardSchemaV1<object>,
      getKey: (item: any) => String(item[definition.primaryKey]),
      sync: createStreamSyncConfig(
        definition.type,
        dispatcher,
        definition.primaryKey
      ),
      startSync: true, // Start syncing immediately
      // Disable GC - we manage lifecycle via db.close()
      // DB would otherwise clean up the collections independently of each other, we
      // cant recover one and not the others from a single log.
      gcTime: 0,
    })

    console.log(`[StreamDB] Created collection "${name}":`, {
      type: typeof collection,
      constructor: collection.constructor.name,
      isCollection: collection instanceof Object,
      hasSize: `size` in collection,
    })

    collectionInstances[name] = collection
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

    // Start streaming (this is where the connection actually happens)
    streamResponse = await stream.stream<StateEvent>({
      live: `auto`,
      signal: abortController.signal,
    })

    // Track batch processing for debugging
    let batchCount = 0
    let lastBatchTime = Date.now()

    // Process events as they come in
    streamResponse.subscribeJson((batch) => {
      try {
        batchCount++
        lastBatchTime = Date.now()

        if (batch.items.length > 0) {
          console.log(
            `[StreamDB] Processing batch #${batchCount}: ${batch.items.length} items, upToDate=${batch.upToDate}`
          )
        }

        for (const event of batch.items) {
          if (isChangeEvent(event)) {
            dispatcher.dispatchChange(event)
          } else if (isControlEvent(event)) {
            dispatcher.dispatchControl(event)
          }
        }

        // Check batch-level up-to-date signal
        if (batch.upToDate) {
          console.log(
            `[StreamDB] Marking up-to-date after batch #${batchCount}`
          )
          dispatcher.markUpToDate()
          console.log(`[StreamDB] Successfully marked up-to-date`)
        }

        if (batch.items.length > 0) {
          console.log(`[StreamDB] Successfully processed batch #${batchCount}`)
        }
      } catch (error) {
        console.error(`[StreamDB] Error processing batch:`, error)
        console.error(`[StreamDB] Failed batch:`, batch)
        // Reject all waiting preload promises
        dispatcher.rejectAll(error as Error)
        // Abort the stream to stop further processing
        abortController.abort()
        // Don't rethrow - we've already rejected the promise
      }
      return Promise.resolve()
    })

    // Health check to detect silent stalls
    const healthCheck = setInterval(() => {
      const timeSinceLastBatch = Date.now() - lastBatchTime
      console.log(
        `[StreamDB] Health: ${batchCount} batches processed, last batch ${(timeSinceLastBatch / 1000).toFixed(1)}s ago`
      )
    }, 15000)

    // Clean up health check on abort
    abortController.signal.addEventListener(`abort`, () => {
      clearInterval(healthCheck)
      console.log(`[StreamDB] Aborted - cleaning up health check`)
    })
  }

  // Build the StreamDB object with methods
  const dbMethods: StreamDBMethods = {
    stream,
    preload: async () => {
      await startConsumer()
      await dispatcher.waitForUpToDate()
    },
    close: () => {
      // Reject all pending operations before aborting
      dispatcher.rejectAll(new Error(`StreamDB closed`))
      abortController.abort()
    },
    utils: {
      awaitTxId: (txid: string, timeout?: number) =>
        dispatcher.awaitTxId(txid, timeout),
    },
  }

  // Combine collections with methods
  console.log(
    `[StreamDB] Creating db object with collections:`,
    Object.keys(collectionInstances)
  )
  const db = {
    collections: collectionInstances,
    ...dbMethods,
  } as unknown as StreamDB<TDef>
  console.log(`[StreamDB] db.collections:`, Object.keys(db.collections))
  console.log(`[StreamDB] db.collections.events:`, db.collections.events)

  // If actions factory is provided, wrap actions and return db with actions
  if (actionsFactory) {
    const actionDefs = actionsFactory({ db, stream })
    const wrappedActions: Record<
      string,
      ReturnType<typeof createOptimisticAction>
    > = {}
    for (const [name, def] of Object.entries(actionDefs)) {
      wrappedActions[name] = createOptimisticAction({
        onMutate: def.onMutate,
        mutationFn: def.mutationFn,
      })
    }

    return {
      ...db,
      actions: wrappedActions,
    } as any
  }

  return db as any
}
