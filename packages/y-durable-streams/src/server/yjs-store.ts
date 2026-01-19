/**
 * YjsStore - Document storage layer wrapping the Durable Streams client.
 *
 * This module manages the underlying streams for Yjs documents:
 * - Index stream: JSON metadata pointing to current snapshot/updates
 * - Updates stream(s): Binary Yjs updates with lib0 framing
 * - Snapshot stream(s): Binary Yjs snapshots
 * - Presence stream: Binary awareness updates
 *
 * The store handles stream creation, reading, and writing, while the
 * YjsServer handles HTTP routing and compaction orchestration.
 */

import {
  DurableStream,
  DurableStreamError,
  FetchError,
} from "@durable-streams/client"
import * as encoding from "lib0/encoding"
import { YjsStreamPaths } from "./types"
import type { YjsDocumentState, YjsIndex, YjsServerOptions } from "./types"

/**
 * Check if an error is a 404 Not Found error.
 */
function isNotFoundError(err: unknown): boolean {
  return (
    (err instanceof DurableStreamError && err.code === `NOT_FOUND`) ||
    (err instanceof FetchError && err.status === 404)
  )
}

/**
 * Check if an error is a 409 Conflict (already exists) error.
 */
function isConflictExistsError(err: unknown): boolean {
  return (
    (err instanceof DurableStreamError && err.code === `CONFLICT_EXISTS`) ||
    (err instanceof FetchError && err.status === 409)
  )
}

/**
 * Default index for a new document.
 */
function createDefaultIndex(): YjsIndex {
  return {
    snapshot_stream: null,
    updates_stream: `updates-001`,
    update_offset: -1,
  }
}

/**
 * Generate a unique snapshot ID.
 */
function generateSnapshotId(): string {
  return `snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Generate the next updates stream ID.
 */
function generateNextUpdatesStream(current: string): string {
  const match = current.match(/updates-(\d+)/)
  if (!match) {
    return `updates-001`
  }
  const num = parseInt(match[1]!, 10) + 1
  return `updates-${num.toString().padStart(3, `0`)}`
}

/**
 * YjsStore manages document storage using durable streams.
 */
export class YjsStore {
  private readonly dsServerUrl: string
  private readonly dsServerHeaders: Record<string, string>

  /**
   * In-memory cache of document states.
   * Key format: "{service}/{docId}"
   */
  private readonly documentStates = new Map<string, YjsDocumentState>()

  constructor(
    options: Pick<YjsServerOptions, `dsServerUrl` | `dsServerHeaders`>
  ) {
    this.dsServerUrl = options.dsServerUrl
    this.dsServerHeaders = options.dsServerHeaders ?? {}
  }

  /**
   * Get the document state key.
   */
  private getStateKey(service: string, docId: string): string {
    return `${service}/${docId}`
  }

  /**
   * Build the full URL for a stream path.
   */
  private buildStreamUrl(path: string): string {
    return `${this.dsServerUrl}${path}`
  }

  /**
   * Get or create a document's state.
   * This loads the index from the index stream if it exists.
   */
  async getDocumentState(
    service: string,
    docId: string
  ): Promise<YjsDocumentState> {
    const key = this.getStateKey(service, docId)

    // Return cached state if available
    let state = this.documentStates.get(key)
    if (state) {
      return state
    }

    // Try to load existing index
    const index = await this.loadIndex(service, docId)

    state = {
      index: index ?? createDefaultIndex(),
      updatesSizeBytes: 0,
      updatesCount: 0,
      compacting: false,
    }

    this.documentStates.set(key, state)
    return state
  }

  /**
   * Load the index from the index stream.
   * Returns null if the document doesn't exist.
   */
  async loadIndex(service: string, docId: string): Promise<YjsIndex | null> {
    const indexPath = YjsStreamPaths.index(service, docId)
    const indexUrl = this.buildStreamUrl(indexPath)

    const stream = new DurableStream({
      url: indexUrl,
      headers: this.dsServerHeaders,
      contentType: `application/json`,
    })

    try {
      const response = await stream.stream({ offset: `-1` })
      const items = await response.json<YjsIndex>()

      if (items.length === 0) {
        return null
      }

      // Return the most recent index entry
      return items[items.length - 1]!
    } catch (err) {
      if (isNotFoundError(err)) {
        return null
      }
      throw err
    }
  }

  /**
   * Save the index to the index stream.
   * Creates the stream if it doesn't exist.
   */
  async saveIndex(
    service: string,
    docId: string,
    index: YjsIndex
  ): Promise<void> {
    const indexPath = YjsStreamPaths.index(service, docId)
    const indexUrl = this.buildStreamUrl(indexPath)

    // Try to create or connect to the stream
    let stream: DurableStream
    try {
      stream = await DurableStream.create({
        url: indexUrl,
        headers: this.dsServerHeaders,
        contentType: `application/json`,
      })
    } catch (err) {
      if (isConflictExistsError(err)) {
        stream = new DurableStream({
          url: indexUrl,
          headers: this.dsServerHeaders,
          contentType: `application/json`,
        })
      } else {
        throw err
      }
    }

    await stream.append(index, { contentType: `application/json` })

    // Update cached state
    const key = this.getStateKey(service, docId)
    const state = this.documentStates.get(key)
    if (state) {
      state.index = index
    }
  }

  /**
   * Get the current index for a document.
   * Returns null if document doesn't exist.
   */
  async getIndex(service: string, docId: string): Promise<YjsIndex | null> {
    const state = await this.getDocumentState(service, docId)

    // Check if this is a "new" document (never been written to)
    const indexPath = YjsStreamPaths.index(service, docId)
    const indexUrl = this.buildStreamUrl(indexPath)

    try {
      await DurableStream.head({ url: indexUrl, headers: this.dsServerHeaders })
      return state.index
    } catch (err) {
      if (isNotFoundError(err)) {
        // Document doesn't exist yet - return default index
        // The client will create streams on first write
        return state.index
      }
      throw err
    }
  }

  /**
   * Ensure the updates stream exists.
   */
  async ensureUpdatesStream(
    service: string,
    docId: string,
    streamId: string
  ): Promise<void> {
    const updatesPath = YjsStreamPaths.updates(service, docId, streamId)
    const updatesUrl = this.buildStreamUrl(updatesPath)

    try {
      await DurableStream.create({
        url: updatesUrl,
        headers: this.dsServerHeaders,
        contentType: `application/octet-stream`,
      })
    } catch (err) {
      if (isConflictExistsError(err)) {
        // Stream already exists, that's fine
      } else {
        throw err
      }
    }
  }

  /**
   * Append an update to the updates stream.
   * Returns the offset assigned to this update.
   */
  async appendUpdate(
    service: string,
    docId: string,
    update: Uint8Array
  ): Promise<{ offset: string }> {
    const state = await this.getDocumentState(service, docId)

    // Ensure streams exist
    await this.ensureUpdatesStream(service, docId, state.index.updates_stream)

    // Save index if this is a new document
    const indexPath = YjsStreamPaths.index(service, docId)
    const indexUrl = this.buildStreamUrl(indexPath)
    try {
      await DurableStream.head({ url: indexUrl, headers: this.dsServerHeaders })
    } catch (err) {
      if (isNotFoundError(err)) {
        await this.saveIndex(service, docId, state.index)
      } else {
        throw err
      }
    }

    // Build the updates stream URL
    const updatesPath = YjsStreamPaths.updates(
      service,
      docId,
      state.index.updates_stream
    )
    const updatesUrl = this.buildStreamUrl(updatesPath)

    const stream = new DurableStream({
      url: updatesUrl,
      headers: this.dsServerHeaders,
      contentType: `application/octet-stream`,
    })

    // Frame the update with lib0 VarUint8Array encoding
    const encoder = encoding.createEncoder()
    encoding.writeVarUint8Array(encoder, update)
    const framedUpdate = encoding.toUint8Array(encoder)

    await stream.append(framedUpdate, {
      contentType: `application/octet-stream`,
    })

    // Update state
    state.updatesSizeBytes += update.length
    state.updatesCount += 1

    // Get the current offset
    const head = await stream.head()

    return { offset: head.offset ?? `0_0` }
  }

  /**
   * Read updates from the updates stream.
   * Returns the updates as a single concatenated buffer and metadata.
   */
  async readUpdates(
    service: string,
    docId: string,
    options?: {
      offset?: string
      live?: `long-poll` | false
    }
  ): Promise<{
    data: Uint8Array
    nextOffset: string
    upToDate: boolean
  }> {
    const state = await this.getDocumentState(service, docId)
    const updatesPath = YjsStreamPaths.updates(
      service,
      docId,
      state.index.updates_stream
    )
    const updatesUrl = this.buildStreamUrl(updatesPath)

    const stream = new DurableStream({
      url: updatesUrl,
      headers: this.dsServerHeaders,
      contentType: `application/octet-stream`,
    })

    try {
      const response = await stream.stream({
        offset: options?.offset ?? `-1`,
        live: options?.live,
      })

      const data = await response.body()

      return {
        data,
        nextOffset: response.offset,
        upToDate: response.upToDate,
      }
    } catch (err) {
      if (isNotFoundError(err)) {
        // Stream doesn't exist yet, return empty
        return {
          data: new Uint8Array(0),
          nextOffset: `-1`,
          upToDate: true,
        }
      }
      throw err
    }
  }

  /**
   * Read a snapshot from a snapshot stream.
   */
  async readSnapshot(
    service: string,
    docId: string,
    snapshotId: string
  ): Promise<Uint8Array | null> {
    const snapshotPath = YjsStreamPaths.snapshot(service, docId, snapshotId)
    const snapshotUrl = this.buildStreamUrl(snapshotPath)

    const stream = new DurableStream({
      url: snapshotUrl,
      headers: this.dsServerHeaders,
      contentType: `application/octet-stream`,
    })

    try {
      const response = await stream.stream({ offset: `-1` })
      return await response.body()
    } catch (err) {
      if (isNotFoundError(err)) {
        return null
      }
      throw err
    }
  }

  /**
   * Write a snapshot to a new snapshot stream.
   */
  async writeSnapshot(
    service: string,
    docId: string,
    snapshot: Uint8Array
  ): Promise<string> {
    const snapshotId = generateSnapshotId()
    const snapshotPath = YjsStreamPaths.snapshot(service, docId, snapshotId)
    const snapshotUrl = this.buildStreamUrl(snapshotPath)

    const stream = await DurableStream.create({
      url: snapshotUrl,
      headers: this.dsServerHeaders,
      contentType: `application/octet-stream`,
    })

    await stream.append(snapshot, { contentType: `application/octet-stream` })

    return snapshotId
  }

  /**
   * Delete a stream.
   */
  async deleteStream(path: string): Promise<void> {
    const url = this.buildStreamUrl(path)

    try {
      await DurableStream.delete({ url, headers: this.dsServerHeaders })
    } catch (err) {
      if (isNotFoundError(err)) {
        // Already deleted, that's fine
      } else {
        throw err
      }
    }
  }

  /**
   * Ensure the presence stream exists.
   */
  async ensurePresenceStream(service: string, docId: string): Promise<void> {
    const presencePath = YjsStreamPaths.presence(service, docId)
    const presenceUrl = this.buildStreamUrl(presencePath)

    try {
      await DurableStream.create({
        url: presenceUrl,
        headers: this.dsServerHeaders,
        contentType: `application/octet-stream`,
      })
    } catch (err) {
      if (isConflictExistsError(err)) {
        // Stream already exists, that's fine
      } else {
        throw err
      }
    }
  }

  /**
   * Append presence data to the presence stream.
   */
  async appendPresence(
    service: string,
    docId: string,
    presence: Uint8Array
  ): Promise<void> {
    await this.ensurePresenceStream(service, docId)

    const presencePath = YjsStreamPaths.presence(service, docId)
    const presenceUrl = this.buildStreamUrl(presencePath)

    const stream = new DurableStream({
      url: presenceUrl,
      headers: this.dsServerHeaders,
      contentType: `application/octet-stream`,
    })

    await stream.append(presence, { contentType: `application/octet-stream` })
  }

  /**
   * Read presence data from the presence stream.
   */
  async readPresence(
    service: string,
    docId: string,
    options?: {
      offset?: string
      live?: `long-poll` | false
    }
  ): Promise<{
    data: Uint8Array
    nextOffset: string
    upToDate: boolean
  }> {
    const presencePath = YjsStreamPaths.presence(service, docId)
    const presenceUrl = this.buildStreamUrl(presencePath)

    const stream = new DurableStream({
      url: presenceUrl,
      headers: this.dsServerHeaders,
      contentType: `application/octet-stream`,
    })

    try {
      const response = await stream.stream({
        offset: options?.offset ?? `now`,
        live: options?.live,
      })

      const data = await response.body()

      return {
        data,
        nextOffset: response.offset,
        upToDate: response.upToDate,
      }
    } catch (err) {
      if (isNotFoundError(err)) {
        // Stream doesn't exist yet, return empty
        return {
          data: new Uint8Array(0),
          nextOffset: `now`,
          upToDate: true,
        }
      }
      throw err
    }
  }

  /**
   * Get the next updates stream ID for compaction.
   */
  getNextUpdatesStreamId(currentStreamId: string): string {
    return generateNextUpdatesStream(currentStreamId)
  }

  /**
   * Check if compaction should be triggered.
   */
  shouldTriggerCompaction(
    state: YjsDocumentState,
    compactionThreshold: number,
    minUpdatesBeforeCompaction: number
  ): boolean {
    return (
      !state.compacting &&
      state.updatesSizeBytes >= compactionThreshold &&
      state.updatesCount >= minUpdatesBeforeCompaction
    )
  }

  /**
   * Mark compaction as in progress.
   */
  setCompacting(service: string, docId: string, compacting: boolean): void {
    const key = this.getStateKey(service, docId)
    const state = this.documentStates.get(key)
    if (state) {
      state.compacting = compacting
    }
  }

  /**
   * Reset update counters after compaction.
   */
  resetUpdateCounters(service: string, docId: string): void {
    const key = this.getStateKey(service, docId)
    const state = this.documentStates.get(key)
    if (state) {
      state.updatesSizeBytes = 0
      state.updatesCount = 0
    }
  }
}
