import { useCallback, useEffect, useRef } from "react"
import { StreamParser } from "../lib/stream-parser"
import {
  GAME_STREAM_URL,
  STREAM_PROXY_ENDPOINT,
  STREAM_RECONNECT_DELAY_MS,
  USE_STREAM_PROXY,
} from "../lib/config"
import { getGameStream } from "../server/stream-proxy"
import type { GameEvent } from "../lib/game-state"

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
 * Get the URL for SSE connections.
 * Uses proxy endpoint in production, direct URL in development.
 */
function getSSEUrl(fromSeq?: number): string {
  const baseUrl = USE_STREAM_PROXY ? STREAM_PROXY_ENDPOINT : GAME_STREAM_URL
  const params = new URLSearchParams({ live: `sse` })
  if (fromSeq !== undefined) {
    params.set(`seq`, String(fromSeq))
  }
  return `${baseUrl}?${params.toString()}`
}

/**
 * Hook for connecting to the game event stream.
 *
 * Fetches existing data first, then connects to SSE for live updates.
 * Automatically reconnects on error with a delay.
 *
 * In production (USE_STREAM_PROXY=true):
 * - Initial data is fetched via server function (with auth)
 * - SSE connects through the worker proxy endpoint
 *
 * In development:
 * - Connects directly to the Durable Streams server
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

      // Build SSE URL (uses proxy in production, direct in dev)
      const sseUrl = getSSEUrl(fromSeq)

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
        }, STREAM_RECONNECT_DELAY_MS)
      }
    },
    [disconnect]
  )

  /**
   * Fetch initial stream data via proxy (server function).
   * Returns the parsed events and byte length.
   */
  const fetchViaProxy = useCallback(async (): Promise<{
    events: Array<GameEvent>
    byteLength: number
  }> => {
    const result = await getGameStream()

    if (!result.ok) {
      // Type narrowing: when ok is false, we have status and error
      const errorResult = result as { ok: false; status: number; error: string }
      if (errorResult.status === 404) {
        return { events: [], byteLength: 0 }
      }
      throw new Error(errorResult.error)
    }

    // Type narrowing: when ok is true, we have data and length
    const successResult = result as { ok: true; data: string; length: number }
    if (successResult.length === 0) {
      return { events: [], byteLength: 0 }
    }

    // Decode base64 data
    const binary = Uint8Array.from(atob(successResult.data), (c) =>
      c.charCodeAt(0)
    )
    const events = parserRef.current.feed(binary)

    return { events, byteLength: binary.length }
  }, [])

  /**
   * Fetch initial stream data directly.
   * Returns the parsed events and byte length.
   */
  const fetchDirect = useCallback(async (): Promise<{
    events: Array<GameEvent>
    byteLength: number
  }> => {
    const response = await fetch(GAME_STREAM_URL)

    if (response.status === 404) {
      return { events: [], byteLength: 0 }
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch stream: ${response.status}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    const events = parserRef.current.feed(bytes)

    return { events, byteLength: bytes.length }
  }, [])

  const connect = useCallback(async () => {
    if (!isMountedRef.current) return

    try {
      // Fetch initial data (via proxy in production, direct in dev)
      const { events, byteLength } = USE_STREAM_PROXY
        ? await fetchViaProxy()
        : await fetchDirect()

      // Check if component unmounted during the async fetch
      // (the ref value can change between the initial check and here)
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!isMountedRef.current) return

      if (events.length > 0) {
        onEventsRef.current(events)
      }

      // Calculate seq for SSE (number of complete 3-byte records)
      const seq = Math.floor(byteLength / 3)

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
      }, STREAM_RECONNECT_DELAY_MS)
    }
  }, [connectSSE, fetchViaProxy, fetchDirect])

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
