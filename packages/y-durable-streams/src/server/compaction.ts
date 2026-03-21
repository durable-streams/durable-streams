/**
 * Compactor - Handles Yjs document compaction.
 *
 * Compaction creates a snapshot from the current document state.
 * Snapshots are stored with offset-based keys ({offset}_snapshot).
 * New clients load snapshot + updates after that offset.
 */

import * as Y from "yjs"
import * as encoding from "lib0/encoding"
import * as decoding from "lib0/decoding"
import {
  DurableStream,
  DurableStreamError,
  FetchError,
} from "@durable-streams/client"
import { YjsStreamPaths } from "./types"
import type { CompactionResult, YjsDocumentState, YjsIndexEntry } from "./types"

/**
 * Interface for the server that the Compactor works with.
 */
export interface CompactorServer {
  getDsServerUrl: () => string
  getDsServerHeaders: () => Record<string, string>
  getDocumentState: (
    service: string,
    docPath: string
  ) => YjsDocumentState | undefined
  /** Atomically check if compaction can start and set compacting=true if so */
  tryStartCompaction: (service: string, docPath: string) => boolean
  setCompacting: (service: string, docPath: string, compacting: boolean) => void
  resetUpdateCounters: (service: string, docPath: string) => void
  updateSnapshotOffset: (
    service: string,
    docPath: string,
    offset: string
  ) => void
  /** Append a JSON entry to an index stream, creating the stream if needed */
  appendToIndexStream: (
    dsPath: string,
    entry: Record<string, unknown>
  ) => Promise<void>
  /** Load the latest complete index entry for a document */
  loadLatestIndexEntry: (
    service: string,
    docPath: string
  ) => Promise<YjsIndexEntry | null>
  /** Probe whether a snapshot exists at the given offset */
  probeSnapshot: (
    service: string,
    docPath: string,
    snapshotOffset: string
  ) => Promise<boolean>
}

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
 * Handles document compaction.
 */
export class Compactor {
  private readonly server: CompactorServer

  constructor(server: CompactorServer) {
    this.server = server
  }

  /**
   * Trigger compaction for a document.
   * Uses atomic check-and-set to prevent concurrent compactions.
   */
  async triggerCompaction(service: string, docPath: string): Promise<void> {
    // Atomically check if we can start compaction
    // This prevents race conditions where multiple triggers see compacting=false
    if (!this.server.tryStartCompaction(service, docPath)) {
      return
    }

    try {
      await this.performCompaction(service, docPath)
    } finally {
      this.server.setCompacting(service, docPath, false)
    }
  }

  /**
   * Perform the actual compaction.
   *
   * Uses a write-ahead index pattern for crash resilience:
   * 1. Clean up previous cycle's old snapshot (deferred deletion)
   * 2. Write "pending" index entry (intent to create snapshot)
   * 3. Write snapshot data
   * 4. Write "complete" index entry (confirms snapshot is stored)
   * 5. Update in-memory state
   *
   * On recovery, only "complete" entries are trusted. "pending" entries
   * trigger a probe to check if the snapshot was actually written.
   */
  private async performCompaction(
    service: string,
    docPath: string
  ): Promise<CompactionResult> {
    const state = this.server.getDocumentState(service, docPath)
    if (!state) {
      throw new Error(`Document state not found for ${service}/${docPath}`)
    }

    const dsServerUrl = this.server.getDsServerUrl()
    const dsHeaders = this.server.getDsServerHeaders()

    // Step 0: Clean up previous cycle's old snapshot (deferred deletion).
    // Read the latest index entry to find any previousSnapshotOffset that
    // needs cleanup from the last compaction cycle.
    await this.cleanupDeferredSnapshot(service, docPath)

    // Create a Y.Doc and load current state
    const doc = new Y.Doc()

    try {
      // Load existing snapshot if any
      if (state.snapshotOffset) {
        const snapshotKey = YjsStreamPaths.snapshotKey(state.snapshotOffset)
        const snapshotUrl = `${dsServerUrl}${YjsStreamPaths.snapshotStream(service, docPath, snapshotKey)}`
        const stream = new DurableStream({
          url: snapshotUrl,
          headers: dsHeaders,
          contentType: `application/octet-stream`,
        })

        try {
          const response = await stream.stream({ offset: `-1` })
          const snapshot = await response.body()
          if (snapshot.length > 0) {
            Y.applyUpdate(doc, snapshot)
          }
        } catch (err) {
          if (!isNotFoundError(err)) {
            throw err
          }
        }
      }

      // Load updates since the current snapshot (or from start if none)
      // This avoids reapplying full history on each compaction.
      // When a snapshot exists, read from the offset after the snapshot
      // (snapshot was built from data up to and including snapshotOffset).
      const updatesUrl = `${dsServerUrl}${YjsStreamPaths.dsStream(service, docPath)}`
      const updatesStream = new DurableStream({
        url: updatesUrl,
        headers: dsHeaders,
        contentType: `application/octet-stream`,
      })

      const updatesOffset = state.snapshotOffset
        ? incrementOffset(state.snapshotOffset)
        : `-1`
      let currentEndOffset = state.snapshotOffset ?? `-1`

      try {
        const response = await updatesStream.stream({
          offset: updatesOffset,
        })
        const updatesData = await response.body()

        if (updatesData.length > 0) {
          // Updates are stored with lib0 framing
          const decoder = decoding.createDecoder(updatesData)
          while (decoding.hasContent(decoder)) {
            const update = decoding.readVarUint8Array(decoder)
            Y.applyUpdate(doc, update)
          }
        }

        // Store the full offset string from the server
        currentEndOffset = response.offset
      } catch (err) {
        if (isNotFoundError(err)) {
          console.error(
            `[Compactor] Updates stream not found for ${service}/${docPath} during compaction`
          )
        }
        throw err
      }

      // Encode the current state as a snapshot
      const newSnapshot = Y.encodeStateAsUpdate(doc)

      const oldSnapshotOffset = state.snapshotOffset

      // Step 1: Write "pending" index entry (write-ahead)
      await this.writeIndexEntry(service, docPath, currentEndOffset, {
        status: `pending`,
        previousSnapshotOffset: oldSnapshotOffset,
      })

      // Step 2: Create new snapshot storage with offset-based key
      const snapshotKey = YjsStreamPaths.snapshotKey(currentEndOffset)
      const newSnapshotUrl = `${dsServerUrl}${YjsStreamPaths.snapshotStream(service, docPath, snapshotKey)}`

      const snapshotStream = await DurableStream.create({
        url: newSnapshotUrl,
        headers: dsHeaders,
        contentType: `application/octet-stream`,
      })
      await snapshotStream.append(newSnapshot, {
        contentType: `application/octet-stream`,
      })

      // Step 3: Write "complete" index entry (confirms snapshot is stored)
      await this.writeIndexEntry(service, docPath, currentEndOffset, {
        status: `complete`,
        previousSnapshotOffset: oldSnapshotOffset,
      })

      // Step 4: Update in-memory snapshot offset
      this.server.updateSnapshotOffset(service, docPath, currentEndOffset)

      // Reset counters
      this.server.resetUpdateCounters(service, docPath)

      // Note: Old snapshot deletion is deferred to the next compaction cycle.
      // This ensures at least one valid snapshot always exists, even if the
      // process crashes after writing the new snapshot but before the next
      // index entry is written.

      const result: CompactionResult = {
        snapshotOffset: currentEndOffset,
        snapshotSizeBytes: newSnapshot.length,
        oldSnapshotOffset,
      }

      console.log(
        `[Compactor] Compacted ${service}/${docPath}: ` +
          `snapshot=${newSnapshot.length} bytes, ` +
          `offset=${currentEndOffset}`
      )

      return result
    } finally {
      doc.destroy()
    }
  }

  /**
   * Write a new entry to the internal index stream.
   * This persists the snapshot offset so it survives server restarts.
   */
  private async writeIndexEntry(
    service: string,
    docPath: string,
    snapshotOffset: string,
    options: {
      status: `pending` | `complete`
      previousSnapshotOffset?: string | null
    }
  ): Promise<void> {
    const indexPath = YjsStreamPaths.indexStream(service, docPath)
    const indexEntry: YjsIndexEntry = {
      snapshotOffset,
      createdAt: Date.now(),
      status: options.status,
      previousSnapshotOffset: options.previousSnapshotOffset,
    }
    await this.server.appendToIndexStream(indexPath, indexEntry)
  }

  /**
   * Clean up a snapshot that was deferred for deletion in the previous
   * compaction cycle. Reads the latest index entry and deletes the
   * previousSnapshotOffset if one exists.
   */
  private async cleanupDeferredSnapshot(
    service: string,
    docPath: string
  ): Promise<void> {
    try {
      const latestEntry = await this.server.loadLatestIndexEntry(
        service,
        docPath
      )
      if (latestEntry?.previousSnapshotOffset) {
        await this.deleteOldSnapshot(
          service,
          docPath,
          latestEntry.previousSnapshotOffset
        )
      }
    } catch (err) {
      // Cleanup is best-effort — don't block compaction
      console.error(
        `[Compactor] Error cleaning up deferred snapshot for ${service}/${docPath}:`,
        err
      )
    }
  }

  /**
   * Delete old snapshot.
   */
  private async deleteOldSnapshot(
    service: string,
    docPath: string,
    snapshotOffset: string
  ): Promise<void> {
    const dsServerUrl = this.server.getDsServerUrl()
    const dsHeaders = this.server.getDsServerHeaders()
    const snapshotKey = YjsStreamPaths.snapshotKey(snapshotOffset)
    const snapshotUrl = `${dsServerUrl}${YjsStreamPaths.snapshotStream(service, docPath, snapshotKey)}`
    try {
      await DurableStream.delete({ url: snapshotUrl, headers: dsHeaders })
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err
      }
    }
  }
}

/**
 * Increment an offset string by 1 in the sequence portion.
 * Offsets are formatted as "{timestamp}_{sequence}" with zero-padded parts.
 */
function incrementOffset(offset: string): string {
  const parts = offset.split(`_`)
  if (parts.length !== 2) return offset

  const seq = parseInt(parts[1]!, 10)
  if (isNaN(seq)) return offset

  const nextSeq = (seq + 1).toString().padStart(parts[1]!.length, `0`)
  return `${parts[0]}_${nextSeq}`
}

/**
 * Frame a Yjs update with lib0 encoding for storage.
 */
export function frameUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint8Array(encoder, update)
  return encoding.toUint8Array(encoder)
}

/**
 * Decode lib0-framed updates from a binary stream.
 */
export function decodeUpdates(data: Uint8Array): Array<Uint8Array> {
  const updates: Array<Uint8Array> = []
  if (data.length === 0) return updates

  const decoder = decoding.createDecoder(data)
  while (decoding.hasContent(decoder)) {
    updates.push(decoding.readVarUint8Array(decoder))
  }
  return updates
}
