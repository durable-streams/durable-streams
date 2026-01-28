/**
 * Upstream connection management and body piping.
 *
 * Handles the lifecycle of connections to upstream servers and streams
 * their response bodies to durable storage with batching.
 */

import type { UpstreamConnection } from "./types"

/**
 * Registry of active upstream connections.
 * Keyed by stream ID for lookup on abort requests.
 */
const activeConnections = new Map<string, UpstreamConnection>()

/**
 * Register an active upstream connection.
 *
 * @param streamId - The stream ID
 * @param connection - The connection state
 */
export function registerConnection(
  streamId: string,
  connection: UpstreamConnection
): void {
  activeConnections.set(streamId, connection)
}

/**
 * Unregister an upstream connection.
 *
 * @param streamId - The stream ID
 */
export function unregisterConnection(streamId: string): void {
  activeConnections.delete(streamId)
}

/**
 * Get an active connection by stream ID.
 *
 * @param streamId - The stream ID
 * @returns The connection if found, undefined otherwise
 */
export function getConnection(
  streamId: string
): UpstreamConnection | undefined {
  return activeConnections.get(streamId)
}

/**
 * Abort an active connection.
 *
 * @param streamId - The stream ID
 */
export function abortConnection(streamId: string): void {
  const connection = activeConnections.get(streamId)
  if (connection?.abortController) {
    connection.abortController.abort()
  }
  // Always clear the reference (idempotent)
  activeConnections.delete(streamId)
}

/**
 * Options for piping upstream response body to durable storage.
 */
export interface PipeUpstreamOptions {
  /** URL of the durable streams server */
  durableStreamsUrl: string
  /** The stream ID */
  streamId: string
  /** AbortSignal for cancellation */
  signal: AbortSignal
  /** Size threshold for flushing batches (default: 4KB) */
  batchSizeThreshold?: number
  /** Time threshold for flushing batches in ms (default: 50ms) */
  batchTimeThreshold?: number
  /** Inactivity timeout in ms (default: 10 minutes) */
  inactivityTimeout?: number
}

/**
 * Concatenate multiple Uint8Arrays into one.
 */
function concatUint8Arrays(arrays: Array<Uint8Array>): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

/**
 * Pipe an upstream response body to durable storage.
 *
 * Implements batching and inactivity timeout per spec:
 * - Flush when 4KB accumulated OR 50ms since first chunk in batch
 * - 10 minute inactivity timeout
 * - Mark stream closed when body ends
 * - On abort: flush accumulated data but don't close stream
 *
 * @param body - The response body stream
 * @param options - Piping options
 */
export async function pipeUpstreamBody(
  body: ReadableStream<Uint8Array>,
  options: PipeUpstreamOptions
): Promise<void> {
  const {
    durableStreamsUrl,
    streamId,
    signal,
    batchSizeThreshold = 4096, // 4KB
    batchTimeThreshold = 50, // 50ms
    inactivityTimeout = 600000, // 10 minutes
  } = options

  const streamPath = `/v1/streams/${streamId}`

  let buffer: Array<Uint8Array> = []
  let bufferSize = 0
  let batchStartTime: number | null = null
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null
  let inactivityTimedOut = false

  const reader = body.getReader()

  const resetInactivityTimer = () => {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer)
    }
    inactivityTimer = setTimeout(() => {
      inactivityTimedOut = true
      reader.cancel(`Inactivity timeout`).catch(() => {
        // Ignore cancel errors
      })
    }, inactivityTimeout)
  }

  const clearInactivityTimer = () => {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer)
      inactivityTimer = null
    }
  }

  const flush = async (): Promise<void> => {
    if (bufferSize === 0) return

    const data = concatUint8Arrays(buffer)
    buffer = []
    bufferSize = 0
    batchStartTime = null

    // POST to underlying stream
    const url = new URL(streamPath, durableStreamsUrl)
    await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Content-Type": `application/octet-stream`,
      },
      body: data as unknown as BodyInit,
    })
  }

  const closeStream = async (): Promise<void> => {
    // Mark the stream as closed
    const url = new URL(streamPath, durableStreamsUrl)
    await fetch(url.toString(), {
      method: `POST`,
      headers: {
        "Stream-Closed": `true`,
        "Content-Length": `0`,
      },
    })
  }

  try {
    resetInactivityTimer()

    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        // Stream completed - flush remaining and close
        clearInactivityTimer()
        await flush()
        await closeStream()
        break
      }

      if (signal.aborted) {
        // Aborted - flush but do NOT close (data remains readable)
        clearInactivityTimer()
        await flush()
        break
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Set by timeout callback
      if (inactivityTimedOut) {
        // Inactivity timeout - flush but do NOT close
        clearInactivityTimer()
        await flush()
        break
      }

      // Accumulate chunk
      buffer.push(value)
      bufferSize += value.length
      if (!batchStartTime) {
        batchStartTime = Date.now()
      }
      resetInactivityTimer()

      // Flush on size or time threshold
      if (
        bufferSize >= batchSizeThreshold ||
        Date.now() - batchStartTime >= batchTimeThreshold
      ) {
        await flush()
      }
    }
  } catch (error) {
    clearInactivityTimer()

    // Try to flush any accumulated data
    try {
      await flush()
    } catch {
      // Ignore flush errors on error path
    }

    // Don't close stream on error - data remains readable up to this point
    // Rethrow so caller knows about the error
    throw error
  } finally {
    clearInactivityTimer()
    reader.releaseLock()
  }
}
