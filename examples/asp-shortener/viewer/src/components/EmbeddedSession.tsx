import { useLayoutEffect, useRef, useState } from "react"
import { useNormalizedStream } from "../lib/stream"
import { Conversation } from "./Conversation"
import { PromptInput } from "./PromptInput"
import type { ResolvedEntry } from "../lib/types"

interface Props {
  entry: ResolvedEntry
  token: string | null
  onSubmitToken: (token: string) => void
}

// How close to the bottom (px) we count as "at the bottom" for sticky-scroll.
const STICKY_BOTTOM_THRESHOLD = 60

export function EmbeddedSession({
  entry,
  token,
  onSubmitToken,
}: Props): JSX.Element {
  if (!token) {
    return <TokenGate entry={entry} onSubmit={onSubmitToken} />
  }
  return <SessionStream entry={entry} token={token} />
}

function TokenGate({
  entry,
  onSubmit,
}: {
  entry: ResolvedEntry
  onSubmit: (token: string) => void
}): JSX.Element {
  const [value, setValue] = useState(``)

  const submit = (): void => {
    const trimmed = value.trim()
    if (trimmed) onSubmit(trimmed)
  }

  return (
    <section className="embedded-session">
      <div className="embedded-session-header">
        <h2>Watch in browser</h2>
        <span className={`badge ${entry.live ? `live` : `snapshot`}`}>
          {entry.live ? `Live` : `Snapshot`}
        </span>
      </div>
      <div className="token-gate">
        <p className="token-gate-intro">
          Paste the Durable Streams auth token that has access to this session
          to watch the conversation in your browser. The token stays in your
          browser — it's never sent to the shortener.
        </p>
        <form
          className="token-gate-form"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <input
            type="password"
            placeholder="Auth token (eyJ...)"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Auth token"
          />
          <button
            className="btn primary"
            type="submit"
            disabled={!value.trim()}
          >
            Watch
          </button>
        </form>
      </div>
    </section>
  )
}

function SessionStream({
  entry,
  token,
}: {
  entry: ResolvedEntry
  token: string
}): JSX.Element {
  const state = useNormalizedStream({
    fullUrl: entry.fullUrl,
    token,
    live: entry.live,
  })
  const scrollRef = useRef<HTMLDivElement>(null)
  const didInitialScroll = useRef(false)
  // Sticky-bottom: true if user is currently at (or near) the bottom of the
  // scroll container. We update this on scroll. When new events arrive in
  // live mode, we only auto-scroll if this is true — so a user reviewing
  // older history won't be yanked away.
  const stickToBottomRef = useRef(true)

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom < STICKY_BOTTOM_THRESHOLD
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (state.events.length === 0) return

    if (!didInitialScroll.current) {
      // First batch of events — pin to bottom regardless of mode.
      el.scrollTop = el.scrollHeight
      didInitialScroll.current = true
      stickToBottomRef.current = true
      return
    }

    // Subsequent batches: only auto-scroll for live sessions, and only if
    // the user was at the bottom (i.e. they're following along live).
    if (entry.live && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [state.events.length, entry.live])

  let statusLabel: string
  let statusCls: string
  if (state.status === `loading`) {
    statusLabel = `Connecting…`
    statusCls = `snapshot`
  } else if (state.status === `error`) {
    statusLabel = `Disconnected`
    statusCls = `ended`
  } else if (state.status === `ended`) {
    statusLabel = `Ended`
    statusCls = `ended`
  } else {
    statusLabel = entry.live ? `Live` : `Snapshot`
    statusCls = entry.live ? `live` : `snapshot`
  }

  return (
    <section className="embedded-session">
      <div className="embedded-session-header">
        <h2>Session</h2>
        <span className={`badge ${statusCls}`}>{statusLabel}</span>
        <span className="embedded-session-count">
          {state.events.length} events
        </span>
      </div>
      <div
        className="embedded-session-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
      >
        {state.status === `loading` && (
          <div className="embedded-session-placeholder">Loading session…</div>
        )}
        {state.status === `error` && (
          <div className="embedded-session-placeholder error-state">
            Failed to connect: {state.error}
          </div>
        )}
        {(state.status === `connected` || state.status === `ended`) && (
          <Conversation events={state.events} embedded />
        )}
      </div>
      {entry.live && (
        <PromptInput
          fullUrl={entry.fullUrl}
          token={token}
          disabled={state.status === `ended` || state.status === `error`}
        />
      )}
    </section>
  )
}
