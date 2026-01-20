/**
 * Compactor - Handles Yjs document compaction.
 *
 * Compaction creates a snapshot from the current document state.
 * The updates stream is NOT rotated - we just update the offset to mark
 * where the snapshot covers up to. New clients load snapshot + updates
 * after that offset.
 */

import * as Y from "yjs"
import * as decoding from "lib0/decoding"
import {
  DurableStream,
  DurableStreamError,
  FetchError,
} from "@durable-streams/client"
import type { CompactionResult, YjsIndex } from "./types"

/**
 * Interface for the server that the Compactor works with.
 */
export interface CompactorServer {
  getDsServerUrl: () => string
  getDsServerHeaders: () => Record<string, string>
  getDocumentState: (
    service: string,
    docId: string
  ) => { index: YjsIndex; compacting: boolean } | undefined
  /** Atomically check if compaction can start and set compacting=true if so */
  tryStartCompaction: (service: string, docId: string) => boolean
  setCompacting: (service: string, docId: string, compacting: boolean) => void
  resetUpdateCounters: (service: string, docId: string) => void
  saveIndex: (service: string, docId: string, index: YjsIndex) => Promise<void>
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
 * Generate a unique snapshot ID.
 */
function generateSnapshotId(): string {
  return `snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
  async triggerCompaction(service: string, docId: string): Promise<void> {
    // Atomically check if we can start compaction
    // This prevents race conditions where multiple triggers see compacting=false
    if (!this.server.tryStartCompaction(service, docId)) {
      return
    }

    try {
      await this.performCompaction(service, docId)
    } finally {
      this.server.setCompacting(service, docId, false)
    }
  }

  /**
   * Perform the actual compaction.
   */
  private async performCompaction(
    service: string,
    docId: string
  ): Promise<CompactionResult> {
    const state = this.server.getDocumentState(service, docId)
    if (!state) {
      throw new Error(`Document state not found for ${service}/${docId}`)
    }

    const currentIndex = state.index
    const dsServerUrl = this.server.getDsServerUrl()
    const dsHeaders = this.server.getDsServerHeaders()

    // Create a Y.Doc and load current state
    const doc = new Y.Doc()

    try {
      // Load existing snapshot if any
      if (currentIndex.snapshot_stream) {
        const snapshotUrl = `${dsServerUrl}/v1/stream/yjs/${service}/docs/${docId}/snapshots/${currentIndex.snapshot_stream}`
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

      // Load all updates and track the final offset
      const updatesUrl = `${dsServerUrl}/v1/stream/yjs/${service}/docs/${docId}/updates/${currentIndex.updates_stream}`
      const updatesStream = new DurableStream({
        url: updatesUrl,
        headers: dsHeaders,
        contentType: `application/octet-stream`,
      })

      let currentEndOffset = currentIndex.update_offset

      try {
        const response = await updatesStream.stream({
          offset: currentIndex.update_offset,
        })
        const updatesData = await response.body()

        if (updatesData.length > 0) {
          const decoder = decoding.createDecoder(updatesData)
          while (decoding.hasContent(decoder)) {
            const update = decoding.readVarUint8Array(decoder)
            Y.applyUpdate(doc, update)
          }
        }

        // Store the full padded offset string from the server
        // This ensures lexicographic comparison works correctly
        currentEndOffset = response.offset
      } catch (err) {
        if (isNotFoundError(err)) {
          console.error(
            `[Compactor] Updates stream not found for ${service}/${docId} during compaction`
          )
        }
        throw err
      }

      // Encode the current state as a snapshot
      const newSnapshot = Y.encodeStateAsUpdate(doc)

      // Create new snapshot stream
      const newSnapshotId = generateSnapshotId()
      const newSnapshotUrl = `${dsServerUrl}/v1/stream/yjs/${service}/docs/${docId}/snapshots/${newSnapshotId}`

      const snapshotStream = await DurableStream.create({
        url: newSnapshotUrl,
        headers: dsHeaders,
        contentType: `application/octet-stream`,
      })
      await snapshotStream.append(newSnapshot, {
        contentType: `application/octet-stream`,
      })

      // Update the index - SAME updates stream, new offset
      const newIndex: YjsIndex = {
        snapshot_stream: newSnapshotId,
        updates_stream: currentIndex.updates_stream, // Keep same stream
        update_offset: currentEndOffset, // Where snapshot covers up to
      }
      await this.server.saveIndex(service, docId, newIndex)

      // Reset counters
      this.server.resetUpdateCounters(service, docId)

      // Delete old snapshot only (not updates stream)
      if (currentIndex.snapshot_stream) {
        this.deleteOldSnapshot(
          dsServerUrl,
          dsHeaders,
          service,
          docId,
          currentIndex.snapshot_stream
        ).catch((err) => {
          console.error(
            `[Compactor] Error deleting old snapshot for ${service}/${docId}:`,
            err
          )
        })
      }

      const result: CompactionResult = {
        newSnapshotStream: newSnapshotId,
        newUpdatesStream: currentIndex.updates_stream, // Same stream
        snapshotSizeBytes: newSnapshot.length,
        oldSnapshotStream: currentIndex.snapshot_stream,
        oldUpdatesStream: null, // Not deleted
      }

      console.log(
        `[Compactor] Compacted ${service}/${docId}: ` +
          `snapshot=${newSnapshot.length} bytes, ` +
          `update_offset=${currentEndOffset}`
      )

      return result
    } finally {
      doc.destroy()
    }
  }

  /**
   * Delete old snapshot stream.
   */
  private async deleteOldSnapshot(
    dsServerUrl: string,
    dsHeaders: Record<string, string>,
    service: string,
    docId: string,
    snapshotStream: string
  ): Promise<void> {
    const snapshotUrl = `${dsServerUrl}/v1/stream/yjs/${service}/docs/${docId}/snapshots/${snapshotStream}`
    try {
      await DurableStream.delete({ url: snapshotUrl, headers: dsHeaders })
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err
      }
    }
  }
}
