/**
 * Upstream connection management.
 *
 * Handles the lifecycle of connections to upstream servers (OpenAI, Anthropic, etc.)
 * and streams their responses to durable storage.
 */

import type { ControlMessage, UpstreamConnection } from "./types"

/**
 * Registry of active upstream connections.
 * Keyed by stream path for lookup on abort requests.
 */
const activeConnections = new Map<string, UpstreamConnection>()

/**
 * Register an active upstream connection.
 *
 * @param path - The durable stream path
 * @param connection - The connection state
 */
export function registerConnection(
  path: string,
  connection: UpstreamConnection
): void {
  activeConnections.set(path, connection)
}

/**
 * Unregister an upstream connection.
 *
 * @param path - The durable stream path
 */
export function unregisterConnection(path: string): void {
  activeConnections.delete(path)
}

/**
 * Get an active connection by path.
 *
 * @param path - The durable stream path
 * @returns The connection if found, undefined otherwise
 */
export function getConnection(path: string): UpstreamConnection | undefined {
  return activeConnections.get(path)
}

/**
 * Abort an active connection.
 *
 * @param path - The durable stream path
 * @returns True if connection was found and aborted, false if not found
 */
export function abortConnection(path: string): boolean {
  const connection = activeConnections.get(path)
  if (!connection) {
    return false
  }

  if (!connection.aborted && !connection.completed) {
    connection.aborted = true
    connection.abortController.abort()
  }

  return true
}

/**
 * Create a control message for stream completion.
 */
export function createCompleteMessage(): ControlMessage {
  return { type: `close`, reason: `complete` }
}

/**
 * Create a control message for stream abort.
 */
export function createAbortMessage(): ControlMessage {
  return { type: `close`, reason: `aborted` }
}

/**
 * Create a control message for upstream errors.
 */
export function createErrorMessage(
  code: string,
  status?: number,
  message?: string
): ControlMessage {
  return {
    type: `close`,
    reason: `error`,
    error: { code, status, message },
  }
}

/**
 * Options for streaming upstream response to durable storage.
 */
export interface StreamUpstreamOptions {
  /** URL of the upstream service */
  upstreamUrl: string
  /** HTTP method (default: POST) */
  method?: string
  /** Headers to send to upstream */
  headers: Record<string, string>
  /** Request body */
  body?: Buffer | string
  /** URL of the durable streams server */
  durableStreamsUrl: string
  /** Path to the durable stream */
  streamPath: string
  /** Content type for the stream */
  contentType?: string
  /** Idle timeout in milliseconds */
  idleTimeoutMs?: number
  /** Maximum response size in bytes */
  maxResponseBytes?: number
  /** AbortSignal for cancellation */
  signal: AbortSignal
  /** Callback when streaming completes */
  onComplete?: (offset: string) => void
  /** Callback when an error occurs */
  onError?: (error: Error) => void
}

/**
 * Stream an upstream response to durable storage.
 *
 * This function:
 * 1. Makes a request to the upstream URL
 * 2. Streams the response body to the durable streams server
 * 3. Appends a control message on completion/error/abort
 *
 * @param options - Streaming options
 */
export async function streamUpstreamToStorage(
  options: StreamUpstreamOptions
): Promise<void> {
  const {
    upstreamUrl,
    method = `POST`,
    headers,
    body,
    durableStreamsUrl,
    streamPath,
    contentType = `text/event-stream`,
    idleTimeoutMs = 300000,
    maxResponseBytes = 100 * 1024 * 1024, // 100MB default
    signal,
    onComplete,
    onError,
  } = options

  let totalBytes = 0
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let lastOffset = ``
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let idleTimedOut = false

  const resetIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
    }
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      // Cancel the reader to exit the read loop
      if (activeReader) {
        activeReader.cancel(`Idle timeout exceeded`).catch(() => {
          // Ignore cancel errors
        })
      }
      onError?.(new Error(`Idle timeout exceeded`))
    }, idleTimeoutMs)
  }

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  try {
    // Make upstream request - convert Buffer to Uint8Array for fetch compatibility
    let requestBody: BodyInit | undefined
    if (body !== undefined) {
      if (Buffer.isBuffer(body)) {
        requestBody = new Uint8Array(body) as unknown as BodyInit
      } else {
        // body is string
        requestBody = body
      }
    }
    const upstreamResponse = await fetch(upstreamUrl, {
      method,
      headers,
      body: requestBody,
      signal,
    })

    // Check for upstream errors
    if (!upstreamResponse.ok) {
      const errorBody = await upstreamResponse.text().catch(() => ``)
      await appendControlMessage(durableStreamsUrl, streamPath, contentType, {
        type: `close`,
        reason: `error`,
        error: {
          code: `UPSTREAM_ERROR`,
          status: upstreamResponse.status,
          message: errorBody.slice(0, 500), // Truncate long error messages
        },
      })
      return
    }

    // Stream the response body to durable storage
    const reader = upstreamResponse.body?.getReader()
    activeReader = reader ?? null
    if (!reader) {
      await appendControlMessage(durableStreamsUrl, streamPath, contentType, {
        type: `close`,
        reason: `error`,
        error: { code: `NO_RESPONSE_BODY` },
      })
      return
    }

    resetIdleTimer()

    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      if (signal.aborted) {
        reader.cancel()
        break
      }

      // Check size limit
      totalBytes += value.length
      if (totalBytes > maxResponseBytes) {
        reader.cancel()
        await appendControlMessage(durableStreamsUrl, streamPath, contentType, {
          type: `close`,
          reason: `error`,
          error: {
            code: `RESPONSE_TOO_LARGE`,
            message: `Response exceeded ${maxResponseBytes} bytes`,
          },
        })
        return
      }

      // Reset idle timer on data received
      resetIdleTimer()

      // Append chunk to durable stream
      lastOffset = await appendToStream(
        durableStreamsUrl,
        streamPath,
        contentType,
        value
      )
    }

    clearIdleTimer()

    // Append completion control message
    if (signal.aborted) {
      await appendControlMessage(
        durableStreamsUrl,
        streamPath,
        contentType,
        createAbortMessage()
      )
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set by setTimeout callback
    } else if (idleTimedOut) {
      // Idle timeout - append error control message (not complete)
      await appendControlMessage(durableStreamsUrl, streamPath, contentType, {
        type: `close`,
        reason: `error`,
        error: { code: `IDLE_TIMEOUT`, message: `Idle timeout exceeded` },
      })
    } else {
      await appendControlMessage(
        durableStreamsUrl,
        streamPath,
        contentType,
        createCompleteMessage()
      )
      onComplete?.(lastOffset)
    }
  } catch (error) {
    clearIdleTimer()

    if (signal.aborted) {
      // Aborted - append abort control message
      await appendControlMessage(
        durableStreamsUrl,
        streamPath,
        contentType,
        createAbortMessage()
      ).catch((appendError) => {
        console.error(`Failed to append abort control message:`, {
          streamPath,
          error:
            appendError instanceof Error ? appendError.message : appendError,
        })
      })
    } else {
      // Real error - append error control message
      const message =
        error instanceof Error ? error.message : `Unknown upstream error`
      await appendControlMessage(durableStreamsUrl, streamPath, contentType, {
        type: `close`,
        reason: `error`,
        error: { code: `UPSTREAM_ERROR`, message },
      }).catch((appendError) => {
        console.error(`Failed to append error control message:`, {
          streamPath,
          error:
            appendError instanceof Error ? appendError.message : appendError,
        })
      })
      onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

/**
 * Append data to a durable stream.
 *
 * @param baseUrl - Base URL of the durable streams server
 * @param path - Stream path
 * @param contentType - Content type of the data
 * @param data - Data to append
 * @returns The new offset after appending
 */
async function appendToStream(
  baseUrl: string,
  path: string,
  contentType: string,
  data: Uint8Array
): Promise<string> {
  const url = new URL(path, baseUrl)

  const response = await fetch(url, {
    method: `POST`,
    headers: {
      "Content-Type": contentType,
    },
    body: data as unknown as BodyInit,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => ``)
    throw new Error(
      `Failed to append to stream: ${response.status} ${errorText}`
    )
  }

  return response.headers.get(`Stream-Next-Offset`) ?? ``
}

/**
 * Append a control message to a durable stream.
 *
 * Control messages are formatted according to the stream's content type:
 * - For SSE streams (text/event-stream): as an SSE event
 * - For JSON streams: as a JSON array
 * - For other types: as plain JSON
 */
async function appendControlMessage(
  baseUrl: string,
  path: string,
  contentType: string,
  message: ControlMessage
): Promise<void> {
  const url = new URL(path, baseUrl)

  let body: string
  let actualContentType: string

  // Format control message based on stream content type
  if (contentType.includes(`text/event-stream`)) {
    // Format as SSE event
    body = `event: control\ndata: ${JSON.stringify(message)}\n\n`
    actualContentType = `text/event-stream`
  } else if (contentType.includes(`application/json`)) {
    // Format as JSON array for JSON mode
    body = JSON.stringify([message])
    actualContentType = `application/json`
  } else {
    // Default to plain JSON with matching content type
    body = JSON.stringify(message)
    actualContentType = contentType
  }

  const response = await fetch(url, {
    method: `POST`,
    headers: {
      "Content-Type": actualContentType,
    },
    body,
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => ``)
    throw new Error(
      `Failed to append control message: ${response.status} ${errorText}`
    )
  }
}
