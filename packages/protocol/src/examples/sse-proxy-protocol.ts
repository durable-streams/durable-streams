/**
 * SSE Proxy Protocol - Proxy external SSE sources through durable streams.
 *
 * This protocol allows you to:
 * 1. Register external SSE endpoints to proxy
 * 2. Durably store all SSE events
 * 3. Allow clients to replay from any point in the stream
 *
 * Use cases:
 * - Making ephemeral SSE feeds durable
 * - Adding replay capability to real-time feeds
 * - Aggregating multiple SSE sources
 *
 * @example
 * ```typescript
 * const proxy = createSSEProxyProtocol()
 * await dispatcher.register(proxy)
 *
 * // Register a source to proxy
 * await fetch('/sse-proxy/sources/github-events', {
 *   method: 'PUT',
 *   body: JSON.stringify({
 *     url: 'https://api.github.com/events',
 *     headers: { Authorization: 'token ...' }
 *   })
 * })
 *
 * // Clients can now read with replay from any offset
 * const stream = await durableStream({
 *   url: '/v1/stream/sse-proxy/sources/github-events/events',
 *   offset: savedOffset
 * })
 * ```
 */

import type {
  Protocol,
  ProtocolRequest,
  ProtocolResponse,
  StreamContext,
  SSEEvent,
} from "../types"
import {
  defineProtocol,
  jsonResponse,
  errorResponse,
  parseJsonBody,
  catchErrors,
} from "../helpers"

/**
 * Configuration for an SSE source.
 */
export interface SSESourceConfig {
  /** URL of the SSE endpoint */
  url: string

  /** Optional headers to send */
  headers?: Record<string, string>

  /** Optional reconnect delay in ms (default: 3000) */
  reconnectDelay?: number

  /** Whether to auto-start on registration (default: true) */
  autoStart?: boolean

  /** Optional event types to filter (empty = all events) */
  eventTypes?: string[]
}

/**
 * Status of an SSE source connection.
 */
export interface SSESourceStatus {
  /** Source configuration */
  config: SSESourceConfig

  /** Connection status */
  status: `connecting` | `connected` | `disconnected` | `error`

  /** Error message if status is error */
  error?: string

  /** Number of events received */
  eventCount: number

  /** Last event timestamp */
  lastEventAt?: number

  /** Stream path where events are stored */
  streamPath: string
}

/**
 * Options for the SSE proxy protocol.
 */
export interface SSEProxyProtocolOptions {
  /** Namespace for this protocol (default: "/sse-proxy") */
  namespace?: string

  /** Custom fetch function for making SSE requests */
  fetch?: typeof globalThis.fetch
}

/**
 * Create an SSE proxy protocol handler.
 */
export function createSSEProxyProtocol(
  options: SSEProxyProtocolOptions = {}
): Protocol {
  const { namespace = `/sse-proxy` } = options
  const fetchFn = options.fetch ?? globalThis.fetch

  // Track active connections
  const connections = new Map<string, {
    config: SSESourceConfig
    status: SSESourceStatus[`status`]
    error?: string
    eventCount: number
    lastEventAt?: number
    controller?: AbortController
    context?: StreamContext
  }>()

  return defineProtocol({
    name: `sse-proxy`,
    namespace: `${namespace}/*`,

    handle: catchErrors(async (request, context) => {
      const pathParts = request.subpath.split(`/`).filter(Boolean)
      const command = pathParts[0]

      switch (command) {
        case `sources`:
          return handleSources(request, context, pathParts.slice(1), connections, fetchFn)

        case `status`:
          return handleStatus(connections)

        default:
          // Pass through to default stream handler
          return undefined
      }
    }),

    hooks: {
      async onUnregister() {
        // Stop all connections on unregister
        for (const [, conn] of connections) {
          conn.controller?.abort()
        }
        connections.clear()
      },
    },
  })
}

async function handleSources(
  request: ProtocolRequest,
  context: StreamContext,
  pathParts: string[],
  connections: Map<string, {
    config: SSESourceConfig
    status: SSESourceStatus[`status`]
    error?: string
    eventCount: number
    lastEventAt?: number
    controller?: AbortController
    context?: StreamContext
  }>,
  fetchFn: typeof fetch
): Promise<ProtocolResponse | undefined> {
  const sourceId = pathParts[0]
  const subCommand = pathParts[1]

  if (!sourceId) {
    // List all sources
    if (request.method === `GET`) {
      const sources = Array.from(connections.entries()).map(([id, conn]) => ({
        id,
        ...getSourceStatus(id, conn),
      }))
      return jsonResponse({ sources })
    }
    return errorResponse(`Source ID required`, 400)
  }

  // Handle subcommands
  if (subCommand === `start`) {
    return handleStart(sourceId, connections, context, fetchFn)
  }

  if (subCommand === `stop`) {
    return handleStop(sourceId, connections)
  }

  if (subCommand === `events`) {
    // Pass through to default stream handler for reading events
    return undefined
  }

  // CRUD operations on source config
  switch (request.method) {
    case `GET`:
      return handleGetSource(sourceId, connections)

    case `PUT`:
      return handlePutSource(sourceId, request, context, connections, fetchFn)

    case `DELETE`:
      return handleDeleteSource(sourceId, context, connections)

    default:
      return undefined
  }
}

function getSourceStatus(
  sourceId: string,
  conn: {
    config: SSESourceConfig
    status: SSESourceStatus[`status`]
    error?: string
    eventCount: number
    lastEventAt?: number
  }
): SSESourceStatus {
  return {
    config: conn.config,
    status: conn.status,
    error: conn.error,
    eventCount: conn.eventCount,
    lastEventAt: conn.lastEventAt,
    streamPath: `sources/${sourceId}/events`,
  }
}

function handleGetSource(
  sourceId: string,
  connections: Map<string, {
    config: SSESourceConfig
    status: SSESourceStatus[`status`]
    error?: string
    eventCount: number
    lastEventAt?: number
  }>
): ProtocolResponse {
  const conn = connections.get(sourceId)
  if (!conn) {
    return errorResponse(`Source not found`, 404)
  }

  return jsonResponse(getSourceStatus(sourceId, conn))
}

async function handlePutSource(
  sourceId: string,
  request: ProtocolRequest,
  context: StreamContext,
  connections: Map<string, {
    config: SSESourceConfig
    status: SSESourceStatus[`status`]
    error?: string
    eventCount: number
    lastEventAt?: number
    controller?: AbortController
    context?: StreamContext
  }>,
  fetchFn: typeof fetch
): Promise<ProtocolResponse> {
  const config = parseJsonBody<SSESourceConfig>(request)

  if (!config.url) {
    return errorResponse(`URL is required`, 400)
  }

  // Stop existing connection if any
  const existing = connections.get(sourceId)
  if (existing) {
    existing.controller?.abort()
  }

  // Create events stream
  const eventsPath = `sources/${sourceId}/events`
  if (!(await context.has(eventsPath))) {
    await context.create(eventsPath, {
      contentType: `application/json`,
    })
  }

  // Register source
  connections.set(sourceId, {
    config,
    status: `disconnected`,
    eventCount: existing?.eventCount ?? 0,
    lastEventAt: existing?.lastEventAt,
    context,
  })

  // Auto-start if configured
  if (config.autoStart !== false) {
    await startConnection(sourceId, connections, context, fetchFn)
  }

  return jsonResponse({
    id: sourceId,
    ...getSourceStatus(sourceId, connections.get(sourceId)!),
  }, existing ? 200 : 201)
}

async function handleDeleteSource(
  sourceId: string,
  context: StreamContext,
  connections: Map<string, {
    config: SSESourceConfig
    status: SSESourceStatus[`status`]
    error?: string
    eventCount: number
    lastEventAt?: number
    controller?: AbortController
    context?: StreamContext
  }>
): Promise<ProtocolResponse> {
  const conn = connections.get(sourceId)
  if (!conn) {
    return errorResponse(`Source not found`, 404)
  }

  // Stop connection
  conn.controller?.abort()

  // Delete events stream
  const eventsPath = `sources/${sourceId}/events`
  if (await context.has(eventsPath)) {
    await context.delete(eventsPath)
  }

  connections.delete(sourceId)

  return { status: 204 }
}

async function handleStart(
  sourceId: string,
  connections: Map<string, {
    config: SSESourceConfig
    status: SSESourceStatus[`status`]
    error?: string
    eventCount: number
    lastEventAt?: number
    controller?: AbortController
    context?: StreamContext
  }>,
  context: StreamContext,
  fetchFn: typeof fetch
): Promise<ProtocolResponse> {
  const conn = connections.get(sourceId)
  if (!conn) {
    return errorResponse(`Source not found`, 404)
  }

  if (conn.status === `connected` || conn.status === `connecting`) {
    return jsonResponse({ message: `Already running`, status: conn.status })
  }

  await startConnection(sourceId, connections, context, fetchFn)

  return jsonResponse({ message: `Started`, status: conn.status })
}

function handleStop(
  sourceId: string,
  connections: Map<string, {
    config: SSESourceConfig
    status: SSESourceStatus[`status`]
    error?: string
    eventCount: number
    lastEventAt?: number
    controller?: AbortController
  }>
): ProtocolResponse {
  const conn = connections.get(sourceId)
  if (!conn) {
    return errorResponse(`Source not found`, 404)
  }

  conn.controller?.abort()
  conn.status = `disconnected`
  conn.controller = undefined

  return jsonResponse({ message: `Stopped`, status: conn.status })
}

function handleStatus(
  connections: Map<string, {
    config: SSESourceConfig
    status: SSESourceStatus[`status`]
    error?: string
    eventCount: number
    lastEventAt?: number
  }>
): ProtocolResponse {
  const sources = Array.from(connections.entries()).map(([id, conn]) => ({
    id,
    ...getSourceStatus(id, conn),
  }))

  const connected = sources.filter((s) => s.status === `connected`).length
  const total = sources.length

  return jsonResponse({
    totalSources: total,
    connectedSources: connected,
    sources,
  })
}

async function startConnection(
  sourceId: string,
  connections: Map<string, {
    config: SSESourceConfig
    status: SSESourceStatus[`status`]
    error?: string
    eventCount: number
    lastEventAt?: number
    controller?: AbortController
    context?: StreamContext
  }>,
  context: StreamContext,
  fetchFn: typeof fetch
): Promise<void> {
  const conn = connections.get(sourceId)
  if (!conn) return

  // Set up abort controller
  const controller = new AbortController()
  conn.controller = controller
  conn.status = `connecting`
  conn.error = undefined

  const eventsPath = `sources/${sourceId}/events`
  const reconnectDelay = conn.config.reconnectDelay ?? 3000

  // Start connection in background
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetchFn(conn.config.url, {
          headers: {
            Accept: `text/event-stream`,
            ...conn.config.headers,
          },
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        conn.status = `connected`
        conn.error = undefined

        // Process SSE stream
        const reader = response.body?.getReader()
        if (!reader) {
          throw new Error(`No response body`)
        }

        const decoder = new TextDecoder()
        let buffer = ``

        while (!controller.signal.aborted) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split(`\n`)
          buffer = lines.pop() || ``

          let currentEvent: Partial<SSEEvent> = {}
          let currentData: string[] = []

          for (const line of lines) {
            if (line.startsWith(`event:`)) {
              currentEvent.event = line.slice(6).trim()
            } else if (line.startsWith(`data:`)) {
              currentData.push(line.slice(5).trim())
            } else if (line.startsWith(`id:`)) {
              currentEvent.id = line.slice(3).trim()
            } else if (line.startsWith(`retry:`)) {
              currentEvent.retry = parseInt(line.slice(6).trim(), 10)
            } else if (line === ``) {
              // End of event
              if (currentData.length > 0) {
                const data = currentData.join(`\n`)

                // Filter by event type if configured
                if (
                  conn.config.eventTypes &&
                  conn.config.eventTypes.length > 0 &&
                  currentEvent.event &&
                  !conn.config.eventTypes.includes(currentEvent.event)
                ) {
                  // Skip this event
                  currentEvent = {}
                  currentData = []
                  continue
                }

                // Store event
                const storedEvent = {
                  event: currentEvent.event,
                  data,
                  id: currentEvent.id,
                  timestamp: Date.now(),
                }

                await context.append(eventsPath, storedEvent)

                conn.eventCount++
                conn.lastEventAt = Date.now()
              }

              currentEvent = {}
              currentData = []
            }
          }
        }
      } catch (error) {
        if (controller.signal.aborted) break

        conn.status = `error`
        conn.error = error instanceof Error ? error.message : String(error)

        // Wait before reconnecting
        await new Promise((resolve) => setTimeout(resolve, reconnectDelay))
      }
    }

    // Mark as disconnected when done
    const current = connections.get(sourceId)
    if (current && current.controller === controller) {
      current.status = `disconnected`
    }
  })()
}
