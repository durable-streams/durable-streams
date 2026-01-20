/**
 * YjsProvider - Yjs provider using Durable Streams client directly.
 *
 * This provider uses the DurableStream client to read/write:
 * - Index stream: JSON metadata pointing to current snapshot/updates
 * - Updates stream: Binary Yjs updates with lib0 framing
 * - Snapshot stream: Binary Yjs snapshots
 * - Awareness stream: Text/plain with base64-encoded awareness data (SSE for reads)
 *
 * The provider connects to a Yjs server which proxies to the DS server,
 * handling stream creation and compaction.
 */

import * as Y from "yjs"
import * as awarenessProtocol from "y-protocols/awareness"
import { ObservableV2 } from "lib0/observable"
import * as encoding from "lib0/encoding"
import * as decoding from "lib0/decoding"
import {
  BackoffDefaults,
  DurableStream,
  DurableStreamError,
  FetchError,
  IdempotentProducer,
} from "@durable-streams/client"
import type { HeadersRecord } from "@durable-streams/client"
import type { YjsIndex } from "./server/types"

const DEFAULT_INDEX: YjsIndex = {
  snapshot_stream: null,
  updates_stream: `updates-001`,
  update_offset: `-1`,
}

// ---- State Machine ----

/**
 * Primary connection states for the provider.
 */
type ConnectionState = `disconnected` | `connecting` | `connected`

/**
 * Valid state transitions - documents the state machine at a glance.
 * disconnected -> connecting (connect() called)
 * connecting -> connected (initial sync complete)
 * connecting -> disconnected (error or disconnect() called)
 * connected -> disconnected (disconnect() or error)
 */
const VALID_TRANSITIONS: Record<ConnectionState, Array<ConnectionState>> = {
  disconnected: [`connecting`],
  connecting: [`connected`, `disconnected`],
  connected: [`disconnected`],
}

/**
 * Connection context bundles all state for a single connection attempt.
 * Each connect() creates a new context with a unique ID.
 */
interface ConnectionContext {
  /** Unique ID for this connection attempt */
  readonly id: number
  /** Abort signal for this connection */
  readonly controller: AbortController
  /** Current index (set during connect) */
  index: YjsIndex | null
  /** Idempotent producer for sending updates */
  producer: IdempotentProducer | null
}

/**
 * Connection status of the provider.
 */
export type YjsProviderStatus = `disconnected` | `connecting` | `connected`

/**
 * Options for creating a YjsProvider.
 */
export interface YjsProviderOptions {
  /**
   * The Yjs document to synchronize.
   */
  doc: Y.Doc

  /**
   * Base URL of the Yjs server.
   * E.g., "http://localhost:4438/v1/yjs/my-service"
   */
  baseUrl: string

  /**
   * Document identifier.
   */
  docId: string

  /**
   * Optional Awareness instance for presence support.
   */
  awareness?: awarenessProtocol.Awareness

  /**
   * Optional HTTP headers for requests.
   */
  headers?: HeadersRecord

  /**
   * Whether to automatically connect on construction.
   * @default true
   */
  connect?: boolean
}

/**
 * Events emitted by the YjsProvider.
 */
export interface YjsProviderEvents {
  synced: (synced: boolean) => void
  status: (status: YjsProviderStatus) => void
  error: (error: Error) => void
}

/**
 * Internal type for awareness update events.
 */
interface AwarenessUpdate {
  added: Array<number>
  updated: Array<number>
  removed: Array<number>
}

/**
 * Interval for awareness heartbeats (15 seconds).
 */
export const AWARENESS_HEARTBEAT_INTERVAL = 15000

/**
 * YjsProvider for the Yjs Durable Streams Protocol.
 */
export class YjsProvider extends ObservableV2<YjsProviderEvents> {
  readonly doc: Y.Doc
  readonly awareness?: awarenessProtocol.Awareness

  private readonly baseUrl: string
  private readonly docId: string
  private readonly headers: HeadersRecord

  // ---- State Machine ----
  private _state: ConnectionState = `disconnected`
  private _connectionId = 0
  private _ctx: ConnectionContext | null = null
  private _synced = false

  // ---- Connection-related state ----
  private updatesStreamGeneration = 0
  private updatesSubscription: (() => void) | null = null

  private sendingAwareness = false
  private pendingAwareness: AwarenessUpdate | null = null

  private awarenessHeartbeat: ReturnType<typeof setInterval> | null = null
  private awarenessRetryCount = 0
  private readonly MAX_AWARENESS_RETRIES = 30
  private readonly connectBackoffOptions = {
    ...BackoffDefaults,
    maxRetries: 0,
  }

  constructor(options: YjsProviderOptions) {
    super()
    this.doc = options.doc
    this.awareness = options.awareness
    this.baseUrl = options.baseUrl.replace(/\/$/, ``)
    this.docId = options.docId
    this.headers = options.headers ?? {}

    this.doc.on(`update`, this.handleDocumentUpdate)

    if (this.awareness) {
      this.awareness.on(`update`, this.handleAwarenessUpdate)
    }

    if (options.connect !== false) {
      this.connect()
    }
  }

  // ---- State getters ----

  get synced(): boolean {
    return this._synced
  }

  private set synced(state: boolean) {
    if (this._synced !== state) {
      this._synced = state
      this.emit(`synced`, [state])
    }
  }

  /** True when connected to the server */
  get connected(): boolean {
    return this._state === `connected`
  }

  /** True when connection is in progress */
  get connecting(): boolean {
    return this._state === `connecting`
  }

  // ---- State Machine Methods ----

  /**
   * Transition to a new connection state.
   * Returns false if the transition is invalid (logs a warning).
   */
  private transition(to: ConnectionState): boolean {
    const allowed = VALID_TRANSITIONS[this._state]
    if (!allowed.includes(to)) {
      console.warn(`[YjsProvider] Invalid transition: ${this._state} -> ${to}`)
      return false
    }

    this._state = to
    // Emit status for all transitions
    this.emit(`status`, [to])
    return true
  }

  /**
   * Create a new connection context with a unique ID.
   */
  private createConnectionContext(): ConnectionContext {
    this._connectionId += 1
    const ctx: ConnectionContext = {
      id: this._connectionId,
      controller: new AbortController(),
      index: null,
      producer: null,
    }
    this._ctx = ctx
    return ctx
  }

  /**
   * Check if a connection context is stale (disconnected or replaced).
   * Use this after every await to detect race conditions.
   */
  private isStale(ctx: ConnectionContext): boolean {
    return this._ctx !== ctx || ctx.controller.signal.aborted
  }

  // ---- Connection management ----

  async connect(): Promise<void> {
    // Only allow connecting from disconnected state
    if (this._state !== `disconnected`) return

    if (!this.transition(`connecting`)) return

    const ctx = this.createConnectionContext()

    try {
      // Step 1: Fetch the index
      ctx.index = await this.fetchIndex(ctx)
      if (this.isStale(ctx)) return

      // Step 2: Create idempotent producer for sending updates
      this.createUpdatesProducer(ctx)

      // Step 3: Fetch snapshot and start updates stream
      await this.initialSync(ctx)
      if (this.isStale(ctx)) return

      // Step 4: Start awareness if configured
      if (this.awareness) {
        this.startAwareness(ctx)
      }

      // Note: transition to 'connected' happens in runUpdatesStream.markSynced()
      // so that connected=true before synced=true (tests depend on this ordering)
    } catch (err) {
      const isAborted = err instanceof Error && err.name === `AbortError`
      if (!isAborted && !this.isStale(ctx)) {
        this.emit(`error`, [
          err instanceof Error ? err : new Error(String(err)),
        ])
        this.disconnect()
      }
    }
  }

  async disconnect(): Promise<void> {
    // Guard against concurrent disconnect calls or disconnecting when already disconnected
    const ctx = this._ctx
    if (!ctx || this._state === `disconnected`) return

    // Transition immediately to prevent races
    this.transition(`disconnected`)
    this._ctx = null
    this.synced = false

    if (this.awarenessHeartbeat) {
      clearInterval(this.awarenessHeartbeat)
      this.awarenessHeartbeat = null
    }

    if (this.awareness) {
      this.broadcastAwarenessRemoval()
    }

    this.updatesStreamGeneration += 1
    if (this.updatesSubscription) {
      this.updatesSubscription()
      this.updatesSubscription = null
    }

    // Flush and close producer before aborting
    await this.closeUpdatesProducer(ctx)

    ctx.controller.abort()

    this.pendingAwareness = null
  }

  destroy(): void {
    // Fire-and-forget disconnect - we're destroying anyway
    this.disconnect().catch(() => {})
    this.doc.off(`update`, this.handleDocumentUpdate)
    if (this.awareness) {
      this.awareness.off(`update`, this.handleAwarenessUpdate)
    }
    super.destroy()
  }

  // ---- Updates Producer ----

  private createUpdatesProducer(ctx: ConnectionContext): void {
    if (!ctx.index) return

    const stream = new DurableStream({
      url: this.updatesUrl(ctx.index.updates_stream),
      headers: this.headers,
      contentType: `application/octet-stream`,
    })

    // Use doc clientID for unique producer ID per client
    const producerId = `${this.docId}-${this.doc.clientID}`

    ctx.producer = new IdempotentProducer(stream, producerId, {
      autoClaim: true,
      signal: ctx.controller.signal,
      onError: (err) => {
        // Ignore AbortError - this happens during intentional disconnect
        if (err instanceof Error && err.name === `AbortError`) {
          return
        }
        console.error(`[YjsProvider] Producer error:`, err)
        this.emit(`error`, [err])
        // Disconnect and reconnect on producer errors (unless auth error)
        if (!this.isAuthError(err)) {
          this.disconnect()
          this.connect()
        }
      },
    })
  }

  private async closeUpdatesProducer(ctx: ConnectionContext): Promise<void> {
    if (!ctx.producer) return

    try {
      await ctx.producer.close()
    } catch {
      // Ignore errors during close
    }
    ctx.producer = null
  }

  // ---- Stream URL builders ----

  private indexUrl(): string {
    return `${this.baseUrl}/docs/${this.docId}/index`
  }

  private updatesUrl(streamId: string): string {
    return `${this.baseUrl}/docs/${this.docId}/updates/${streamId}`
  }

  private snapshotUrl(snapshotId: string): string {
    return `${this.baseUrl}/docs/${this.docId}/snapshots/${snapshotId}`
  }

  private awarenessUrl(): string {
    return `${this.baseUrl}/docs/${this.docId}/awareness`
  }

  // ---- Index management ----

  private async fetchIndex(ctx: ConnectionContext): Promise<YjsIndex> {
    const stream = new DurableStream({
      url: this.indexUrl(),
      headers: this.headers,
      contentType: `application/json`,
      backoffOptions: this.connectBackoffOptions,
    })

    try {
      const response = await stream.stream({
        offset: `-1`,
        signal: ctx.controller.signal,
      })
      const items = await response.json<YjsIndex>()

      if (items.length === 0) {
        return DEFAULT_INDEX
      }

      return items[items.length - 1]!
    } catch (err) {
      if (this.isNotFoundError(err)) {
        return DEFAULT_INDEX
      }
      throw err
    }
  }

  // ---- Initial sync ----

  private async initialSync(ctx: ConnectionContext): Promise<void> {
    if (!ctx.index) return

    // Parallel fetch: start both snapshot and updates fetches simultaneously
    // This saves one full round-trip latency for documents with snapshots
    if (ctx.index.snapshot_stream) {
      const snapshotPromise = this.fetchSnapshot(ctx, ctx.index.snapshot_stream)
      const updatesPromise = this.fetchInitialUpdates(
        ctx,
        ctx.index.update_offset
      )

      const [snapshotResult, updatesResult] = await Promise.all([
        snapshotPromise,
        updatesPromise,
      ])

      if (this.isStale(ctx)) return

      // Handle snapshot deleted during fetch (compaction race)
      if (!snapshotResult.found) {
        // Re-fetch index and retry with sequential approach
        ctx.index = await this.fetchIndex(ctx)
        if (this.isStale(ctx)) return
        return this.initialSync(ctx)
      }

      // Apply in correct order: snapshot first, then updates
      if (snapshotResult.data.length > 0) {
        Y.applyUpdate(this.doc, snapshotResult.data, `server`)
      }
      this.applyUpdates(updatesResult.data)

      // Start live streaming from where we left off
      await this.startUpdatesStream(ctx, updatesResult.endOffset)
    } else {
      // No snapshot - just start updates stream from the beginning
      await this.startUpdatesStream(ctx, ctx.index.update_offset)
    }
  }

  /**
   * Fetch snapshot data without applying it.
   * Returns {found: false} if snapshot was deleted (compaction race).
   */
  private async fetchSnapshot(
    ctx: ConnectionContext,
    snapshotId: string
  ): Promise<{ found: true; data: Uint8Array } | { found: false }> {
    const stream = new DurableStream({
      url: this.snapshotUrl(snapshotId),
      headers: this.headers,
      contentType: `application/octet-stream`,
      backoffOptions: this.connectBackoffOptions,
    })

    try {
      const response = await stream.stream({
        offset: `-1`,
        signal: ctx.controller.signal,
      })
      const data = await response.body()
      return { found: true, data }
    } catch (err) {
      if (this.isNotFoundError(err)) {
        return { found: false }
      }
      throw err
    }
  }

  /**
   * Fetch initial updates in one shot (no live streaming).
   * Returns the data and the end offset for subsequent live streaming.
   */
  private async fetchInitialUpdates(
    ctx: ConnectionContext,
    offset: string
  ): Promise<{ data: Uint8Array; endOffset: string }> {
    if (!ctx.index) {
      return { data: new Uint8Array(0), endOffset: offset }
    }

    const stream = new DurableStream({
      url: this.updatesUrl(ctx.index.updates_stream),
      headers: this.headers,
      contentType: `application/octet-stream`,
    })

    try {
      // Use false for one-shot fetch (no live polling)
      const response = await stream.stream({
        offset,
        live: false,
        signal: ctx.controller.signal,
      })
      const data = await response.body()
      return { data, endOffset: response.offset }
    } catch (err) {
      if (this.isNotFoundError(err)) {
        // Stream doesn't exist yet - return empty data, keep original offset
        return { data: new Uint8Array(0), endOffset: offset }
      }
      throw err
    }
  }

  private applyUpdates(data: Uint8Array): void {
    if (data.length === 0) return

    const decoder = decoding.createDecoder(data)
    while (decoding.hasContent(decoder)) {
      const update = decoding.readVarUint8Array(decoder)
      Y.applyUpdate(this.doc, update, `server`)
    }
  }

  // ---- Live updates streaming ----

  private startUpdatesStream(
    ctx: ConnectionContext,
    offset: string
  ): Promise<void> {
    if (!ctx.index || ctx.controller.signal.aborted) {
      return Promise.resolve()
    }

    this.updatesStreamGeneration += 1
    const generation = this.updatesStreamGeneration

    this.updatesSubscription?.()
    this.updatesSubscription = null

    let settled = false
    let resolveInitial: () => void
    let rejectInitial: (error: Error) => void

    const initialPromise = new Promise<void>((resolve, reject) => {
      resolveInitial = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      rejectInitial = (error: Error) => {
        if (!settled) {
          settled = true
          reject(error)
        }
      }
    })

    this.runUpdatesStream(
      ctx,
      offset,
      generation,
      resolveInitial!,
      rejectInitial!
    ).catch((err) => {
      rejectInitial(err instanceof Error ? err : new Error(String(err)))
    })

    return initialPromise
  }

  private async runUpdatesStream(
    ctx: ConnectionContext,
    offset: string,
    generation: number,
    resolveInitialSync: () => void,
    rejectInitialSync: (error: Error) => void
  ): Promise<void> {
    if (!ctx.index) return

    let currentOffset = offset
    let initialSyncPending = true

    const markSynced = (): void => {
      if (!initialSyncPending) return
      initialSyncPending = false
      // Transition to connected BEFORE setting synced, so that when synced event
      // fires, connected is already true (tests depend on this ordering)
      if (this._state === `connecting`) {
        this.transition(`connected`)
      }
      this.synced = true
      resolveInitialSync()
    }

    const isStale = (): boolean =>
      this.isStale(ctx) || this.updatesStreamGeneration !== generation

    while (this.updatesStreamGeneration === generation) {
      if (ctx.controller.signal.aborted) {
        markSynced()
        return
      }

      const stream = new DurableStream({
        url: this.updatesUrl(ctx.index.updates_stream),
        headers: this.headers,
        contentType: `application/octet-stream`,
      })

      try {
        const response = await stream.stream({
          offset: currentOffset,
          live: `auto`,
          signal: ctx.controller.signal,
        })

        this.updatesSubscription?.()
        // eslint-disable-next-line @typescript-eslint/require-await
        this.updatesSubscription = response.subscribeBytes(async (chunk) => {
          if (isStale()) return

          currentOffset = chunk.offset

          if (chunk.data.length > 0) {
            this.applyUpdates(chunk.data)
          }

          if (initialSyncPending && chunk.upToDate) {
            markSynced()
          } else if (chunk.data.length > 0) {
            this.synced = true
          }
        })

        await response.closed
        markSynced()
        return
      } catch (err) {
        if (isStale()) {
          markSynced()
          return
        }

        if (this.isNotFoundError(err)) {
          // Stream doesn't exist yet (new document) - retry quickly
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- markSynced mutates this
          if (initialSyncPending) {
            if (currentOffset === `-1`) {
              // New doc with no updates yet - mark synced and keep polling
              markSynced()
            } else {
              // Expected stream doesn't exist - fail
              rejectInitialSync(
                err instanceof Error ? err : new Error(String(err))
              )
              return
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
          continue
        }

        // Non-404 error during initial sync - fail
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- markSynced mutates this
        if (initialSyncPending) {
          rejectInitialSync(err instanceof Error ? err : new Error(String(err)))
          return
        }

        await new Promise((resolve) => setTimeout(resolve, 1000))
      } finally {
        if (this.updatesSubscription) {
          this.updatesSubscription()
          this.updatesSubscription = null
        }
      }
    }
  }

  // ---- Document updates ----

  private handleDocumentUpdate = (
    update: Uint8Array,
    origin: unknown
  ): void => {
    if (origin === `server`) return
    const producer = this._ctx?.producer
    if (!producer || !this.connected) return

    // Mark as unsynced - will become true when our write echoes back
    this.synced = false

    // Frame the update with lib0 VarUint8Array encoding
    const encoder = encoding.createEncoder()
    encoding.writeVarUint8Array(encoder, update)
    const framedUpdate = encoding.toUint8Array(encoder)

    // Fire-and-forget: producer handles batching, retries, and error reporting
    producer.append(framedUpdate)
  }

  // ---- Awareness ----

  private startAwareness(ctx: ConnectionContext): void {
    if (!this.awareness) return
    if (ctx.controller.signal.aborted) return

    this.broadcastAwareness()

    this.awarenessHeartbeat = setInterval(() => {
      this.broadcastAwareness()
    }, AWARENESS_HEARTBEAT_INTERVAL)

    this.subscribeAwareness(ctx)
  }

  private handleAwarenessUpdate = (
    update: AwarenessUpdate,
    origin: unknown
  ): void => {
    if (!this.awareness || origin === `server` || origin === this) return

    const { added, updated, removed } = update
    const changedClients = added.concat(updated).concat(removed)
    if (!changedClients.includes(this.awareness.clientID)) return

    this.pendingAwareness = update
    this.sendAwareness()
  }

  private broadcastAwareness(): void {
    if (!this.awareness) return

    this.pendingAwareness = {
      added: [this.awareness.clientID],
      updated: [],
      removed: [],
    }
    this.sendAwareness()
  }

  private broadcastAwarenessRemoval(): void {
    if (!this.awareness) return

    try {
      this.awareness.setLocalState(null)
      const encoded = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
        this.awareness.clientID,
      ])

      // Encode to base64 for text/plain stream
      const base64 = this.uint8ArrayToBase64(encoded)

      const stream = new DurableStream({
        url: this.awarenessUrl(),
        headers: this.headers,
        contentType: `text/plain`,
      })

      stream.append(base64, { contentType: `text/plain` }).catch(() => {})
    } catch {
      // Ignore errors during disconnect
    }
  }

  private async sendAwareness(): Promise<void> {
    if (
      !this.awareness ||
      (!this.connected && !this.connecting) ||
      this.sendingAwareness
    )
      return

    this.sendingAwareness = true

    try {
      while (this.pendingAwareness) {
        const update = this.pendingAwareness
        this.pendingAwareness = null

        const { added, updated, removed } = update
        const changedClients = added.concat(updated).concat(removed)

        const encoded = awarenessProtocol.encodeAwarenessUpdate(
          this.awareness,
          changedClients
        )

        // Encode to base64 for text/plain stream
        const base64 = this.uint8ArrayToBase64(encoded)

        const stream = new DurableStream({
          url: this.awarenessUrl(),
          headers: this.headers,
          contentType: `text/plain`,
        })

        await stream.append(base64, { contentType: `text/plain` })
      }
    } catch (err) {
      console.error(`[YjsProvider] Failed to send awareness:`, err)
    } finally {
      this.sendingAwareness = false
    }
  }

  private async subscribeAwareness(ctx: ConnectionContext): Promise<void> {
    if (!this.awareness) return
    const signal = ctx.controller.signal
    if (signal.aborted) return

    const stream = new DurableStream({
      url: this.awarenessUrl(),
      headers: this.headers,
      contentType: `text/plain`,
    })

    try {
      const response = await stream.stream({
        offset: `now`,
        live: `sse`,
        signal,
      })
      // Ensure closed promise is handled to avoid unhandled rejections.
      void response.closed.catch(() => {})

      // Reset retry count on successful connection
      this.awarenessRetryCount = 0

      const bodyStream = response.bodyStream()

      for await (const value of bodyStream) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- signal.aborted can change asynchronously
        if (signal.aborted) return

        if (value.length > 0) {
          // value is Uint8Array of text/plain data (base64 string)
          const base64 = new TextDecoder().decode(value)
          const binary = this.base64ToUint8Array(base64)

          try {
            awarenessProtocol.applyAwarenessUpdate(
              this.awareness,
              binary,
              `server`
            )
          } catch {
            // Ignore invalid awareness updates - they're ephemeral
          }
        }
      }

      // Stream ended cleanly (EOF) - resubscribe if still connected
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- signal.aborted can change asynchronously
      if (this.connected && !signal.aborted) {
        await new Promise((r) => setTimeout(r, 250))
        this.subscribeAwareness(ctx)
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- signal.aborted can change asynchronously
      if (signal.aborted || (!this.connected && !this.connecting)) return

      if (this.isNotFoundError(err)) {
        // Awareness stream doesn't exist yet (created lazily on first write)
        this.awarenessRetryCount++
        if (this.awarenessRetryCount > this.MAX_AWARENESS_RETRIES) {
          console.error(
            `[YjsProvider] Awareness stream not found after ${this.MAX_AWARENESS_RETRIES} retries`
          )
          return // Don't disconnect - awareness is optional
        }

        // Exponential backoff with cap
        const delay = Math.min(
          100 * Math.pow(1.5, this.awarenessRetryCount - 1),
          2000
        )
        await new Promise((r) => setTimeout(r, delay))

        if (this.connected) {
          this.subscribeAwareness(ctx)
        }
        return
      }

      console.error(`[YjsProvider] Awareness stream error:`, err)
      // Retry after delay for other errors
      await new Promise((resolve) => setTimeout(resolve, 1000))
      if (this.connected) {
        this.subscribeAwareness(ctx)
      }
    }
  }

  // ---- Helpers ----

  private isNotFoundError(err: unknown): boolean {
    return (
      (err instanceof DurableStreamError && err.code === `NOT_FOUND`) ||
      (err instanceof FetchError && err.status === 404)
    )
  }

  private isAuthError(err: unknown): boolean {
    return (
      (err instanceof DurableStreamError &&
        (err.code === `UNAUTHORIZED` || err.code === `FORBIDDEN`)) ||
      (err instanceof FetchError && (err.status === 401 || err.status === 403))
    )
  }

  private uint8ArrayToBase64(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64)
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  }
}
