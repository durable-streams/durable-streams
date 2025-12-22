/**
 * DurableStreamsProvider - Yjs provider for Durable Streams.
 *
 * Synchronizes a Yjs document over durable streams, with optional
 * awareness (presence) support.
 */

import { DurableStream } from "@durable-streams/client"
import * as Y from "yjs"
import * as awarenessProtocol from "y-protocols/awareness"
import { ObservableV2 } from "lib0/observable"
import * as encoding from "lib0/encoding"
import * as decoding from "lib0/decoding"
import type {
  AwarenessUpdate,
  DurableStreamsProviderEvents,
  DurableStreamsProviderOptions,
} from "./types"

const BINARY_CONTENT_TYPE = `application/octet-stream`
const AWARENESS_HEARTBEAT_INTERVAL = 15000 // 15 seconds

/**
 * Provider for synchronizing Yjs documents over Durable Streams.
 *
 * @example
 * ```typescript
 * import { DurableStreamsProvider } from 'y-durable-streams'
 * import * as Y from 'yjs'
 * import { Awareness } from 'y-protocols/awareness'
 *
 * const doc = new Y.Doc()
 * const awareness = new Awareness(doc)
 *
 * const provider = new DurableStreamsProvider({
 *   doc,
 *   documentStream: {
 *     url: 'http://localhost:4437/v1/stream/rooms/my-room',
 *   },
 *   awarenessStream: {
 *     url: 'http://localhost:4437/v1/streams/presence/my-room',
 *     protocol: awareness,
 *   },
 * })
 *
 * provider.on('synced', (synced) => {
 *   console.log('Synced:', synced)
 * })
 * ```
 */
export class DurableStreamsProvider extends ObservableV2<DurableStreamsProviderEvents> {
  readonly doc: Y.Doc
  private readonly documentStreamConfig: DurableStreamsProviderOptions[`documentStream`]
  private readonly awarenessStreamConfig?: DurableStreamsProviderOptions[`awarenessStream`]

  private documentStream: DurableStream | null = null
  private awarenessStream: DurableStream | null = null

  private _connected = false
  private _synced = false
  private awarenessReady = false

  private sendingDocumentChanges = false
  private pendingDocumentChanges: Uint8Array | null = null

  private sendingAwarenessUpdate = false
  private pendingAwarenessUpdate: AwarenessUpdate | null = null

  private abortController: AbortController | null = null
  private unsubscribeDocument: (() => void) | null = null
  private unsubscribeAwareness: (() => void) | null = null
  private awarenessHeartbeatInterval: ReturnType<typeof setInterval> | null =
    null

  constructor(options: DurableStreamsProviderOptions) {
    super()
    this.doc = options.doc
    this.documentStreamConfig = options.documentStream
    this.awarenessStreamConfig = options.awarenessStream

    // Listen for local document updates
    this.doc.on(`update`, this.handleDocumentUpdate)

    // Listen for awareness updates if configured
    if (this.awarenessStreamConfig) {
      this.awarenessStreamConfig.protocol.on(
        `update`,
        this.handleAwarenessUpdate
      )
    }

    // Auto-connect unless explicitly disabled
    if (options.connect !== false) {
      this.connect()
    }
  }

  // ---- State getters ----

  /**
   * Whether the provider is fully synced with the server.
   * True when all local changes have been sent and all remote changes received.
   */
  get synced(): boolean {
    return this._synced
  }

  private set synced(state: boolean) {
    if (this._synced !== state) {
      this._synced = state
      this.emit(`synced`, [state])
    }
  }

  /**
   * Whether the provider is connected to the server.
   */
  get connected(): boolean {
    return this._connected
  }

  private set connected(state: boolean) {
    if (this._connected !== state) {
      this._connected = state
      this.emit(`status`, [state ? `connected` : `disconnected`])
      if (state) {
        this.sendDocumentChanges()
      }
    }
  }

  /**
   * The Awareness protocol instance, if configured.
   */
  get awareness(): awarenessProtocol.Awareness | undefined {
    return this.awarenessStreamConfig?.protocol
  }

  // ---- Connection management ----

  /**
   * Connect to the durable streams and start synchronization.
   */
  async connect(): Promise<void> {
    if (this.connected) return

    this.abortController = new AbortController()
    this.emit(`status`, [`connecting`])

    try {
      await this.connectDocumentStream()
      if (this.abortController.signal.aborted) return

      if (this.awarenessStreamConfig) {
        await this.connectAwarenessStream()
      }
    } catch (err) {
      if (!this.abortController.signal.aborted) {
        this.emit(`error`, [
          err instanceof Error ? err : new Error(String(err)),
        ])
        this.disconnect()
      }
    }
  }

  /**
   * Disconnect from the durable streams and stop synchronization.
   */
  disconnect(): void {
    if (!this.abortController) return

    // Clean up awareness heartbeat
    if (this.awarenessHeartbeatInterval) {
      clearInterval(this.awarenessHeartbeatInterval)
      this.awarenessHeartbeatInterval = null
    }

    // Clean up awareness state
    if (this.awarenessStreamConfig) {
      awarenessProtocol.removeAwarenessStates(
        this.awarenessStreamConfig.protocol,
        [this.awarenessStreamConfig.protocol.clientID],
        `local`
      )
    }

    // Abort pending operations
    this.abortController.abort()
    this.abortController = null

    // Unsubscribe from streams
    this.unsubscribeDocument?.()
    this.unsubscribeAwareness?.()
    this.unsubscribeDocument = null
    this.unsubscribeAwareness = null

    // Clear streams
    this.documentStream = null
    this.awarenessStream = null

    // Clear pending state
    this.pendingAwarenessUpdate = null
    this.awarenessReady = false

    // Update state
    this.connected = false
    this.synced = false
  }

  /**
   * Destroy the provider and clean up all resources.
   * This removes event listeners and disconnects from streams.
   */
  destroy(): void {
    this.disconnect()
    this.doc.off(`update`, this.handleDocumentUpdate)
    if (this.awarenessStreamConfig) {
      this.awarenessStreamConfig.protocol.off(
        `update`,
        this.handleAwarenessUpdate
      )
    }
    super.destroy()
  }

  // ---- Document stream ----

  private async connectDocumentStream(): Promise<void> {
    if (this.abortController?.signal.aborted) return

    const url =
      typeof this.documentStreamConfig.url === `string`
        ? this.documentStreamConfig.url
        : this.documentStreamConfig.url.href

    // Try to create the stream, or connect if it exists
    try {
      this.documentStream = await DurableStream.create({
        url,
        contentType: BINARY_CONTENT_TYPE,
        headers: this.documentStreamConfig.headers,
        signal: this.abortController!.signal,
      })
    } catch {
      if (this.abortController?.signal.aborted) return
      this.documentStream = new DurableStream({
        url,
        contentType: BINARY_CONTENT_TYPE,
        headers: this.documentStreamConfig.headers,
        signal: this.abortController!.signal,
      })
    }

    if (this.abortController?.signal.aborted) return

    // Start streaming from the beginning
    const response = await this.documentStream.stream({
      offset: `-1`,
      live: `long-poll`,
    })

    if (this.abortController?.signal.aborted) return

    // Subscribe to incoming document updates
    this.unsubscribeDocument = response.subscribeBytes((chunk) => {
      if (this.abortController?.signal.aborted) return

      // Apply updates from the server (lib0 VarUint8Array framing)
      if (chunk.data.length > 0) {
        const decoder = decoding.createDecoder(chunk.data)
        while (decoding.hasContent(decoder)) {
          try {
            const update = decoding.readVarUint8Array(decoder)
            Y.applyUpdate(this.doc, update, `server`)
          } catch {
            // Ignore invalid updates
            break
          }
        }
      }

      // Handle up-to-date signal
      if (chunk.upToDate) {
        if (!this.sendingDocumentChanges) {
          this.synced = true
        }
        this.connected = true
      }
    })
  }

  // ---- Awareness stream ----

  private async connectAwarenessStream(): Promise<void> {
    if (!this.awarenessStreamConfig) return
    if (this.abortController?.signal.aborted) return

    const url =
      typeof this.awarenessStreamConfig.url === `string`
        ? this.awarenessStreamConfig.url
        : this.awarenessStreamConfig.url.href

    // Try to create the stream, or connect if it exists
    // Awareness uses binary format (same as document stream)
    try {
      this.awarenessStream = await DurableStream.create({
        url,
        contentType: BINARY_CONTENT_TYPE,
        headers: this.awarenessStreamConfig.headers,
        signal: this.abortController!.signal,
      })
    } catch {
      if (this.abortController?.signal.aborted) return
      this.awarenessStream = new DurableStream({
        url,
        contentType: BINARY_CONTENT_TYPE,
        headers: this.awarenessStreamConfig.headers,
        signal: this.abortController!.signal,
      })
    }

    if (this.abortController?.signal.aborted) return

    // Start streaming from the beginning
    const response = await this.awarenessStream.stream({
      offset: `-1`,
      live: `long-poll`,
    })

    if (this.abortController?.signal.aborted) return

    // Subscribe to incoming awareness updates (binary format)
    this.unsubscribeAwareness = response.subscribeBytes((chunk) => {
      if (this.abortController?.signal.aborted) return

      // Apply awareness updates from the server (lib0 VarUint8Array framing)
      if (chunk.data.length > 0) {
        const decoder = decoding.createDecoder(chunk.data)
        while (decoding.hasContent(decoder)) {
          try {
            const update = decoding.readVarUint8Array(decoder)
            awarenessProtocol.applyAwarenessUpdate(
              this.awarenessStreamConfig!.protocol,
              update,
              this
            )
          } catch (err) {
            console.error(
              `[y-durable-streams] Failed to apply awareness update:`,
              err
            )
            break
          }
        }
      }

      // Handle up-to-date signal - awareness stream is ready
      if (chunk.upToDate && !this.awarenessReady) {
        this.awarenessReady = true
        // Broadcast our initial awareness state
        this.broadcastAwareness()
        // Start heartbeat to keep awareness alive
        this.startAwarenessHeartbeat()
      }
    })
  }

  private startAwarenessHeartbeat(): void {
    // Clear any existing heartbeat
    if (this.awarenessHeartbeatInterval) {
      clearInterval(this.awarenessHeartbeatInterval)
    }

    // Awareness times out after 30 seconds, so heartbeat every 15 seconds
    this.awarenessHeartbeatInterval = setInterval(() => {
      if (this.awarenessReady && !this.abortController?.signal.aborted) {
        this.broadcastAwareness()
      }
    }, AWARENESS_HEARTBEAT_INTERVAL)
  }

  // ---- Document update handling ----

  private handleDocumentUpdate = (
    update: Uint8Array,
    origin: unknown
  ): void => {
    // Don't re-send updates from server
    if (origin === `server`) return

    this.batchDocumentUpdate(update)
    this.sendDocumentChanges()
  }

  private batchDocumentUpdate(update: Uint8Array): void {
    if (this.pendingDocumentChanges) {
      this.pendingDocumentChanges = Y.mergeUpdates([
        this.pendingDocumentChanges,
        update,
      ])
    } else {
      this.pendingDocumentChanges = update
    }
  }

  private async sendDocumentChanges(): Promise<void> {
    if (
      !this.connected ||
      this.sendingDocumentChanges ||
      !this.documentStream
    ) {
      return
    }

    this.sendingDocumentChanges = true
    let lastSending: Uint8Array | null = null

    try {
      while (
        this.pendingDocumentChanges &&
        this.pendingDocumentChanges.length > 0 &&
        this.connected // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- can change during async
      ) {
        lastSending = this.pendingDocumentChanges
        this.pendingDocumentChanges = null

        // Frame with lib0 VarUint8Array encoding
        const encoder = encoding.createEncoder()
        encoding.writeVarUint8Array(encoder, lastSending)
        await this.documentStream.append(encoding.toUint8Array(encoder))
        lastSending = null // Clear on success
      }
      this.synced = true
    } catch (err) {
      console.error(`[y-durable-streams] Failed to send document changes:`, err)
      // Re-batch the failed update (lastSending is always set when catch is reached)
      this.batchDocumentUpdate(lastSending!)
      this.emit(`error`, [err instanceof Error ? err : new Error(String(err))])
    } finally {
      this.sendingDocumentChanges = false
    }
  }

  // ---- Awareness update handling ----

  private handleAwarenessUpdate = (
    update: AwarenessUpdate,
    origin: unknown
  ): void => {
    if (!this.awarenessStreamConfig) return

    // Only send local updates
    if (origin === `server` || origin === this) return

    // Only send if local client changed
    const { added, updated, removed } = update
    const changedClients = added.concat(updated).concat(removed)
    if (
      !changedClients.includes(this.awarenessStreamConfig.protocol.clientID)
    ) {
      return
    }

    this.pendingAwarenessUpdate = update
    this.sendAwarenessChanges()
  }

  private broadcastAwareness(): void {
    if (!this.awarenessStreamConfig) return

    const clientID = this.awarenessStreamConfig.protocol.clientID

    this.pendingAwarenessUpdate = {
      added: [clientID],
      updated: [],
      removed: [],
    }
    this.sendAwarenessChanges()
  }

  private async sendAwarenessChanges(): Promise<void> {
    if (
      !this.awarenessReady ||
      this.sendingAwarenessUpdate ||
      !this.awarenessStream ||
      !this.awarenessStreamConfig
    ) {
      return
    }

    this.sendingAwarenessUpdate = true

    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- awarenessReady can change during async operations
      while (this.pendingAwarenessUpdate && this.awarenessReady) {
        const update = this.pendingAwarenessUpdate
        this.pendingAwarenessUpdate = null

        const { added, updated, removed } = update
        const changedClients = added.concat(updated).concat(removed)

        // Encode awareness update as binary and frame with lib0 VarUint8Array
        const encoded = awarenessProtocol.encodeAwarenessUpdate(
          this.awarenessStreamConfig.protocol,
          changedClients
        )
        const encoder = encoding.createEncoder()
        encoding.writeVarUint8Array(encoder, encoded)
        await this.awarenessStream.append(encoding.toUint8Array(encoder))
      }
    } catch (err) {
      console.error(`[y-durable-streams] Failed to send awareness:`, err)
    } finally {
      this.sendingAwarenessUpdate = false
    }
  }
}
