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
} from "@durable-streams/client"
import type { HeadersRecord } from "@durable-streams/client"
import type { YjsIndex } from "./server/types"

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

  /**
   * Enable debug logging.
   * @default false
   */
  debug?: boolean
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
  private readonly debug: boolean

  private _connected = false
  private _synced = false
  private _connecting = false

  private currentIndex: YjsIndex | null = null
  private updatesStreamGeneration = 0
  private updatesSubscription: (() => void) | null = null

  private sendingChanges = false
  private pendingChanges: Uint8Array | null = null

  private sendingAwareness = false
  private pendingAwareness: AwarenessUpdate | null = null

  private abortController: AbortController | null = null
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
    this.debug = options.debug ?? false

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

  get connected(): boolean {
    return this._connected
  }

  private set connected(state: boolean) {
    if (this._connected !== state) {
      this._connected = state
      this.emit(`status`, [state ? `connected` : `disconnected`])
    }
  }

  get connecting(): boolean {
    return this._connecting
  }

  // ---- Connection management ----

  async connect(): Promise<void> {
    if (this.connected || this._connecting) return

    this._connecting = true
    this.abortController = new AbortController()
    this.emit(`status`, [`connecting`])

    try {
      // Step 1: Fetch the index
      this.currentIndex = await this.fetchIndex()
      if (this.abortController.signal.aborted) return

      // Step 2: Fetch snapshot and start updates stream
      await this.initialSync()

      // Step 3: Start awareness if configured
      if (this.awareness) {
        this.startAwareness()
      }

      this.connected = true
    } catch (err) {
      const isAborted = err instanceof Error && err.name === `AbortError`
      if (!isAborted) {
        this.emit(`error`, [
          err instanceof Error ? err : new Error(String(err)),
        ])
        this.disconnect()
      }
    } finally {
      this._connecting = false
    }
  }

  disconnect(): void {
    if (!this.abortController) return

    this._connecting = false

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

    this.abortController.abort()
    this.abortController = null

    this.currentIndex = null
    this.pendingAwareness = null

    this.connected = false
    this.synced = false
  }

  destroy(): void {
    this.disconnect()
    this.doc.off(`update`, this.handleDocumentUpdate)
    if (this.awareness) {
      this.awareness.off(`update`, this.handleAwarenessUpdate)
    }
    super.destroy()
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

  private async fetchIndex(): Promise<YjsIndex> {
    const url = this.indexUrl()
    if (this.debug) {
      console.debug(`[YjsProvider] fetchIndex URL: ${url}`)
    }

    const stream = new DurableStream({
      url,
      headers: this.headers,
      contentType: `application/json`,
      backoffOptions: this.connectBackoffOptions,
    })

    try {
      if (this.debug) {
        console.debug(`[YjsProvider] fetchIndex calling stream.stream()`)
      }
      const response = await stream.stream({ offset: `-1` })
      const items = await response.json<YjsIndex>()

      if (items.length === 0) {
        // New document - return default index
        if (this.debug) {
          console.debug(`[YjsProvider] fetchIndex: empty, returning default`)
        }
        return {
          snapshot_stream: null,
          updates_stream: `updates-001`,
          update_offset: `-1`,
        }
      }

      const result = items[items.length - 1]!
      if (this.debug) {
        console.debug(
          `[YjsProvider] fetchIndex: got ${items.length} items, using:`,
          JSON.stringify(result)
        )
      }
      return result
    } catch (err) {
      if (this.isNotFoundError(err)) {
        // Stream doesn't exist - return default index
        return {
          snapshot_stream: null,
          updates_stream: `updates-001`,
          update_offset: `-1`,
        }
      }
      throw err
    }
  }

  // ---- Initial sync ----

  private async initialSync(): Promise<void> {
    if (!this.currentIndex) return

    // Fetch snapshot if exists. If it was deleted during compaction, re-fetch index.
    while (this.currentIndex.snapshot_stream) {
      const applied = await this.fetchAndApplySnapshot(
        this.currentIndex.snapshot_stream
      )
      if (applied) break
      if (this.abortController?.signal.aborted) return
      this.currentIndex = await this.fetchIndex()
      if (this.abortController?.signal.aborted) return
    }

    // Single stream handles both catch-up and live polling.
    await this.startUpdatesStream(this.currentIndex.update_offset)
  }

  private async fetchAndApplySnapshot(snapshotId: string): Promise<boolean> {
    const stream = new DurableStream({
      url: this.snapshotUrl(snapshotId),
      headers: this.headers,
      contentType: `application/octet-stream`,
      backoffOptions: this.connectBackoffOptions,
    })

    try {
      const response = await stream.stream({ offset: `-1` })
      const data = await response.body()

      if (data.length > 0) {
        Y.applyUpdate(this.doc, data, `server`)
      }
      return true
    } catch (err) {
      if (this.isNotFoundError(err)) {
        // Snapshot deleted (compaction) - caller should re-fetch index
        return false
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

  private startUpdatesStream(offset: string): Promise<void> {
    if (!this.currentIndex) return Promise.resolve()
    if (this.abortController?.signal.aborted) return Promise.resolve()

    this.updatesStreamGeneration += 1
    const generation = this.updatesStreamGeneration

    this.updatesSubscription?.()
    this.updatesSubscription = null

    let initialResolved = false
    let resolveInitial: () => void
    let rejectInitial: (error: Error) => void

    const initialPromise = new Promise<void>((resolve, reject) => {
      resolveInitial = () => {
        if (!initialResolved) {
          initialResolved = true
          resolve()
        }
      }
      rejectInitial = (error: Error) => {
        if (!initialResolved) {
          initialResolved = true
          reject(error)
        }
      }
    })

    this.runUpdatesStream(
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
    offset: string,
    generation: number,
    resolveInitialSync: () => void,
    rejectInitialSync: (error: Error) => void
  ): Promise<void> {
    if (!this.currentIndex) return

    let currentOffset = offset
    let initialSyncPending = true

    while (this.updatesStreamGeneration === generation) {
      if (this.abortController?.signal.aborted) {
        resolveInitialSync()
        return
      }

      const stream = new DurableStream({
        url: this.updatesUrl(this.currentIndex.updates_stream),
        headers: this.headers,
        contentType: `application/octet-stream`,
      })

      try {
        const response = await stream.stream({
          offset: currentOffset,
          live: `auto`,
          signal: this.abortController?.signal,
        })

        this.updatesSubscription?.()
        // eslint-disable-next-line @typescript-eslint/require-await
        this.updatesSubscription = response.subscribeBytes(async (chunk) => {
          if (this.abortController?.signal.aborted) return
          if (this.updatesStreamGeneration !== generation) return

          currentOffset = chunk.offset

          if (chunk.data.length > 0) {
            if (this.debug) {
              console.debug(
                `[YjsProvider] Received live update: ${chunk.data.length} bytes`
              )
            }
            this.applyUpdates(chunk.data)
          }

          if (initialSyncPending && chunk.upToDate) {
            initialSyncPending = false
            if (!this.connected) {
              this.connected = true
            }
            this.synced = true
            resolveInitialSync()
          } else if (chunk.data.length > 0) {
            this.synced = true
          }
        })

        await response.closed
        if (initialSyncPending) {
          initialSyncPending = false
          if (!this.connected) {
            this.connected = true
          }
          this.synced = true
          resolveInitialSync()
        }
        return
      } catch (err) {
        if (this.abortController?.signal.aborted) {
          resolveInitialSync()
          return
        }
        if (this.updatesStreamGeneration !== generation) {
          resolveInitialSync()
          return
        }

        if (this.isNotFoundError(err)) {
          // Stream doesn't exist yet (new document) - retry quickly.
          // The stream will be created when the first update is written.
          if (initialSyncPending) {
            if (currentOffset === `-1`) {
              initialSyncPending = false
              if (!this.connected) {
                this.connected = true
              }
              this.synced = true
              resolveInitialSync()
            } else {
              rejectInitialSync(
                err instanceof Error ? err : new Error(String(err))
              )
              return
            }
          }
          if (this.debug) {
            console.debug(`[YjsProvider] Updates stream not found, retrying...`)
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
          continue
        }

        if (initialSyncPending) {
          rejectInitialSync(err instanceof Error ? err : new Error(String(err)))
          return
        }

        if (this.debug) {
          console.debug(`[YjsProvider] Updates stream error:`, err)
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

    this.batchUpdate(update)
    this.sendChanges()
  }

  private batchUpdate(update: Uint8Array): void {
    this.pendingChanges = this.pendingChanges
      ? Y.mergeUpdates([this.pendingChanges, update])
      : update
  }

  private async sendChanges(): Promise<void> {
    if (!this.connected || this.sendingChanges || !this.currentIndex) return

    this.sendingChanges = true
    this.synced = false

    try {
      while (this.pendingChanges && this.pendingChanges.length > 0) {
        const toSend = this.pendingChanges
        this.pendingChanges = null

        const url = this.updatesUrl(this.currentIndex.updates_stream)
        if (this.debug) {
          console.debug(
            `[YjsProvider] sendChanges to ${url}, ${toSend.length} bytes`
          )
        }

        const stream = new DurableStream({
          url,
          headers: this.headers,
          contentType: `application/octet-stream`,
        })

        // Frame the update with lib0 VarUint8Array encoding
        const encoder = encoding.createEncoder()
        encoding.writeVarUint8Array(encoder, toSend)
        const framedUpdate = encoding.toUint8Array(encoder)

        await stream.append(framedUpdate, {
          contentType: `application/octet-stream`,
        })

        if (this.debug) {
          console.debug(`[YjsProvider] sendChanges succeeded`)
        }
      }
      this.synced = true
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      console.error(`[YjsProvider] Failed to send changes:`, error)
      this.emit(`error`, [error])
      this.disconnect()
      if (!this.isAuthError(err)) {
        this.connect()
      }
    } finally {
      this.sendingChanges = false
    }
  }

  // ---- Awareness ----

  private startAwareness(): void {
    if (!this.awareness) return
    if (this.abortController?.signal.aborted) return

    this.broadcastAwareness()

    this.awarenessHeartbeat = setInterval(() => {
      this.broadcastAwareness()
    }, AWARENESS_HEARTBEAT_INTERVAL)

    this.subscribeAwareness()
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
      (!this.connected && !this._connecting) ||
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

        if (this.debug) {
          console.debug(
            `[YjsProvider] Sending awareness for clients:`,
            changedClients,
            `base64 length:`,
            base64.length
          )
        }

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

  private async subscribeAwareness(): Promise<void> {
    if (!this.awareness) return
    const signal = this.abortController?.signal
    if (signal?.aborted) return

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
        if (signal?.aborted) return

        if (value.length > 0) {
          // value is Uint8Array of text/plain data (base64 string)
          const base64 = new TextDecoder().decode(value)
          const binary = this.base64ToUint8Array(base64)

          if (this.debug) {
            console.debug(
              `[YjsProvider] Awareness SSE received:`,
              binary.length,
              `bytes`
            )
          }

          try {
            awarenessProtocol.applyAwarenessUpdate(
              this.awareness,
              binary,
              `server`
            )
          } catch (err) {
            if (this.debug) {
              console.debug(`[YjsProvider] Invalid awareness update:`, err)
            }
          }
        }
      }
    } catch (err) {
      if (signal?.aborted || (!this.connected && !this._connecting)) return

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
          this.subscribeAwareness()
        }
        return
      }

      console.error(`[YjsProvider] Awareness stream error:`, err)
      // Retry after delay for other errors
      await new Promise((resolve) => setTimeout(resolve, 1000))
      if (this.connected) {
        this.subscribeAwareness()
      }
    }
  }

  // ---- Helpers ----

  private isNotFoundError(err: unknown): boolean {
    if (err instanceof DurableStreamError && err.code === `NOT_FOUND`) {
      return true
    }
    if (err instanceof FetchError && err.status === 404) {
      return true
    }
    // Don't use loose string matching - connection errors should NOT match
    return false
  }

  private isAuthError(err: unknown): boolean {
    if (err instanceof DurableStreamError) {
      return err.code === `UNAUTHORIZED` || err.code === `FORBIDDEN`
    }
    if (err instanceof FetchError) {
      return err.status === 401 || err.status === 403
    }
    return false
  }

  private uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = ``
    for (const byte of bytes) {
      binary += String.fromCharCode(byte)
    }
    return btoa(binary)
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }
}
