/**
 * Compactor - Handles Yjs document compaction.
 *
 * Compaction reduces storage by creating a new snapshot from the current
 * document state and starting a fresh updates stream. This is triggered
 * when the cumulative update size exceeds a threshold.
 *
 * The process is atomic from the client's perspective:
 * 1. Load current snapshot (if any) + all updates
 * 2. Apply updates to Y.Doc to get current state
 * 3. Encode state as new snapshot
 * 4. Create new snapshot stream
 * 5. Create new updates stream
 * 6. Update index atomically
 * 7. Delete old snapshot stream (if any)
 */

import * as Y from "yjs"
import * as decoding from "lib0/decoding"
import { YjsStreamPaths } from "./types"
import type { YjsStore } from "./yjs-store"
import type { CompactionResult, YjsIndex } from "./types"

/**
 * Handles document compaction.
 */
export class Compactor {
  private readonly store: YjsStore

  constructor(store: YjsStore) {
    this.store = store
  }

  /**
   * Trigger compaction for a document.
   * This runs in the background and should not block the request.
   */
  async triggerCompaction(service: string, docId: string): Promise<void> {
    const state = await this.store.getDocumentState(service, docId)

    // Skip if already compacting
    if (state.compacting) {
      return
    }

    try {
      this.store.setCompacting(service, docId, true)
      await this.performCompaction(service, docId)
    } finally {
      this.store.setCompacting(service, docId, false)
    }
  }

  /**
   * Perform the actual compaction.
   */
  private async performCompaction(
    service: string,
    docId: string
  ): Promise<CompactionResult> {
    const state = await this.store.getDocumentState(service, docId)
    const currentIndex = state.index

    // Create a Y.Doc and load current state
    const doc = new Y.Doc()

    try {
      // Load existing snapshot if any
      if (currentIndex.snapshot_stream) {
        const snapshot = await this.store.readSnapshot(
          service,
          docId,
          currentIndex.snapshot_stream
        )
        if (snapshot && snapshot.length > 0) {
          Y.applyUpdate(doc, snapshot)
        }
      }

      // Load all updates
      const updates = await this.store.readUpdates(service, docId, {
        offset:
          currentIndex.update_offset === -1
            ? `-1`
            : `${currentIndex.update_offset}_0`,
        live: false,
      })

      if (updates.data.length > 0) {
        // Parse and apply framed updates
        const decoder = decoding.createDecoder(updates.data)
        while (decoding.hasContent(decoder)) {
          const update = decoding.readVarUint8Array(decoder)
          Y.applyUpdate(doc, update)
        }
      }

      // Encode the current state as a snapshot
      const newSnapshot = Y.encodeStateAsUpdate(doc)

      // Create new snapshot stream
      const newSnapshotId = await this.store.writeSnapshot(
        service,
        docId,
        newSnapshot
      )

      // Generate new updates stream ID
      const newUpdatesStream = this.store.getNextUpdatesStreamId(
        currentIndex.updates_stream
      )

      // Create new updates stream
      await this.store.ensureUpdatesStream(service, docId, newUpdatesStream)

      // Update the index atomically
      const newIndex: YjsIndex = {
        snapshot_stream: newSnapshotId,
        updates_stream: newUpdatesStream,
        update_offset: -1, // Start fresh from beginning of new updates stream
      }
      await this.store.saveIndex(service, docId, newIndex)

      // Reset counters
      this.store.resetUpdateCounters(service, docId)

      // Delete old streams (in background, failures are logged but not thrown)
      this.deleteOldStreams(service, docId, currentIndex).catch((err) => {
        console.error(
          `[Compactor] Error deleting old streams for ${service}/${docId}:`,
          err
        )
      })

      const result: CompactionResult = {
        newSnapshotStream: newSnapshotId,
        newUpdatesStream,
        snapshotSizeBytes: newSnapshot.length,
        oldSnapshotStream: currentIndex.snapshot_stream,
        oldUpdatesStream: currentIndex.updates_stream,
      }

      console.log(
        `[Compactor] Compacted ${service}/${docId}: ` +
          `snapshot=${newSnapshot.length} bytes, ` +
          `old updates stream=${currentIndex.updates_stream} -> ${newUpdatesStream}`
      )

      return result
    } finally {
      doc.destroy()
    }
  }

  /**
   * Delete old snapshot and updates streams.
   */
  private async deleteOldStreams(
    service: string,
    docId: string,
    oldIndex: YjsIndex
  ): Promise<void> {
    // Delete old snapshot if it exists
    if (oldIndex.snapshot_stream) {
      const snapshotPath = YjsStreamPaths.snapshot(
        service,
        docId,
        oldIndex.snapshot_stream
      )
      await this.store.deleteStream(snapshotPath)
    }

    // Delete old updates stream
    const updatesPath = YjsStreamPaths.updates(
      service,
      docId,
      oldIndex.updates_stream
    )
    await this.store.deleteStream(updatesPath)
  }
}
