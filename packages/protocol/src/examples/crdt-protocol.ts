/**
 * CRDT Protocol - A protocol for collaborative CRDT-based documents.
 *
 * This protocol provides a foundation for synchronizing CRDT documents
 * like Yjs or Automerge through durable streams.
 *
 * Features:
 * - Document lifecycle management (create, delete)
 * - Update broadcasting via durable streams
 * - Awareness/presence support
 * - Optional snapshot compaction
 *
 * Use cases:
 * - Real-time collaborative text editing
 * - Multiplayer application state
 * - Offline-first sync
 *
 * @example
 * ```typescript
 * const crdt = createCRDTProtocol({
 *   namespace: '/yjs',
 *   // Yjs-specific serialization
 *   serializeSnapshot: (updates) => Y.mergeUpdates(updates),
 * })
 * await dispatcher.register(crdt)
 *
 * // Client creates a document
 * await fetch('/yjs/docs/my-doc', { method: 'PUT' })
 *
 * // Client sends updates
 * await fetch('/yjs/docs/my-doc/updates', {
 *   method: 'POST',
 *   body: yjsUpdate
 * })
 *
 * // Client subscribes to updates
 * const stream = await durableStream({
 *   url: '/v1/stream/yjs/docs/my-doc/updates',
 *   live: 'sse'
 * })
 * ```
 */

import type {
  Protocol,
  ProtocolRequest,
  ProtocolResponse,
  StreamContext,
  StreamInfo,
} from "../types"
import {
  defineProtocol,
  jsonResponse,
  errorResponse,
  catchErrors,
} from "../helpers"

/**
 * Document metadata stored in the metadata stream.
 */
export interface DocumentMetadata {
  /** Document ID */
  id: string

  /** When the document was created */
  createdAt: number

  /** Last update timestamp */
  updatedAt: number

  /** Number of updates */
  updateCount: number

  /** Custom metadata */
  meta?: Record<string, unknown>
}

/**
 * Awareness/presence update.
 */
export interface AwarenessUpdate {
  /** Client ID */
  clientId: string

  /** Awareness state (e.g., cursor position, selection) */
  state: Record<string, unknown> | null

  /** Timestamp */
  timestamp: number
}

/**
 * Options for the CRDT protocol.
 */
export interface CRDTProtocolOptions {
  /** Namespace for this protocol (default: "/crdt") */
  namespace?: string

  /**
   * Function to merge multiple updates into a single snapshot.
   * Used for compaction. If not provided, compaction is disabled.
   */
  mergeUpdates?: (updates: Uint8Array[]) => Uint8Array

  /**
   * Number of updates before suggesting compaction (default: 500)
   */
  compactionThreshold?: number

  /**
   * Whether to store binary updates (true) or base64-encoded JSON (false).
   * Default: true (binary)
   */
  binaryMode?: boolean

  /**
   * TTL for awareness streams in seconds (default: 60)
   * Awareness data is ephemeral and can be discarded.
   */
  awarenessTTL?: number
}

/**
 * Create a CRDT protocol handler.
 */
export function createCRDTProtocol(
  options: CRDTProtocolOptions = {}
): Protocol {
  const {
    namespace = `/crdt`,
    mergeUpdates,
    compactionThreshold = 500,
    binaryMode = true,
    awarenessTTL = 60,
  } = options

  // Track document metadata
  const documents = new Map<string, DocumentMetadata>()

  return defineProtocol({
    name: `crdt`,
    namespace: `${namespace}/*`,

    handle: catchErrors(async (request, context) => {
      const pathParts = request.subpath.split(`/`).filter(Boolean)
      const command = pathParts[0]

      switch (command) {
        case `docs`:
          return handleDocs(request, context, pathParts.slice(1), documents, {
            mergeUpdates,
            compactionThreshold,
            binaryMode,
            awarenessTTL,
          })

        case `list`:
          return handleList(documents)

        default:
          // Pass through to default handler
          return undefined
      }
    }),

    hooks: {
      async onStreamCreated(info: StreamInfo) {
        // Track documents when their update stream is created
        if (info.path.includes(`/updates`)) {
          const docId = extractDocId(info.path)
          if (docId && !documents.has(docId)) {
            documents.set(docId, {
              id: docId,
              createdAt: info.createdAt,
              updatedAt: info.createdAt,
              updateCount: 0,
            })
          }
        }
      },

      async onStreamDeleted(path: string) {
        // Clean up document tracking when deleted
        const docId = extractDocId(path)
        if (docId) {
          documents.delete(docId)
        }
      },
    },
  })
}

function extractDocId(path: string): string | null {
  // Extract doc ID from paths like /crdt/docs/my-doc/updates
  const match = path.match(/\/docs\/([^/]+)/)
  return match?.[1] ?? null
}

async function handleDocs(
  request: ProtocolRequest,
  context: StreamContext,
  pathParts: string[],
  documents: Map<string, DocumentMetadata>,
  options: {
    mergeUpdates?: (updates: Uint8Array[]) => Uint8Array
    compactionThreshold: number
    binaryMode: boolean
    awarenessTTL: number
  }
): Promise<ProtocolResponse | undefined> {
  const docId = pathParts[0]
  const subCommand = pathParts[1]

  if (!docId) {
    // List all documents
    if (request.method === `GET`) {
      return handleList(documents)
    }
    return errorResponse(`Document ID required`, 400)
  }

  // Handle subcommands
  switch (subCommand) {
    case `updates`:
      return handleUpdates(request, context, docId, documents, options)

    case `awareness`:
      return handleAwareness(request, context, docId, options)

    case `snapshot`:
      return handleSnapshot(request, context, docId, documents, options)

    case `compact`:
      return handleCompact(request, context, docId, documents, options)

    case undefined:
      // Document-level operations
      return handleDocument(request, context, docId, documents)

    default:
      return undefined
  }
}

function handleList(
  documents: Map<string, DocumentMetadata>
): ProtocolResponse {
  const docs = Array.from(documents.values())
  return jsonResponse({ documents: docs })
}

async function handleDocument(
  request: ProtocolRequest,
  context: StreamContext,
  docId: string,
  documents: Map<string, DocumentMetadata>
): Promise<ProtocolResponse> {
  const updatesPath = `docs/${docId}/updates`

  switch (request.method) {
    case `GET`: {
      const doc = documents.get(docId)
      if (!doc) {
        return errorResponse(`Document not found`, 404)
      }
      return jsonResponse(doc)
    }

    case `PUT`: {
      // Create document (idempotent)
      const exists = await context.has(updatesPath)
      if (!exists) {
        await context.create(updatesPath, {
          contentType: `application/octet-stream`,
        })

        const now = Date.now()
        documents.set(docId, {
          id: docId,
          createdAt: now,
          updatedAt: now,
          updateCount: 0,
        })
      }

      return jsonResponse(documents.get(docId), exists ? 200 : 201)
    }

    case `DELETE`: {
      // Delete document and all its streams
      const exists = await context.has(updatesPath)
      if (!exists) {
        return errorResponse(`Document not found`, 404)
      }

      // Delete updates stream
      await context.delete(updatesPath)

      // Delete awareness stream if exists
      const awarenessPath = `docs/${docId}/awareness`
      if (await context.has(awarenessPath)) {
        await context.delete(awarenessPath)
      }

      // Delete snapshot stream if exists
      const snapshotPath = `docs/${docId}/snapshot`
      if (await context.has(snapshotPath)) {
        await context.delete(snapshotPath)
      }

      documents.delete(docId)

      return { status: 204 }
    }

    default:
      return errorResponse(`Method not allowed`, 405)
  }
}

async function handleUpdates(
  request: ProtocolRequest,
  context: StreamContext,
  docId: string,
  documents: Map<string, DocumentMetadata>,
  options: {
    compactionThreshold: number
    binaryMode: boolean
  }
): Promise<ProtocolResponse | undefined> {
  const updatesPath = `docs/${docId}/updates`

  switch (request.method) {
    case `POST`: {
      // Append update
      if (!request.body || request.body.length === 0) {
        return errorResponse(`Update body required`, 400)
      }

      // Ensure document exists
      const exists = await context.has(updatesPath)
      if (!exists) {
        // Auto-create document
        await context.create(updatesPath, {
          contentType: `application/octet-stream`,
        })

        const now = Date.now()
        documents.set(docId, {
          id: docId,
          createdAt: now,
          updatedAt: now,
          updateCount: 0,
        })
      }

      // Store update
      let data: Uint8Array | string
      if (options.binaryMode) {
        data = request.body
      } else {
        // Base64 encode for JSON storage
        data = JSON.stringify({
          data: btoa(String.fromCharCode(...request.body)),
          timestamp: Date.now(),
        })
      }

      const message = await context.append(updatesPath, data)

      // Update metadata
      const doc = documents.get(docId)
      if (doc) {
        doc.updatedAt = Date.now()
        doc.updateCount++
      }

      // Check if compaction is suggested
      const suggestCompaction = doc && doc.updateCount >= options.compactionThreshold

      return jsonResponse({
        offset: message.offset,
        updateCount: doc?.updateCount ?? 1,
        suggestCompaction,
      })
    }

    case `GET`:
      // Pass through to default stream handler for reading
      return undefined

    default:
      return errorResponse(`Method not allowed`, 405)
  }
}

async function handleAwareness(
  request: ProtocolRequest,
  context: StreamContext,
  docId: string,
  options: { awarenessTTL: number }
): Promise<ProtocolResponse | undefined> {
  const awarenessPath = `docs/${docId}/awareness`

  switch (request.method) {
    case `POST`: {
      // Update awareness state
      if (!request.body || request.body.length === 0) {
        return errorResponse(`Awareness update required`, 400)
      }

      // Ensure stream exists (ephemeral with TTL)
      const exists = await context.has(awarenessPath)
      if (!exists) {
        await context.create(awarenessPath, {
          contentType: `application/json`,
          ttlSeconds: options.awarenessTTL,
        })
      }

      // Parse awareness update
      let update: AwarenessUpdate
      try {
        const text = new TextDecoder().decode(request.body)
        update = JSON.parse(text) as AwarenessUpdate
      } catch {
        return errorResponse(`Invalid awareness update`, 400)
      }

      // Add timestamp if not present
      update.timestamp = update.timestamp ?? Date.now()

      const message = await context.append(awarenessPath, update)

      return jsonResponse({
        offset: message.offset,
      })
    }

    case `GET`:
      // Pass through to default stream handler
      return undefined

    default:
      return errorResponse(`Method not allowed`, 405)
  }
}

async function handleSnapshot(
  request: ProtocolRequest,
  context: StreamContext,
  docId: string,
  documents: Map<string, DocumentMetadata>,
  options: { binaryMode: boolean }
): Promise<ProtocolResponse | undefined> {
  const snapshotPath = `docs/${docId}/snapshot`

  switch (request.method) {
    case `PUT`: {
      // Store a new snapshot
      if (!request.body || request.body.length === 0) {
        return errorResponse(`Snapshot body required`, 400)
      }

      // Delete existing snapshot if any
      if (await context.has(snapshotPath)) {
        await context.delete(snapshotPath)
      }

      // Create new snapshot stream
      let data: Uint8Array | string
      if (options.binaryMode) {
        data = request.body
      } else {
        data = JSON.stringify({
          data: btoa(String.fromCharCode(...request.body)),
          timestamp: Date.now(),
        })
      }

      await context.create(snapshotPath, {
        contentType: `application/octet-stream`,
        initialData: data,
      })

      return jsonResponse({ created: true })
    }

    case `GET`:
      // Pass through to default stream handler
      return undefined

    default:
      return errorResponse(`Method not allowed`, 405)
  }
}

async function handleCompact(
  request: ProtocolRequest,
  context: StreamContext,
  docId: string,
  documents: Map<string, DocumentMetadata>,
  options: { mergeUpdates?: (updates: Uint8Array[]) => Uint8Array; binaryMode: boolean }
): Promise<ProtocolResponse> {
  if (request.method !== `POST`) {
    return errorResponse(`Method not allowed`, 405)
  }

  if (!options.mergeUpdates) {
    return errorResponse(`Compaction not supported (no mergeUpdates function)`, 501)
  }

  const updatesPath = `docs/${docId}/updates`
  const snapshotPath = `docs/${docId}/snapshot`

  // Read all updates
  const result = await context.read(updatesPath, { offset: `-1` })

  if (result.messages.length < 2) {
    return jsonResponse({ compacted: false, reason: `Not enough updates` })
  }

  // Extract binary updates
  const updates = result.messages.map((m) => {
    if (options.binaryMode) {
      return m.data
    } else {
      // Decode from base64 JSON
      const json = JSON.parse(new TextDecoder().decode(m.data)) as { data: string }
      return Uint8Array.from(atob(json.data), (c) => c.charCodeAt(0))
    }
  })

  // Merge updates
  const merged = options.mergeUpdates(updates)

  // Store as new snapshot
  if (await context.has(snapshotPath)) {
    await context.delete(snapshotPath)
  }

  let snapshotData: Uint8Array | string
  if (options.binaryMode) {
    snapshotData = merged
  } else {
    snapshotData = JSON.stringify({
      data: btoa(String.fromCharCode(...merged)),
      timestamp: Date.now(),
      compactedFrom: result.messages.length,
    })
  }

  await context.create(snapshotPath, {
    contentType: `application/octet-stream`,
    initialData: snapshotData,
  })

  // Reset update count
  const doc = documents.get(docId)
  if (doc) {
    doc.updateCount = 0
  }

  return jsonResponse({
    compacted: true,
    updatesCompacted: result.messages.length,
    snapshotSize: merged.length,
  })
}
