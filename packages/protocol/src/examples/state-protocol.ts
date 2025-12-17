/**
 * State Protocol - A protocol for managing state with automatic compaction.
 *
 * This protocol stores key-value state changes and can compact streams
 * by merging all changes into a single snapshot.
 *
 * Use cases:
 * - Database CDC (Change Data Capture) streams
 * - Configuration state
 * - User preferences
 */

import type {
  Protocol,
  ProtocolRequest,
  ProtocolResponse,
  StreamContext,
  StreamMessage,
  StreamInfo,
} from "../types"
import {
  defineProtocol,
  jsonResponse,
  errorResponse,
  parseJsonBody,
  catchErrors,
} from "../helpers"

/**
 * A state change event.
 */
export interface StateChange<T = unknown> {
  /** Key/ID of the record */
  key: string

  /** Operation type */
  operation: `insert` | `update` | `delete` | `upsert`

  /** New value (undefined for delete) */
  value?: T

  /** Previous value (for updates) */
  oldValue?: T

  /** Optional timestamp */
  timestamp?: number

  /** Optional transaction ID */
  txId?: string
}

/**
 * Snapshot control event for state streams.
 */
export interface SnapshotEvent<T = unknown> {
  /** Control event type */
  control: `snapshot-start` | `snapshot-end` | `reset`

  /** Full state snapshot (for snapshot-start) */
  snapshot?: Record<string, T>

  /** Offset this snapshot represents */
  offset?: string
}

/**
 * Options for the state protocol.
 */
export interface StateProtocolOptions {
  /** Namespace for this state protocol (default: "/state") */
  namespace?: string

  /** Number of changes before auto-compaction is suggested (default: 1000) */
  compactionThreshold?: number

  /** Whether to auto-compact when threshold is reached (default: false) */
  autoCompact?: boolean
}

/**
 * Create a state protocol handler.
 */
export function createStateProtocol(
  options: StateProtocolOptions = {}
): Protocol {
  const {
    namespace = `/state`,
    compactionThreshold = 1000,
    autoCompact = false,
  } = options

  // Track change counts for compaction suggestions
  const changeCounts = new Map<string, number>()

  return defineProtocol({
    name: `state`,
    namespace: `${namespace}/:collection/*`,

    handle: catchErrors(async (request, context) => {
      const collection = request.params.collection
      if (!collection) {
        return errorResponse(`Collection name required`, 400)
      }
      const subpath = request.wildcard || ``

      switch (request.method) {
        case `GET`:
          return handleGet(request, context, collection, subpath)

        case `POST`:
          return handlePost(request, context, collection, subpath, {
            compactionThreshold,
            autoCompact,
            changeCounts,
          })

        case `PUT`:
          return handlePut(request, context, collection, subpath)

        case `DELETE`:
          return handleDelete(request, context, collection, subpath)

        default:
          // Pass through to default handler
          return undefined
      }
    }),

    hooks: {
      async onStreamCreated(info: StreamInfo, context: StreamContext) {
        // Initialize change count for new streams
        changeCounts.set(info.path, 0)
      },

      async onStreamDeleted(path: string, context: StreamContext) {
        changeCounts.delete(path)
      },
    },
  })
}

async function handleGet(
  request: ProtocolRequest,
  context: StreamContext,
  collection: string,
  subpath: string
): Promise<ProtocolResponse | undefined> {
  // GET /state/:collection - list streams or get materialized state
  // GET /state/:collection/:key - get specific record

  if (!subpath) {
    // List all streams in collection or get collection state
    const materializedParam = request.url.searchParams.get(`materialized`)

    if (materializedParam === `true`) {
      // Return materialized state
      const state = await materializeState(context, collection)
      return jsonResponse(state)
    }

    // List streams in this collection
    const streams = await context.list(collection)
    return jsonResponse({
      streams: streams.map((s) => ({
        path: s.path,
        currentOffset: s.currentOffset,
        createdAt: s.createdAt,
      })),
    })
  }

  // Get specific record from stream
  const streamPath = `${collection}/${subpath}`
  const exists = await context.has(streamPath)

  if (!exists) {
    return errorResponse(`Stream not found`, 404)
  }

  // Read and materialize just this stream
  const result = await context.read(streamPath, { offset: `-1` })
  const state = materializeMessages(result.messages)

  return jsonResponse({
    state,
    offset: result.nextOffset,
    upToDate: result.upToDate,
  })
}

async function handlePost(
  request: ProtocolRequest,
  context: StreamContext,
  collection: string,
  subpath: string,
  options: {
    compactionThreshold: number
    autoCompact: boolean
    changeCounts: Map<string, number>
  }
): Promise<ProtocolResponse> {
  // POST /state/:collection/:stream - append state changes

  if (!subpath) {
    return errorResponse(`Stream path required`, 400)
  }

  const streamPath = `${collection}/${subpath}`
  const changes = parseJsonBody<StateChange | StateChange[]>(request)
  const changeArray = Array.isArray(changes) ? changes : [changes]

  // Validate changes
  for (const change of changeArray) {
    if (!change.key) {
      return errorResponse(`Each change must have a key`, 400)
    }
    if (!change.operation) {
      return errorResponse(`Each change must have an operation`, 400)
    }
  }

  // Ensure stream exists
  const exists = await context.has(streamPath)
  if (!exists) {
    await context.create(streamPath, {
      contentType: `application/json`,
    })
  }

  // Add timestamps if not present
  const now = Date.now()
  const timestampedChanges = changeArray.map((c) => ({
    ...c,
    timestamp: c.timestamp ?? now,
  }))

  // Append changes
  const message = await context.append(streamPath, timestampedChanges)

  // Track change count
  const fullPath = context.namespace + `/` + streamPath
  const count = (options.changeCounts.get(fullPath) || 0) + changeArray.length
  options.changeCounts.set(fullPath, count)

  // Check if compaction is suggested
  const suggestCompaction = count >= options.compactionThreshold

  // Auto-compact if enabled
  if (suggestCompaction && options.autoCompact) {
    const compactionResult = await context.compact(streamPath, (messages) => {
      const state = materializeMessages(messages)
      return {
        control: `snapshot-start`,
        snapshot: state,
        offset: messages[messages.length - 1]?.offset,
      } as SnapshotEvent
    })

    if (compactionResult) {
      options.changeCounts.set(fullPath, 0)
      return jsonResponse({
        offset: message.offset,
        compacted: true,
        newStream: compactionResult.newStream.path,
      })
    }
  }

  return jsonResponse({
    offset: message.offset,
    count,
    suggestCompaction,
  })
}

async function handlePut(
  request: ProtocolRequest,
  context: StreamContext,
  collection: string,
  subpath: string
): Promise<ProtocolResponse> {
  // PUT /state/:collection/:stream - create stream or reset with snapshot

  if (!subpath) {
    return errorResponse(`Stream path required`, 400)
  }

  const streamPath = `${collection}/${subpath}`
  const body = parseJsonBody<{ snapshot?: Record<string, unknown> }>(request)

  // Create or reset stream
  const exists = await context.has(streamPath)
  if (exists) {
    await context.delete(streamPath)
  }

  // Create with optional initial snapshot
  const initialData = body.snapshot
    ? ({
        control: `snapshot-start`,
        snapshot: body.snapshot,
      } as SnapshotEvent)
    : undefined

  const info = await context.create(streamPath, {
    contentType: `application/json`,
    initialData,
  })

  return jsonResponse({
    path: info.path,
    offset: info.currentOffset,
    created: !exists,
  }, exists ? 200 : 201)
}

async function handleDelete(
  request: ProtocolRequest,
  context: StreamContext,
  collection: string,
  subpath: string
): Promise<ProtocolResponse> {
  // DELETE /state/:collection/:stream - delete stream

  if (!subpath) {
    return errorResponse(`Stream path required`, 400)
  }

  const streamPath = `${collection}/${subpath}`
  const exists = await context.has(streamPath)

  if (!exists) {
    return errorResponse(`Stream not found`, 404)
  }

  await context.delete(streamPath)

  return { status: 204 }
}

/**
 * Materialize state from a list of messages.
 */
function materializeMessages(messages: StreamMessage[]): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  const decoder = new TextDecoder()

  for (const message of messages) {
    const text = decoder.decode(message.data)

    // Handle JSON array format (stored with trailing comma)
    let parsed: unknown
    try {
      // Try parsing as array first
      const trimmed = text.trim()
      if (trimmed.endsWith(`,`)) {
        parsed = JSON.parse(`[${trimmed.slice(0, -1)}]`)
      } else {
        parsed = JSON.parse(trimmed)
      }
    } catch {
      continue
    }

    const events = Array.isArray(parsed) ? parsed : [parsed]

    for (const event of events) {
      // Handle control events
      if ((event as SnapshotEvent).control === `snapshot-start`) {
        const snapshot = (event as SnapshotEvent).snapshot
        if (snapshot) {
          Object.assign(state, snapshot)
        }
        continue
      }

      if ((event as SnapshotEvent).control === `reset`) {
        // Clear state
        for (const key of Object.keys(state)) {
          delete state[key]
        }
        continue
      }

      // Handle state changes
      const change = event as StateChange
      if (!change.key) continue

      switch (change.operation) {
        case `insert`:
        case `update`:
        case `upsert`:
          if (change.value !== undefined) {
            state[change.key] = change.value
          }
          break
        case `delete`:
          delete state[change.key]
          break
      }
    }
  }

  return state
}

/**
 * Materialize state from all streams in a collection.
 */
async function materializeState(
  context: StreamContext,
  collection: string
): Promise<Record<string, Record<string, unknown>>> {
  const streams = await context.list(collection)
  const result: Record<string, Record<string, unknown>> = {}

  for (const stream of streams) {
    // Extract stream name from path
    const name = stream.path.split(`/`).pop() || stream.path

    const readResult = await context.read(
      stream.path.replace(context.namespace, ``),
      { offset: `-1` }
    )

    result[name] = materializeMessages(readResult.messages)
  }

  return result
}

export { materializeMessages, materializeState }
