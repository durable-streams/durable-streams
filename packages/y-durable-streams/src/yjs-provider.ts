/**
 * YjsProvider - Yjs provider for the Yjs Durable Streams Protocol.
 *
 * This provider connects to a Yjs server (which manages document storage
 * and compaction) rather than directly to raw durable streams.
 *
 * Sync flow:
 * 1. GET /docs/{docId} → fetch index JSON
 * 2. Parallel:
 *    - GET /snapshots/{id} → fetch snapshot binary (if exists)
 *    - GET /updates/{id}?offset=N → fetch updates binary since snapshot
 * 3. Apply: snapshot first, then updates
 * 4. GET /updates/{id}?offset=M&live=long-poll → long-poll for live updates
 * 5. POST /docs/{docId} → write local updates (binary)
 * 6. Handle 404 on snapshot/updates → re-fetch index (compaction happened)
 */

import * as Y from "yjs"
import * as awarenessProtocol from "y-protocols/awareness"
import { ObservableV2 } from "lib0/observable"
import * as encoding from "lib0/encoding"
import * as decoding from "lib0/decoding"
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
  /**
   * Emitted when the sync state changes.
   */
  synced: (synced: boolean) => void

  /**
   * Emitted when the connection status changes.
   */
  status: (status: YjsProviderStatus) => void

  /**
   * Emitted when an error occurs.
   */
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
  private currentOffset: string | null = null

  private sendingChanges = false
  private pendingChanges: Uint8Array | null = null

  private sendingAwareness = false
  private pendingAwareness: AwarenessUpdate | null = null

  private abortController: AbortController | null = null
  private pollAbortController: AbortController | null = null
  private awarenessHeartbeat: ReturnType<typeof setInterval> | null = null

  constructor(options: YjsProviderOptions) {
    super()
    this.doc = options.doc
    this.awareness = options.awareness
    this.baseUrl = options.baseUrl.replace(/\/$/, ``) // Remove trailing slash
    this.docId = options.docId
    this.headers = options.headers ?? {}
    this.debug = options.debug ?? false

    // Listen for local document updates
    this.doc.on(`update`, this.handleDocumentUpdate)

    // Listen for awareness updates if configured
    if (this.awareness) {
      this.awareness.on(`update`, this.handleAwarenessUpdate)
    }

    // Auto-connect unless disabled
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

  // ---- Connection management ----

  async connect(): Promise<void> {
    if (this.connected || this._connecting) return

    this._connecting = true
    this.abortController = new AbortController()
    this.emit(`status`, [`connecting`])

    try {
      // Step 1: Fetch the index
      this.currentIndex = await this.fetchIndex()

      // Step 2: Fetch snapshot and updates in parallel
      await this.initialSync()

      // Step 3: Start long-polling for live updates
      this.startPolling()

      // Step 4: Start awareness if configured
      if (this.awareness) {
        this.startAwareness()
      }

      this.connected = true
      this.synced = true
    } catch (err) {
      // Don't emit errors for aborted operations (disconnect called during connect)
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

    // Clean up awareness
    if (this.awarenessHeartbeat) {
      clearInterval(this.awarenessHeartbeat)
      this.awarenessHeartbeat = null
    }

    // Broadcast awareness removal
    if (this.awareness) {
      this.broadcastAwarenessRemoval()
    }

    // Abort all pending requests
    this.abortController.abort()
    this.abortController = null
    this.pollAbortController?.abort()
    this.pollAbortController = null

    // Clear state
    this.currentIndex = null
    this.currentOffset = null
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

  // ---- Index management ----

  private async fetchIndex(): Promise<YjsIndex> {
    const url = `${this.baseUrl}/docs/${this.docId}`
    const response = await this.fetch(url)

    if (!response.ok) {
      throw new Error(`Failed to fetch index: ${response.status}`)
    }

    return await response.json()
  }

  // ---- Initial sync ----

  private async initialSync(): Promise<void> {
    if (!this.currentIndex) return

    const promises: Array<Promise<void>> = []

    // Fetch snapshot if exists
    if (this.currentIndex.snapshot_stream) {
      promises.push(
        this.fetchAndApplySnapshot(this.currentIndex.snapshot_stream)
      )
    }

    // Fetch updates
    const offset =
      this.currentIndex.update_offset === -1
        ? `-1`
        : `${this.currentIndex.update_offset}_0`
    promises.push(this.fetchAndApplyUpdates(offset))

    await Promise.all(promises)
  }

  private async fetchAndApplySnapshot(snapshotId: string): Promise<void> {
    const url = `${this.baseUrl}/docs/${this.docId}/snapshots/${snapshotId}`

    try {
      const response = await this.fetch(url)

      if (response.status === 404) {
        // Snapshot was deleted (compaction) - re-fetch index
        await this.handleCompaction()
        return
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch snapshot: ${response.status}`)
      }

      const data = new Uint8Array(await response.arrayBuffer())
      if (data.length > 0) {
        Y.applyUpdate(this.doc, data, `server`)
      }
    } catch (err) {
      if (this.isNotFoundError(err)) {
        await this.handleCompaction()
        return
      }
      throw err
    }
  }

  private async fetchAndApplyUpdates(offset: string): Promise<void> {
    if (!this.currentIndex) return

    const url = new URL(
      `${this.baseUrl}/docs/${this.docId}/updates/${this.currentIndex.updates_stream}`
    )
    url.searchParams.set(`offset`, offset)

    try {
      const response = await this.fetch(url.toString())

      if (response.status === 404) {
        // Updates stream was deleted (compaction) - re-fetch index
        await this.handleCompaction()
        return
      }

      if (!response.ok) {
        throw new Error(`Failed to fetch updates: ${response.status}`)
      }

      const data = new Uint8Array(await response.arrayBuffer())
      this.applyUpdates(data)

      // Update offset for next poll
      this.currentOffset = response.headers.get(`Stream-Next-Offset`) ?? offset
    } catch (err) {
      if (this.isNotFoundError(err)) {
        await this.handleCompaction()
        return
      }
      throw err
    }
  }

  private applyUpdates(data: Uint8Array): void {
    if (data.length === 0) return

    const decoder = decoding.createDecoder(data)
    while (decoding.hasContent(decoder)) {
      try {
        const update = decoding.readVarUint8Array(decoder)
        Y.applyUpdate(this.doc, update, `server`)
      } catch (err) {
        if (this.debug) {
          console.debug(`[YjsProvider] Invalid update, skipping:`, err)
        }
        break
      }
    }
  }

  // ---- Long-polling ----

  private startPolling(): void {
    if (!this.currentIndex || !this.currentOffset) return

    this.pollAbortController = new AbortController()
    this.poll()
  }

  private async poll(): Promise<void> {
    while (this.connected || this._connecting) {
      if (!this.currentIndex || !this.currentOffset) break
      if (this.pollAbortController?.signal.aborted) break

      try {
        const url = new URL(
          `${this.baseUrl}/docs/${this.docId}/updates/${this.currentIndex.updates_stream}`
        )
        url.searchParams.set(`offset`, this.currentOffset)
        url.searchParams.set(`live`, `long-poll`)

        const response = await this.fetch(url.toString(), {
          signal: this.pollAbortController?.signal,
        })

        if (this.pollAbortController?.signal.aborted) break

        if (response.status === 404) {
          // Compaction happened - re-fetch index and restart
          await this.handleCompaction()
          continue
        }

        if (!response.ok) {
          throw new Error(`Poll failed: ${response.status}`)
        }

        const data = new Uint8Array(await response.arrayBuffer())
        this.applyUpdates(data)

        this.currentOffset =
          response.headers.get(`Stream-Next-Offset`) ?? this.currentOffset
        this.synced = true
      } catch (err) {
        if (this.pollAbortController?.signal.aborted) break
        if (this.isNotFoundError(err)) {
          await this.handleCompaction()
          continue
        }
        console.error(`[YjsProvider] Poll error:`, err)
        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }

  // ---- Compaction handling ----

  private async handleCompaction(): Promise<void> {
    if (this.debug) {
      console.debug(`[YjsProvider] Compaction detected, re-fetching index`)
    }

    try {
      this.currentIndex = await this.fetchIndex()
      await this.initialSync()
    } catch (err) {
      console.error(`[YjsProvider] Failed to handle compaction:`, err)
      throw err
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
    if (!this.connected || this.sendingChanges) return

    this.sendingChanges = true
    this.synced = false

    try {
      while (this.pendingChanges && this.pendingChanges.length > 0) {
        const toSend = this.pendingChanges
        this.pendingChanges = null

        const url = `${this.baseUrl}/docs/${this.docId}`
        // Convert Uint8Array to ArrayBuffer for fetch body
        const bodyBuffer = new ArrayBuffer(toSend.length)
        new Uint8Array(bodyBuffer).set(toSend)
        const response = await this.fetch(url, {
          method: `POST`,
          headers: { "content-type": `application/octet-stream` },
          body: bodyBuffer,
        })

        if (!response.ok) {
          // Re-batch the failed update
          this.batchUpdate(toSend)
          throw new Error(`Failed to send update: ${response.status}`)
        }
      }
      this.synced = true
    } catch (err) {
      console.error(`[YjsProvider] Failed to send changes:`, err)
      this.emit(`error`, [err instanceof Error ? err : new Error(String(err))])
      // Reconnect to recover
      this.disconnect()
      this.connect()
    } finally {
      this.sendingChanges = false
    }
  }

  // ---- Awareness ----

  private startAwareness(): void {
    if (!this.awareness) return

    // Broadcast initial presence
    this.broadcastAwareness()

    // Start heartbeat
    this.awarenessHeartbeat = setInterval(() => {
      this.broadcastAwareness()
    }, AWARENESS_HEARTBEAT_INTERVAL)

    // Start polling for presence updates
    this.pollAwareness()
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
      const encoder = encoding.createEncoder()
      encoding.writeVarUint8Array(encoder, encoded)
      const presenceData = encoding.toUint8Array(encoder)
      const bodyBuffer = new ArrayBuffer(presenceData.length)
      new Uint8Array(bodyBuffer).set(presenceData)

      const url = `${this.baseUrl}/docs/${this.docId}/presence`
      this.fetch(url, {
        method: `POST`,
        headers: { "content-type": `application/octet-stream` },
        body: bodyBuffer,
      }).catch(() => {})
    } catch {
      // Ignore errors during disconnect
    }
  }

  private async sendAwareness(): Promise<void> {
    if (!this.awareness || !this.connected || this.sendingAwareness) return

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
        const encoder = encoding.createEncoder()
        encoding.writeVarUint8Array(encoder, encoded)
        const awarenessData = encoding.toUint8Array(encoder)
        const awarenessBuffer = new ArrayBuffer(awarenessData.length)
        new Uint8Array(awarenessBuffer).set(awarenessData)

        if (this.debug) {
          console.debug(
            `[YjsProvider] Sending awareness for clients:`,
            changedClients,
            `data size:`,
            awarenessData.length
          )
        }

        const url = `${this.baseUrl}/docs/${this.docId}/presence`
        const response = await this.fetch(url, {
          method: `POST`,
          headers: { "content-type": `application/octet-stream` },
          body: awarenessBuffer,
        })

        if (this.debug) {
          console.debug(
            `[YjsProvider] Awareness POST response:`,
            response.status
          )
        }
      }
    } catch (err) {
      console.error(`[YjsProvider] Failed to send awareness:`, err)
    } finally {
      this.sendingAwareness = false
    }
  }

  private async pollAwareness(): Promise<void> {
    if (!this.awareness) return

    // Start polling from the beginning to not miss any presence updates
    // Use regular polling with short interval (more reliable than long-poll for ephemeral data)
    let offset = `-1`
    const pollInterval = 200

    if (this.debug) {
      console.debug(
        `[YjsProvider] Starting awareness poll with offset:`,
        offset
      )
    }

    while (this.connected || this._connecting) {
      try {
        const url = new URL(`${this.baseUrl}/docs/${this.docId}/presence`)
        url.searchParams.set(`offset`, offset)

        if (this.debug) {
          console.debug(
            `[YjsProvider] Awareness poll request: offset=${offset}`
          )
        }

        const response = await this.fetch(url.toString(), {
          signal: this.pollAbortController?.signal,
        })

        if (this.debug) {
          console.debug(
            `[YjsProvider] Awareness poll response: status=${response.status}`
          )
        }

        if (this.pollAbortController?.signal.aborted) break

        if (response.ok) {
          const data = new Uint8Array(await response.arrayBuffer())
          if (this.debug) {
            console.debug(
              `[YjsProvider] Awareness poll received:`,
              data.length,
              `bytes, next offset:`,
              response.headers.get(`Stream-Next-Offset`)
            )
          }
          if (data.length > 0) {
            const decoder = decoding.createDecoder(data)
            while (decoding.hasContent(decoder)) {
              try {
                const update = decoding.readVarUint8Array(decoder)
                if (this.debug) {
                  console.debug(
                    `[YjsProvider] Applying awareness update:`,
                    update.length,
                    `bytes`
                  )
                }
                awarenessProtocol.applyAwarenessUpdate(
                  this.awareness,
                  update,
                  `server`
                )
              } catch (err) {
                if (this.debug) {
                  console.debug(`[YjsProvider] Invalid awareness update:`, err)
                }
                break
              }
            }
          }
          offset = response.headers.get(`Stream-Next-Offset`) ?? offset
        }

        // Short polling interval for presence (ephemeral data)
        await new Promise((resolve) => setTimeout(resolve, pollInterval))
      } catch (err) {
        if (this.pollAbortController?.signal.aborted) break
        console.error(`[YjsProvider] Awareness poll error:`, err)
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }

  // ---- Helpers ----

  private async fetch(url: string, options?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {}

    // Copy headers from options if provided
    if (options?.headers) {
      Object.assign(headers, options.headers)
    }

    // Resolve dynamic headers
    for (const [key, value] of Object.entries(this.headers)) {
      if (typeof value === `function`) {
        headers[key] = await value()
      } else if (typeof value === `string`) {
        headers[key] = value
      }
    }

    return fetch(url, {
      ...options,
      headers,
      signal: options?.signal ?? this.abortController?.signal,
    })
  }

  private isNotFoundError(err: unknown): boolean {
    return err instanceof Error && err.message.includes(`404`)
  }
}
