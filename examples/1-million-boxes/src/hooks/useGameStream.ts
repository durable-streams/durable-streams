import { useCallback, useEffect, useRef } from "react"
import { StreamParser } from "../lib/stream-parser"
import type { GameEvent } from "../lib/game-state"

const STREAM_URL =
  import.meta.env.VITE_DURABLE_STREAMS_URL || `http://localhost:8787`

const RECONNECT_DELAY_MS = 3000

export interface UseGameStreamOptions {
  onEvents: (events: Array<GameEvent>) => void
  onError?: (error: Error) => void
  onConnected?: () => void
  onDisconnected?: () => void
}

export interface UseGameStreamResult {
  disconnect: () => void
  reconnect: () => void
}

/**
 * Hook for connecting to the game event stream.
 *
 * Fetches existing data first, then connects to SSE for live updates.
 * Automatically reconnects on error with a delay.
 */
export function useGameStream(
  options: UseGameStreamOptions
): UseGameStreamResult {
  const { onEvents, onError, onConnected, onDisconnected } = options

  const eventSourceRef = useRef<EventSource | null>(null)
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
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }

    if (isConnectedRef.current) {
      isConnectedRef.current = false
      onDisconnectedRef.current?.()
    }
  }, [])

  const connectSSE = useCallback(
    (fromSeq?: number) => {
      if (!isMountedRef.current) return

      // Close any existing connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
      }

      // Reset parser for new connection
      parserRef.current.reset()

      // Build SSE URL with optional seq parameter
      const sseUrl = fromSeq
        ? `${STREAM_URL}/game?live=sse&seq=${fromSeq}`
        : `${STREAM_URL}/game?live=sse`

      const eventSource = new EventSource(sseUrl)
      eventSourceRef.current = eventSource

      eventSource.onopen = () => {
        if (!isMountedRef.current) return
        if (!isConnectedRef.current) {
          isConnectedRef.current = true
          onConnectedRef.current?.()
        }
      }

      eventSource.onmessage = (event) => {
        if (!isMountedRef.current) return

        try {
          // SSE data is base64 encoded binary
          const base64 = event.data as string
          const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))

          // Parse events using streaming parser
          const events = parserRef.current.feed(binary)

          if (events.length > 0) {
            onEventsRef.current(events)
          }
        } catch (err) {
          console.error(`Error parsing SSE message:`, err)
          onErrorRef.current?.(
            err instanceof Error ? err : new Error(String(err))
          )
        }
      }

      eventSource.onerror = () => {
        if (!isMountedRef.current) return

        // Clean up current connection
        eventSource.close()
        eventSourceRef.current = null

        if (isConnectedRef.current) {
          isConnectedRef.current = false
          onDisconnectedRef.current?.()
        }

        // Schedule reconnect
        reconnectTimeoutRef.current = setTimeout(() => {
          if (isMountedRef.current) {
            connect()
          }
        }, RECONNECT_DELAY_MS)
      }
    },
    [disconnect]
  )

  const connect = useCallback(async () => {
    if (!isMountedRef.current) return

    try {
      // First fetch existing data
      const response = await fetch(`${STREAM_URL}/game`)

      if (!response.ok) {
        throw new Error(`Failed to fetch stream: ${response.status}`)
      }

      const arrayBuffer = await response.arrayBuffer()
      const bytes = new Uint8Array(arrayBuffer)

      // Parse initial data
      const events = parserRef.current.feed(bytes)

      if (events.length > 0) {
        onEventsRef.current(events)
      }

      // Calculate seq for SSE (number of complete 3-byte records)
      const seq = Math.floor(bytes.length / 3)

      // Connect to SSE for live updates
      connectSSE(seq)
    } catch (err) {
      console.error(`Error connecting to stream:`, err)
      onErrorRef.current?.(err instanceof Error ? err : new Error(String(err)))

      // Schedule reconnect on fetch error
      reconnectTimeoutRef.current = setTimeout(() => {
        if (isMountedRef.current) {
          connect()
        }
      }, RECONNECT_DELAY_MS)
    }
  }, [connectSSE])

  const reconnect = useCallback(() => {
    disconnect()
    parserRef.current.reset()
    connect()
  }, [disconnect, connect])

  // Initial connection
  useEffect(() => {
    isMountedRef.current = true
    connect()

    return () => {
      isMountedRef.current = false
      disconnect()
    }
  }, [connect, disconnect])

  return { disconnect, reconnect }
}
