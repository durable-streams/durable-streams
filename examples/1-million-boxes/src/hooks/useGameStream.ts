import { useCallback, useEffect, useRef } from "react"
import { FetchError, stream as durableStream } from "@durable-streams/client"
import { StreamParser } from "../lib/stream-parser"
import {
  GAME_STREAM_URL,
  STREAM_PROXY_ENDPOINT,
  STREAM_RECONNECT_DELAY_MS,
  USE_STREAM_PROXY,
} from "../lib/config"
import type { StreamResponse } from "@durable-streams/client"
import type { GameEvent } from "../lib/game-state"

/**
 * Delay before retrying when the stream doesn't exist (404).
 * This is longer than normal reconnect delay to avoid spamming.
 */
const STREAM_NOT_FOUND_RETRY_DELAY_MS = 5000

export interface UseGameStreamOptions {
  onEvents: (events: Array<GameEvent>) => void
  onError?: (error: Error) => void
  onConnected?: () => void
  onDisconnected?: () => void
  /**
   * Whether to enable the stream connection.
   * Set to false to delay connection until ready.
   * @default true
   */
  enabled?: boolean
}

export interface UseGameStreamResult {
  disconnect: () => void
  reconnect: () => void
}

/**
 * Get the URL for stream connections.
 * Uses proxy endpoint in production, direct URL in development.
 */
function getStreamUrl(): string {
  return USE_STREAM_PROXY ? STREAM_PROXY_ENDPOINT : GAME_STREAM_URL
}

/**
 * Hook for connecting to the game event stream using the Durable Streams client.
 *
 * Uses the @durable-streams/client library for:
 * - Proper SSE handling with automatic reconnection
 * - Offset tracking for resumption
 * - Backpressure-aware consumption
 *
 * In production (USE_STREAM_PROXY=true):
 * - Connects through the worker proxy endpoint which adds auth
 *
 * In development:
 * - Connects directly to the Durable Streams server
 */
export function useGameStream(
  options: UseGameStreamOptions
): UseGameStreamResult {
  const {
    onEvents,
    onError,
    onConnected,
    onDisconnected,
    enabled = true,
  } = options

  const streamResponseRef = useRef<StreamResponse | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const parserRef = useRef<StreamParser>(new StreamParser())
  const isConnectedRef = useRef(false)
  const isMountedRef = useRef(true)

  // Store callbacks in refs to avoid dependency issues
  const onEventsRef = useRef(onEvents)
  const onErrorRef = useRef(onError)
  const onConnectedRef = useRef(onConnected)
  const onDisconnectedRef = useRef(onDisconnected)

  useEffect(() => {
    onEventsRef.current = onEvents
    onErrorRef.current = onError
    onConnectedRef.current = onConnected
    onDisconnectedRef.current = onDisconnected
  }, [onEvents, onError, onConnected, onDisconnected])

  const disconnect = useCallback(() => {
    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    // Unsubscribe from the stream
    if (unsubscribeRef.current) {
      unsubscribeRef.current()
      unsubscribeRef.current = null
    }

    // Cancel the stream response
    if (streamResponseRef.current) {
      streamResponseRef.current.cancel()
      streamResponseRef.current = null
    }

    if (isConnectedRef.current) {
      isConnectedRef.current = false
      onDisconnectedRef.current?.()
    }
  }, [])

  const connect = useCallback(async () => {
    if (!isMountedRef.current) return

    // Reset parser for new connection
    parserRef.current.reset()

    try {
      const streamUrl = getStreamUrl()

      // Connect using the Durable Streams client
      // We throw from onError to disable the client's built-in retry loop
      // and handle all retries manually with proper delays
      const response = await durableStream({
        url: streamUrl,
        live: `sse`, // Use SSE for live updates
        onError: (error) => {
          // Throw to stop the client's retry loop - we handle retries manually
          throw error
        },
      })

      // Check if component unmounted during the async connect
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!isMountedRef.current) {
        response.cancel()
        return
      }

      streamResponseRef.current = response

      // Mark as connected

      if (!isConnectedRef.current) {
        isConnectedRef.current = true
        onConnectedRef.current?.()
      }

      // Subscribe to byte chunks and parse them into game events
      unsubscribeRef.current = response.subscribeBytes((chunk) => {
        if (!isMountedRef.current) return

        try {
          // Parse the binary chunk into game events
          const events = parserRef.current.feed(chunk.data)

          if (events.length > 0) {
            onEventsRef.current(events)
          }
        } catch (err) {
          console.error(`Error parsing stream chunk:`, err)
          onErrorRef.current?.(
            err instanceof Error ? err : new Error(String(err))
          )
        }
      })

      // Handle stream completion/cancellation
      response.closed
        .then(() => {
          if (isMountedRef.current && isConnectedRef.current) {
            isConnectedRef.current = false
            onDisconnectedRef.current?.()
          }
        })
        .catch((err: unknown) => {
          if (isMountedRef.current) {
            console.error(`Stream closed with error:`, err)
            onErrorRef.current?.(
              err instanceof Error ? err : new Error(String(err))
            )
          }
        })
    } catch (err) {
      // Check error type to determine retry delay
      const is404 = err instanceof FetchError && err.status === 404

      if (is404) {
        console.log(
          `Stream not found, will retry in ${STREAM_NOT_FOUND_RETRY_DELAY_MS}ms`
        )
      } else {
        console.error(`Error connecting to stream:`, err)
        onErrorRef.current?.(
          err instanceof Error ? err : new Error(String(err))
        )
      }

      // Schedule reconnect with appropriate delay
      // 404 = stream doesn't exist yet, use longer delay
      // Other errors = use standard reconnect delay
      const retryDelay = is404
        ? STREAM_NOT_FOUND_RETRY_DELAY_MS
        : STREAM_RECONNECT_DELAY_MS

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (isMountedRef.current) {
        reconnectTimeoutRef.current = setTimeout(() => {
          if (isMountedRef.current) {
            connect()
          }
        }, retryDelay)
      }
    }
  }, [])

  const reconnect = useCallback(() => {
    disconnect()
    connect()
  }, [disconnect, connect])

  // Initial connection (when enabled)
  useEffect(() => {
    isMountedRef.current = true

    if (enabled) {
      connect()
    }

    return () => {
      isMountedRef.current = false
      disconnect()
    }
  }, [connect, disconnect, enabled])

  return { disconnect, reconnect }
}
