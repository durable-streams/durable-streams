import { startTransition, useEffect, useMemo, useRef, useState } from "react"
import {
  normalizeClaude,
  normalizeCodex,
} from "@durable-streams/coding-agents/normalize"
import type { NormalizedEvent } from "@durable-streams/coding-agents/normalize"
import type { AgentType, StreamEnvelope } from "@durable-streams/coding-agents"
import { streamSessionHistory } from "~/lib/browser-session-client"

export interface DisplayEvent {
  id: string
  envelope: StreamEnvelope
  normalized?: NormalizedEvent | null
}

function normalizeEnvelope(
  agent: AgentType,
  envelope: StreamEnvelope
): NormalizedEvent | null | undefined {
  if (envelope.direction !== `agent`) {
    return undefined
  }

  return agent === `claude`
    ? normalizeClaude(envelope.raw)
    : normalizeCodex(envelope.raw)
}

export function derivePendingApprovals(events: Array<DisplayEvent>): Array<
  DisplayEvent & {
    normalized: Extract<NormalizedEvent, { type: `permission_request` }>
  }
> {
  const pending = new Map<
    string,
    DisplayEvent & {
      normalized: Extract<NormalizedEvent, { type: `permission_request` }>
    }
  >()

  for (const event of events) {
    if (event.normalized?.type === `permission_request`) {
      pending.set(String(event.normalized.id), event as never)
      continue
    }

    if (
      event.envelope.direction === `user` &&
      event.envelope.raw.type === `control_response`
    ) {
      pending.delete(String(event.envelope.raw.response.request_id))
      continue
    }

    if (
      event.normalized?.type === `turn_complete` ||
      (event.envelope.direction === `bridge` &&
        event.envelope.type === `session_ended`)
    ) {
      pending.clear()
    }
  }

  return [...pending.values()]
}

export function useSessionStream(agent: AgentType, streamUrl: string) {
  const [events, setEvents] = useState<Array<DisplayEvent>>([])
  const [error, setError] = useState<string | null>(null)
  const seenEnvelopeKeysRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const abortController = new AbortController()
    seenEnvelopeKeysRef.current = new Set()
    setEvents([])
    setError(null)

    void streamSessionHistory({
      streamUrl,
      signal: abortController.signal,
      onEnvelope(envelope) {
        const envelopeKey = JSON.stringify(envelope)
        if (seenEnvelopeKeysRef.current.has(envelopeKey)) {
          return
        }

        seenEnvelopeKeysRef.current.add(envelopeKey)
        const normalized = normalizeEnvelope(agent, envelope)

        startTransition(() => {
          setEvents((current) => [
            ...current,
            {
              id: envelopeKey,
              envelope,
              normalized,
            },
          ])
        })
      },
    }).catch((streamError: unknown) => {
      if (
        typeof streamError === `object` &&
        streamError !== null &&
        `name` in streamError &&
        (streamError as { name?: unknown }).name === `AbortError`
      ) {
        return
      }

      setError(
        streamError instanceof Error ? streamError.message : String(streamError)
      )
    })

    return () => {
      abortController.abort()
    }
  }, [agent, streamUrl])

  const pendingApprovals = useMemo(
    () => derivePendingApprovals(events),
    [events]
  )

  return {
    events,
    pendingApprovals,
    error,
  }
}
