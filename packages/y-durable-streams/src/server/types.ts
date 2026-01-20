/**
 * Server-side types for the Yjs Durable Streams Protocol.
 *
 * These types define the wire format and internal structures used by the
 * Yjs server layer that sits between clients and the durable streams server.
 */

/**
 * Index document for a Yjs document.
 * This is the main entry point for syncing - clients fetch this first
 * to discover where to read snapshots and updates.
 */
export interface YjsIndex {
  /**
   * The snapshot stream ID, or null if no snapshot exists yet.
   * Format: "snapshots/{uuid}" for the snapshot stream path suffix.
   */
  snapshot_stream: string | null

  /**
   * The updates stream ID where new updates are written.
   * Format: "updates-{number}" e.g., "updates-001".
   */
  updates_stream: string

  /**
   * The offset to start reading updates from.
   * "-1" means read from the beginning of the updates stream.
   * After compaction, this is the full padded offset string from the server.
   */
  update_offset: string
}

/**
 * Response from writing an update to a document.
 */
export interface YjsWriteResponse {
  /** The offset assigned to this update in the updates stream */
  offset: string
}

/**
 * Configuration options for the Yjs server.
 */
export interface YjsServerOptions {
  /** Port to listen on (0 for random available port) */
  port?: number

  /** Host to bind to */
  host?: string

  /** URL of the underlying durable streams server */
  dsServerUrl: string

  /**
   * Threshold in bytes for triggering compaction.
   * When cumulative update size exceeds this, a new snapshot is created.
   * @default 1048576 (1MB)
   */
  compactionThreshold?: number

  /**
   * Minimum number of updates before considering compaction.
   * Prevents compaction of small documents with few updates.
   * @default 100
   */
  minUpdatesBeforeCompaction?: number

  /**
   * Optional headers to send to the durable streams server.
   */
  dsServerHeaders?: Record<string, string>
}

/**
 * Internal state for tracking document metadata.
 */
export interface YjsDocumentState {
  /** Current index for the document */
  index: YjsIndex

  /** Cumulative size of updates since last compaction (bytes) */
  updatesSizeBytes: number

  /** Number of updates since last compaction */
  updatesCount: number

  /** Whether compaction is currently in progress */
  compacting: boolean
}

/**
 * Result from a compaction operation.
 */
export interface CompactionResult {
  /** The new snapshot stream ID */
  newSnapshotStream: string

  /** The updates stream ID (unchanged - we don't rotate streams) */
  newUpdatesStream: string

  /** Size of the new snapshot in bytes */
  snapshotSizeBytes: number

  /** Old snapshot stream ID (to be deleted), or null if first compaction */
  oldSnapshotStream: string | null

  /** Old updates stream ID, or null (we don't delete the updates stream) */
  oldUpdatesStream: string | null
}

/**
 * Internal representation of a Yjs document on the server.
 */
export interface YjsDocument {
  /** Service identifier */
  service: string

  /** Document identifier */
  docId: string

  /** Current document state */
  state: YjsDocumentState
}

/**
 * Headers used by the Yjs protocol layer.
 */
export const YJS_HEADERS = {
  /** Content offset for the next read */
  STREAM_NEXT_OFFSET: `Stream-Next-Offset`,

  /** Whether the client is caught up */
  STREAM_UP_TO_DATE: `Stream-Up-To-Date`,
} as const

/**
 * Stream path builders for consistent path generation.
 */
export const YjsStreamPaths = {
  /**
   * Get the base path for a document.
   */
  docBase(service: string, docId: string): string {
    return `/v1/stream/yjs/${service}/docs/${docId}`
  },

  /**
   * Get the path for the index stream.
   */
  index(service: string, docId: string): string {
    return `${this.docBase(service, docId)}/index`
  },

  /**
   * Get the path for an updates stream.
   */
  updates(service: string, docId: string, streamId: string): string {
    return `${this.docBase(service, docId)}/updates/${streamId}`
  },

  /**
   * Get the path for a snapshot stream.
   */
  snapshot(service: string, docId: string, snapshotId: string): string {
    return `${this.docBase(service, docId)}/snapshots/${snapshotId}`
  },

  /**
   * Get the path for an awareness stream.
   * Supports optional suffix for multiple awareness streams per document.
   * @param suffix Optional suffix like "-admin" for /awareness-admin
   */
  awareness(service: string, docId: string, suffix?: string): string {
    const base = `${this.docBase(service, docId)}/awareness`
    return suffix ? `${base}${suffix}` : base
  },
} as const
