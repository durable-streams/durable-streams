import { useEffect, useState } from "react"
import { DurableStream } from "@durable-streams/client"
import type { NormalizedEvent } from "./types"

export interface StreamState {
  events: Array<NormalizedEvent>
  error: string | null
  status: `loading` | `connected` | `error` | `ended`
}

interface UseStreamOptions {
  fullUrl: string
  token: string
  live: boolean
}

/**
 * Subscribe to a normalized DS stream. For live mode, opens an SSE connection
 * and continuously receives new events. For snapshot mode, fetches all current
 * contents once and stops.
 */
export function useNormalizedStream(opts: UseStreamOptions): StreamState {
  const [state, setState] = useState<StreamState>({
    events: [],
    error: null,
    status: `loading`,
  })

  useEffect(() => {
    let cancelled = false
    const stream = new DurableStream({
      url: opts.fullUrl,
      contentType: `application/json`,
      headers: { Authorization: `Bearer ${opts.token}` },
    })

    let close: (() => void) | null = null

    void (async () => {
      try {
        const response = await stream.stream<NormalizedEvent>({
          json: true,
          live: opts.live ? `sse` : false,
          offset: `-1`,
        })

        if (cancelled) return

        if (opts.live) {
          // Subscribe for ongoing updates
          close = response.subscribeJson((batch) => {
            if (cancelled) return
            setState((prev) => {
              const newItems = batch.items
              if (newItems.length === 0) return prev
              const events = [...prev.events, ...newItems]
              // The session is "ended" iff the most recent event we've seen
              // is a session_end. This handles two cases naturally:
              //   1. Live SSE delivers historical events in multiple batches
              //      where session_end is in a middle batch with later
              //      batches following — looking at the tail still says
              //      "ended" because the very last event IS session_end.
              //   2. The watcher restarts after stopping — new events get
              //      appended after the old session_end, the tail is no
              //      longer session_end, and the badge correctly flips
              //      back to "live".
              const last = events[events.length - 1]
              const isEnded = last?.type === `session_end`
              return {
                events,
                error: null,
                status: isEnded ? `ended` : `connected`,
              }
            })
          })
          // Promote `loading` → `connected`, but don't clobber a status the
          // subscribe callback may have already set (e.g. `ended`, `error`).
          setState((prev) =>
            prev.status === `loading` ? { ...prev, status: `connected` } : prev
          )
        } else {
          // One-shot read for snapshots
          const items = await response.json()
          if (cancelled) return
          setState({
            events: items,
            error: null,
            status: `connected`,
          })
        }
      } catch (error) {
        if (cancelled) return
        setState({
          events: [],
          error: error instanceof Error ? error.message : String(error),
          status: `error`,
        })
      }
    })()

    return () => {
      cancelled = true
      close?.()
    }
  }, [opts.fullUrl, opts.token, opts.live])

  return state
}
