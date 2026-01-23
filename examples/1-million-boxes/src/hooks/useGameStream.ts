import { useCallback, useEffect, useRef } from "react"
import { DurableStream } from "@durable-streams/client"
import { StreamParser } from "../lib/stream-parser"
import {
  GAME_STREAM_URL,
  STREAM_PROXY_ENDPOINT,
  STREAM_RECONNECT_DELAY_MS,
  USE_STREAM_PROXY,
} from "../lib/config"
import type { StreamResponse } from "@durable-streams/client"
import type { GameEvent } from "../lib/game-state"

export interface UseGameStreamOptions {
  onEvents: (events: Array<GameEvent>) => void
  onError?: (error: Error) => void
  onConnected?: () => void
  onDisconnected?: () => void
  enabled?: boolean
}

export interface UseGameStreamResult {
  disconnect: () => void
  reconnect: () => void
}

/**
 * Get the URL for stream connections.
 */
function getStreamUrl(): string {
  if (USE_STREAM_PROXY) {
    const origin =
      typeof window !== `undefined`
        ? window.location.origin
        : `http://localhost:5173`
    return `${origin}${STREAM_PROXY_ENDPOINT}`
  }
  return GAME_STREAM_URL
}

/**
 * Hook for connecting to the game event stream using the DurableStream client.
 *
 * Uses the @durable-streams/client library's DurableStream class for
 * proper SSE handling with automatic reconnection.
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

  const streamRef = useRef<DurableStream | null>(null)
  const streamResponseRef = useRef<StreamResponse | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const parserRef = useRef<StreamParser>(new StreamParser())
  const isConnectedRef = useRef(false)
  const isMountedRef = useRef(true)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Store callbacks in refs
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

  const scheduleReconnect = useCallback((delayMs: number) => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
    }

    reconnectTimeoutRef.current = setTimeout(() => {
      reconnectTimeoutRef.current = null
      if (isMountedRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        connect()
      }
    }, delayMs)
  }, [])

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

    const streamUrl = getStreamUrl()
    console.log(`[useGameStream] Connecting to: ${streamUrl}`)

    try {
      // Create or reuse DurableStream instance
      if (!streamRef.current) {
        streamRef.current = new DurableStream({ url: streamUrl })
      }

      // Check if stream exists, create if it doesn't
      try {
        await streamRef.current.head()
        console.log(`[useGameStream] Stream exists`)
      } catch {
        console.log(`[useGameStream] Stream not found, creating...`)
        await DurableStream.create({
          url: streamUrl,
          contentType: `application/octet-stream`,
        })
        console.log(`[useGameStream] Stream created`)
      }

      if (!isMountedRef.current) return

      // Start streaming with SSE
      const response = await streamRef.current.stream({
        live: `sse`,
      })

      if (!isMountedRef.current) {
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
        if (!isMountedRef.current) return

        try {
          const events = parserRef.current.feed(chunk.data)
          if (events.length > 0) {
            onEventsRef.current(events)
          }
        } catch (err) {
          console.error(`[useGameStream] Error parsing chunk:`, err)
          onErrorRef.current?.(
            err instanceof Error ? err : new Error(String(err))
          )
        }
      })

      // Handle stream completion
      response.closed
        .then(() => {
          if (isMountedRef.current) {
            console.log(`[useGameStream] Stream closed, reconnecting...`)
            if (isConnectedRef.current) {
              isConnectedRef.current = false
              onDisconnectedRef.current?.()
            }
            scheduleReconnect(STREAM_RECONNECT_DELAY_MS)
          }
        })
        .catch((err: unknown) => {
          if (isMountedRef.current) {
            console.error(`[useGameStream] Stream error:`, err)
            if (isConnectedRef.current) {
              isConnectedRef.current = false
              onDisconnectedRef.current?.()
            }
            onErrorRef.current?.(
              err instanceof Error ? err : new Error(String(err))
            )
            scheduleReconnect(STREAM_RECONNECT_DELAY_MS)
          }
        })
    } catch (err) {
      console.error(`[useGameStream] Connection error:`, err)
      onErrorRef.current?.(
        err instanceof Error ? err : new Error(String(err))
      )

      if (isMountedRef.current) {
        scheduleReconnect(STREAM_RECONNECT_DELAY_MS)
      }
    }
  }, [scheduleReconnect])

  const reconnect = useCallback(() => {
    disconnect()
    // Clear the stream ref to force a new instance
    streamRef.current = null
    setTimeout(() => {
      if (isMountedRef.current) {
        connect()
      }
    }, 100)
  }, [disconnect, connect])

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
