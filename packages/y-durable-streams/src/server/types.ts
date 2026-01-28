/**
 * Server-side types for the Yjs Durable Streams Protocol.
 *
 * These types define the wire format and internal structures used by the
 * Yjs server layer that sits between clients and the durable streams server.
 */

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
  /**
   * Current snapshot offset, or null if no snapshot exists yet.
   * When set, the snapshot is available at ?offset={snapshotOffset}_snapshot
   */
  snapshotOffset: string | null

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
  /** The offset at which the snapshot was taken */
  snapshotOffset: string

  /** Size of the new snapshot in bytes */
  snapshotSizeBytes: number

  /** Previous snapshot offset (to be deleted), or null if first compaction */
  oldSnapshotOffset: string | null
}

/**
 * Index entry stored in the internal index stream.
 * Each compaction appends a new entry with the current snapshot offset.
 */
export interface YjsIndexEntry {
  /** The snapshot offset (used to construct the snapshot key) */
  snapshotOffset: string

  /** Timestamp when the snapshot was created */
  createdAt: number
}

/**
 * Internal representation of a Yjs document on the server.
 */
export interface YjsDocument {
  /** Service identifier */
  service: string

  /** Document path (can include forward slashes) */
  docPath: string

  /** Current document state */
  state: YjsDocumentState
}

/**
 * Headers used by the Yjs protocol layer (lowercase per protocol spec).
 */
export const YJS_HEADERS = {
  /** Content offset for the next read */
  STREAM_NEXT_OFFSET: `stream-next-offset`,

  /** Whether the client is caught up */
  STREAM_UP_TO_DATE: `stream-up-to-date`,

  /** Cursor for CDN collapsing */
  STREAM_CURSOR: `stream-cursor`,
} as const

/**
 * Stream path builders for consistent path generation.
 * All operations use the same document URL with query parameters.
 *
 * Internal streams use `.` prefixed segments (e.g., `.updates`, `.index`, `.snapshots`)
 * which are safe from user collisions since document paths reject `.` characters.
 */
export const YjsStreamPaths = {
  /**
   * Get the base path for a document.
   * docPath can include forward slashes (e.g., "project/chapter-1").
   */
  doc(service: string, docPath: string): string {
    return `/v1/yjs/${service}/docs/${docPath}`
  },

  /**
   * Get the underlying DS stream path for document updates.
   * Uses `.updates` suffix to avoid collisions with user document paths.
   */
  dsStream(service: string, docPath: string): string {
    return `/v1/stream/yjs/${service}/docs/${docPath}/.updates`
  },

  /**
   * Get the internal index stream path for a document.
   * This stream stores snapshot offsets and is used internally by the server.
   * Uses `.index` suffix to avoid collisions with user document paths.
   */
  indexStream(service: string, docPath: string): string {
    return `/v1/stream/yjs/${service}/docs/${docPath}/.index`
  },

  /**
   * Get the snapshot stream path for a given offset.
   * Uses `.snapshots` prefix to avoid collisions with user document paths.
   */
  snapshotStream(
    service: string,
    docPath: string,
    snapshotKey: string
  ): string {
    return `/v1/stream/yjs/${service}/docs/${docPath}/.snapshots/${snapshotKey}`
  },

  /**
   * Get the awareness stream path for a given name.
   * Uses `.awareness` prefix to avoid collisions with user document paths.
   */
  awarenessStream(service: string, docPath: string, name: string): string {
    return `/v1/stream/yjs/${service}/docs/${docPath}/.awareness/${name}`
  },

  /**
   * Get the snapshot storage key for a given offset.
   */
  snapshotKey(offset: string): string {
    return `${offset}_snapshot`
  },

  /**
   * Parse a snapshot offset from a snapshot key (e.g., "4782_snapshot" -> "4782").
   * Returns null if not a valid snapshot key.
   */
  parseSnapshotOffset(key: string): string | null {
    const match = key.match(/^(.+)_snapshot$/)
    return match ? match[1]! : null
  },
} as const

/**
 * Error codes for Yjs protocol errors.
 */
export type YjsErrorCode =
  | `INVALID_REQUEST`
  | `UNAUTHORIZED`
  | `SNAPSHOT_NOT_FOUND`
  | `DOCUMENT_NOT_FOUND`
  | `OFFSET_EXPIRED`
  | `RATE_LIMITED`

/**
 * Error response format.
 */
export interface YjsError {
  error: {
    code: YjsErrorCode
    message: string
  }
}

/**
 * Path normalization utilities.
 */
export const PathUtils = {
  /**
   * Validate and normalize a document path.
   * - URL-decodes the path first
   * - Rejects paths with ".." or "." segments
   * - Collapses double slashes
   * - Returns null if path is invalid
   */
  normalize(path: string): string | null {
    // URL-decode the path to catch encoded path traversal attempts
    let decoded: string
    try {
      decoded = decodeURIComponent(path)
    } catch {
      return null // Invalid URL encoding
    }

    // Collapse double slashes
    const normalized = decoded.replace(/\/+/g, `/`)

    // Remove leading/trailing slashes for segment analysis
    const trimmed = normalized.replace(/^\/|\/$/g, ``)

    // Check for invalid segments
    const segments = trimmed.split(`/`)
    for (const segment of segments) {
      if (segment === `..` || segment === `.`) {
        return null
      }
    }

    // Validate characters: [a-zA-Z0-9_-/]
    if (!/^[a-zA-Z0-9_\-/]*$/.test(normalized)) {
      return null
    }

    // Check max length
    if (normalized.length > 256) {
      return null
    }

    return normalized
  },
} as const
