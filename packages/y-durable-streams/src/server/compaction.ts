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
 * Check if an error is a 409 Conflict (already exists) error.
 */
function isConflictExistsError(err: unknown): boolean {
  return (
    (err instanceof DurableStreamError && err.code === `CONFLICT_EXISTS`) ||
    (err instanceof FetchError && err.status === 409)
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
      const updatesUrl = `${dsServerUrl}${YjsStreamPaths.dsStream(service, docPath)}`
      const updatesStream = new DurableStream({
        url: updatesUrl,
        headers: dsHeaders,
        contentType: `application/octet-stream`,
      })

      const updatesOffset = state.snapshotOffset ?? `-1`
      let currentEndOffset = updatesOffset

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

      // Create new snapshot storage with offset-based key
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

      const oldSnapshotOffset = state.snapshotOffset

      // Write to internal index stream to persist the snapshot offset
      await this.writeIndexEntry(service, docPath, currentEndOffset)

      // Update in-memory snapshot offset
      this.server.updateSnapshotOffset(service, docPath, currentEndOffset)

      // Reset counters
      this.server.resetUpdateCounters(service, docPath)

      // Delete old snapshot if any
      if (oldSnapshotOffset) {
        this.deleteOldSnapshot(service, docPath, oldSnapshotOffset).catch(
          (err) => {
            console.error(
              `[Compactor] Error deleting old snapshot for ${service}/${docPath}:`,
              err
            )
          }
        )
      }

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
    snapshotOffset: string
  ): Promise<void> {
    const dsServerUrl = this.server.getDsServerUrl()
    const dsHeaders = this.server.getDsServerHeaders()
    const indexUrl = `${dsServerUrl}${YjsStreamPaths.indexStream(service, docPath)}`

    // Create index stream if it doesn't exist
    try {
      await DurableStream.create({
        url: indexUrl,
        headers: dsHeaders,
        contentType: `application/json`,
      })
    } catch (err) {
      if (!isConflictExistsError(err)) {
        throw err
      }
      // Stream already exists - that's fine
    }

    // Append the new index entry
    const indexEntry: YjsIndexEntry = {
      snapshotOffset,
      createdAt: Date.now(),
    }

    const stream = new DurableStream({
      url: indexUrl,
      headers: dsHeaders,
      contentType: `application/json`,
    })

    await stream.append(JSON.stringify(indexEntry) + `\n`, {
      contentType: `application/json`,
    })
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
