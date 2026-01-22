/**
 * YjsProvider - Yjs provider implementing the Yjs Durable Streams Protocol.
 *
 * This provider uses the DurableStream client to sync Yjs documents:
 * - Single document URL with query parameters
 * - Snapshot discovery via ?offset=snapshot (307 redirects)
 * - Updates via long-polling
 * - Awareness via ?awareness=<name> query parameter
 *
 * Protocol: https://github.com/durable-streams/durable-streams/blob/main/packages/y-durable-streams/PROTOCOL.md
 */

import * as Y from "yjs"
import * as awarenessProtocol from "y-protocols/awareness"
import { ObservableV2 } from "lib0/observable"
import * as decoding from "lib0/decoding"
import {
  DurableStream,
  DurableStreamError,
  FetchError,
  IdempotentProducer,
} from "@durable-streams/client"
import type { HeadersRecord } from "@durable-streams/client"

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
  /** Starting offset for updates (set after snapshot discovery) */
  startOffset: string
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
   * Document path (can include forward slashes).
   * E.g., "my-doc" or "project/chapter-1"
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
      startOffset: `-1`,
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
      // Step 1: Discover snapshot and get starting offset
      await this.discoverSnapshot(ctx)
      if (this.isStale(ctx)) return

      // Step 2: Create idempotent producer for sending updates
      this.createUpdatesProducer(ctx)

      // Step 3: Start updates stream (will load snapshot if needed)
      await this.startUpdatesStream(ctx, ctx.startOffset)
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

  // ---- URL builders ----

  /**
   * Get the document URL.
   */
  private docUrl(): string {
    return `${this.baseUrl}/docs/${this.docId}`
  }

  /**
   * Get the awareness URL for a named stream.
   */
  private awarenessUrl(name: string = `default`): string {
    return `${this.docUrl()}?awareness=${encodeURIComponent(name)}`
  }

  // ---- Snapshot Discovery ----

  /**
   * Discover the current snapshot state via ?offset=snapshot.
   * Handles 307 redirect to determine starting offset.
   */
  private async discoverSnapshot(ctx: ConnectionContext): Promise<void> {
    const url = `${this.docUrl()}?offset=snapshot`

    const response = await fetch(url, {
      method: `GET`,
      headers: this.headers as Record<string, string>,
      redirect: `manual`, // Don't follow redirects automatically
      signal: ctx.controller.signal,
    })

    if (response.status === 307) {
      // Parse the redirect location
      const location = response.headers.get(`location`)
      if (location) {
        const redirectUrl = new URL(location, url)
        const offset = redirectUrl.searchParams.get(`offset`)
        if (offset) {
          if (offset.endsWith(`_snapshot`)) {
            // Snapshot exists - load it
            await this.loadSnapshot(ctx, offset)
          } else {
            // No snapshot - start from the indicated offset
            ctx.startOffset = offset
          }
          return
        }
      }
    }

    // Fallback: if redirect parsing fails, start from beginning
    ctx.startOffset = `-1`
  }

  /**
   * Load a snapshot from the server.
   */
  private async loadSnapshot(
    ctx: ConnectionContext,
    snapshotOffset: string
  ): Promise<void> {
    const url = `${this.docUrl()}?offset=${encodeURIComponent(snapshotOffset)}`

    try {
      const response = await fetch(url, {
        method: `GET`,
        headers: this.headers as Record<string, string>,
        signal: ctx.controller.signal,
      })

      if (!response.ok) {
        if (response.status === 404) {
          // Snapshot deleted - retry discovery
          await this.discoverSnapshot(ctx)
          return
        }
        throw new Error(`Failed to load snapshot: ${response.status}`)
      }

      // Apply snapshot
      const data = new Uint8Array(await response.arrayBuffer())
      if (data.length > 0) {
        Y.applyUpdate(this.doc, data, `server`)
      }

      // Get the next offset from header
      const nextOffset = response.headers.get(`stream-next-offset`)
      ctx.startOffset = nextOffset ?? `-1`
    } catch (err) {
      if (this.isNotFoundError(err)) {
        // Snapshot deleted - retry discovery
        await this.discoverSnapshot(ctx)
        return
      }
      throw err
    }
  }

  // ---- Updates Producer ----

  private createUpdatesProducer(ctx: ConnectionContext): void {
    const stream = new DurableStream({
      url: this.docUrl(),
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

  // ---- Live updates streaming ----

  private startUpdatesStream(
    ctx: ConnectionContext,
    offset: string
  ): Promise<void> {
    if (ctx.controller.signal.aborted) {
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
        url: this.docUrl(),
        headers: this.headers,
        contentType: `application/octet-stream`,
      })

      try {
        const response = await stream.stream({
          offset: currentOffset,
          live: `auto`, // Auto: first request returns immediately, then long-poll on reconnect
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

  /**
   * Apply lib0-framed updates from the server.
   */
  private applyUpdates(data: Uint8Array): void {
    if (data.length === 0) return

    const decoder = decoding.createDecoder(data)
    while (decoding.hasContent(decoder)) {
      const update = decoding.readVarUint8Array(decoder)
      Y.applyUpdate(this.doc, update, `server`)
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

    // Send raw update - server handles framing
    producer.append(update)
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
        live: `sse`, // Use SSE for awareness per protocol
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
