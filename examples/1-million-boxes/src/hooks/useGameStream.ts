import { useCallback, useEffect, useRef } from "react"
import { stream } from "@durable-streams/client"
import { StreamParser } from "../../shared/stream-parser"
import { STREAM_PROXY_ENDPOINT, STREAM_RECONNECT_DELAY_MS } from "../lib/config"
import type { StreamResponse } from "@durable-streams/client"
import type { GameEvent } from "../../shared/game-state"

export interface UseGameStreamOptions {
  onEvents: (events: Array<GameEvent>, upToDate: boolean) => void
  onError?: (error: Error) => void
  onConnected?: () => void
  onDisconnected?: () => void
  /** Called when the game start timestamp is parsed from the stream header */
  onGameStartTimestamp?: (timestamp: number) => void
  enabled?: boolean
}

export interface UseGameStreamResult {
  disconnect: () => void
  reconnect: () => void
}

/**
 * Get the URL for stream connections.
 * Always uses the proxy endpoint through the worker.
 */
function getStreamUrl(): string {
  const origin =
    typeof window !== `undefined`
      ? window.location.origin
      : `http://localhost:5173`
  return `${origin}${STREAM_PROXY_ENDPOINT}`
}

/**
 * Hook for connecting to the game event stream using the durable streams client.
 *
 * Uses the @durable-streams/client library's stream() function with
 * long polling for real-time updates (SSE not supported for octet-stream).
 */
export function useGameStream(
  options: UseGameStreamOptions
): UseGameStreamResult {
  const {
    onEvents,
    onError,
    onConnected,
    onDisconnected,
    onGameStartTimestamp,
    enabled = true,
  } = options

  // Connection ID to invalidate stale connection attempts
  const connectionIdRef = useRef(0)
  const streamResponseRef = useRef<StreamResponse | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const parserRef = useRef<StreamParser>(new StreamParser())
  const isConnectedRef = useRef(false)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const timestampReportedRef = useRef(false)

  // Store callbacks in refs to avoid stale closures
  const onEventsRef = useRef(onEvents)
  const onErrorRef = useRef(onError)
  const onConnectedRef = useRef(onConnected)
  const onDisconnectedRef = useRef(onDisconnected)
  const onGameStartTimestampRef = useRef(onGameStartTimestamp)

  // Update callback refs when they change
  onEventsRef.current = onEvents
  onErrorRef.current = onError
  onConnectedRef.current = onConnected
  onDisconnectedRef.current = onDisconnected
  onGameStartTimestampRef.current = onGameStartTimestamp

  const disconnect = useCallback(() => {
    // Increment connection ID to invalidate any in-flight connections
    connectionIdRef.current++

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

  const connect = useCallback(() => {
    // Increment and capture connection ID for this attempt
    const myConnectionId = ++connectionIdRef.current

    // Helper to check if this connection is still valid
    const isValid = () => connectionIdRef.current === myConnectionId

    // Reset parser and timestamp tracking for new connection
    parserRef.current.reset()
    timestampReportedRef.current = false

    const streamUrl = getStreamUrl()
    console.log(
      `[useGameStream] Connecting to:`,
      streamUrl,
      `(id: ${myConnectionId})`
    )

    const doConnect = async () => {
      try {
        // Start streaming with long polling using the read-only stream API
        const response = await stream({
          url: streamUrl,
          live: `long-poll`,
        })

        if (!isValid()) {
          response.cancel()
          return
        }

        streamResponseRef.current = response

        // Mark as connected
        if (!isConnectedRef.current) {
          isConnectedRef.current = true
          console.log(`[useGameStream] Connected`)
          onConnectedRef.current?.()
        }

        // Subscribe to byte chunks and parse them into game events
        unsubscribeRef.current = response.subscribeBytes((chunk) => {
          if (!isValid()) return

          try {
            const events = parserRef.current.feed(chunk.data)

            // Report game start timestamp once after header is parsed
            if (
              !timestampReportedRef.current &&
              parserRef.current.isHeaderParsed()
            ) {
              const timestamp = parserRef.current.getGameStartTimestamp()
              if (timestamp !== null) {
                timestampReportedRef.current = true
                onGameStartTimestampRef.current?.(timestamp)
              }
            }

            if (events.length > 0) {
              onEventsRef.current(events, chunk.upToDate)
            } else if (chunk.upToDate) {
              // No events but we're up to date - signal this to the handler
              onEventsRef.current([], true)
            }
          } catch (err) {
            console.error(`[useGameStream] Error parsing chunk:`, err)
            onErrorRef.current?.(
              err instanceof Error ? err : new Error(String(err))
            )
          }
        })

        // Handle stream completion - schedule reconnect
        response.closed
          .then(() => {
            if (!isValid()) return
            console.log(`[useGameStream] Stream closed, reconnecting...`)
            if (isConnectedRef.current) {
              isConnectedRef.current = false
              onDisconnectedRef.current?.()
            }
            reconnectTimeoutRef.current = setTimeout(() => {
              reconnectTimeoutRef.current = null
              if (isValid()) connect()
            }, STREAM_RECONNECT_DELAY_MS)
          })
          .catch((err: unknown) => {
            if (!isValid()) return
            console.error(`[useGameStream] Stream error:`, err)
            if (isConnectedRef.current) {
              isConnectedRef.current = false
              onDisconnectedRef.current?.()
            }
            onErrorRef.current?.(
              err instanceof Error ? err : new Error(String(err))
            )
            reconnectTimeoutRef.current = setTimeout(() => {
              reconnectTimeoutRef.current = null
              if (isValid()) connect()
            }, STREAM_RECONNECT_DELAY_MS)
          })
      } catch (err) {
        if (!isValid()) return
        console.error(`[useGameStream] Connection error:`, err)
        onErrorRef.current?.(
          err instanceof Error ? err : new Error(String(err))
        )
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null
          if (isValid()) connect()
        }, STREAM_RECONNECT_DELAY_MS)
      }
    }

    doConnect()
  }, [])

  const reconnect = useCallback(() => {
    disconnect()
    setTimeout(() => connect(), 100)
  }, [disconnect, connect])

  // Main effect - only runs once on mount/unmount
  useEffect(() => {
    if (enabled) {
      connect()
    }

    return () => {
      disconnect()
    }
  }, [enabled])

  return { disconnect, reconnect }
}
