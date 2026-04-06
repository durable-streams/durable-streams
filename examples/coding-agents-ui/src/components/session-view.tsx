import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import type {
  BridgeEnvelope,
  StreamEnvelope,
} from "@durable-streams/coding-agents"
import type { SessionSummary } from "~/lib/session-types"
import type { DisplayEvent } from "~/hooks/use-session-stream"
import { createBrowserSessionClient } from "~/lib/browser-session-client"
import { useBrowserUser } from "~/hooks/use-browser-user"
import { useSessionStream } from "~/hooks/use-session-stream"
import { useSessions } from "~/lib/sessions-context"

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function isBridgeEnvelope(
  envelope: StreamEnvelope
): envelope is BridgeEnvelope {
  return envelope.direction === `bridge`
}

function summarizeEvent(event: DisplayEvent): {
  tone: string
  title: string
  body?: string
} {
  if (event.envelope.direction === `user`) {
    if (event.envelope.raw.type === `user_message`) {
      return {
        tone: `user`,
        title: event.envelope.user.name,
        body: event.envelope.raw.text,
      }
    }

    if (event.envelope.raw.type === `interrupt`) {
      return {
        tone: `user`,
        title: event.envelope.user.name,
        body: `Interrupted the active turn.`,
      }
    }

    return {
      tone: `user`,
      title: event.envelope.user.name,
      body: `Sent a control response.`,
    }
  }

  if (isBridgeEnvelope(event.envelope)) {
    return {
      tone: `bridge`,
      title: event.envelope.type,
      body:
        `source` in event.envelope
          ? stringify({
              source: event.envelope.source,
              raw: event.envelope.raw,
            })
          : undefined,
    }
  }

  if (!event.normalized) {
    return {
      tone: `agent`,
      title: `raw agent message`,
      body: stringify(event.envelope.raw),
    }
  }

  switch (event.normalized.type) {
    case `assistant_message`:
      return {
        tone: `agent`,
        title: `assistant`,
        body: event.normalized.content
          .map((part) => {
            switch (part.type) {
              case `text`:
              case `thinking`:
                return part.text
              case `tool_use`:
                return `[tool:${part.name}] ${stringify(part.input)}`
              case `tool_result`:
                return part.output
            }
          })
          .join(`\n`),
      }

    case `permission_request`:
      return {
        tone: `approval`,
        title: `approval · ${event.normalized.tool}`,
        body: stringify(event.normalized.input),
      }

    case `stream_delta`:
      return {
        tone: `delta`,
        title: `delta · ${event.normalized.delta.kind}`,
        body: event.normalized.delta.text,
      }

    case `turn_complete`:
      return {
        tone: event.normalized.success ? `success` : `error`,
        title: event.normalized.success ? `turn complete` : `turn failed`,
        body: event.normalized.cost
          ? stringify(event.normalized.cost)
          : undefined,
      }

    case `session_init`:
      return {
        tone: `bridge`,
        title: `session init`,
        body: stringify(event.normalized),
      }

    case `status_change`:
      return {
        tone: `bridge`,
        title: `status`,
        body: event.normalized.status,
      }

    case `tool_call`:
      return {
        tone: `agent`,
        title: `tool call · ${event.normalized.tool}`,
        body: stringify(event.normalized.input),
      }

    case `tool_progress`:
      return {
        tone: `agent`,
        title: `tool progress`,
        body: `${event.normalized.elapsed}ms`,
      }

    case `unknown`:
      return {
        tone: `delta`,
        title: `unknown · ${event.normalized.rawType}`,
        body: stringify(event.normalized.raw),
      }
  }

  return {
    tone: `delta`,
    title: `event`,
  }
}

function shouldRenderByDefault(event: DisplayEvent): boolean {
  if (event.envelope.direction === `agent`) {
    return (
      event.normalized?.type === `assistant_message` ||
      event.normalized?.type === `permission_request` ||
      event.normalized?.type === `turn_complete` ||
      event.normalized?.type === `session_init` ||
      event.normalized?.type === `status_change` ||
      event.normalized?.type === `tool_call`
    )
  }

  if (event.envelope.direction === `bridge`) {
    return (
      event.envelope.type === `session_started` ||
      event.envelope.type === `session_resumed` ||
      event.envelope.type === `session_ended`
    )
  }

  return true
}

function buildAllowResponse(event: DisplayEvent): object {
  if (event.normalized?.type !== `permission_request`) {
    return { behavior: `allow` }
  }

  if (event.envelope.agent === `claude`) {
    return {
      behavior: `allow`,
      updatedInput: event.normalized.input,
    }
  }

  if (event.normalized.tool === `permissions`) {
    return {
      permissions: event.normalized.input,
      scope: `turn`,
    }
  }

  return { behavior: `allow` }
}

function firstChoiceResponse(event: DisplayEvent): object | null {
  if (event.normalized?.type !== `permission_request`) {
    return null
  }

  if (event.normalized.tool !== `request_user_input`) {
    return null
  }

  const input = event.normalized.input as {
    questions?: Array<Record<string, unknown>>
  }
  const question = Array.isArray(input.questions)
    ? input.questions[0]
    : undefined
  if (!question || typeof question !== `object`) {
    return null
  }

  const questionId = typeof question.id === `string` ? question.id : `choice`
  const options = Array.isArray(question.options) ? question.options : []
  const option = options[0] as Record<string, unknown> | undefined
  const value =
    (typeof option?.value === `string` ? option.value : undefined) ??
    (typeof option?.label === `string` ? option.label : undefined)

  if (!value) {
    return null
  }

  return {
    answers: {
      [questionId]: {
        answers: [value],
      },
    },
  }
}

function buildDenyResponse(event: DisplayEvent): object {
  if (event.normalized?.type !== `permission_request`) {
    return { behavior: `deny` }
  }

  if (event.envelope.agent === `claude`) {
    return {
      behavior: `deny`,
      message: `Denied by user`,
    }
  }

  return { behavior: `deny` }
}

function EventCard({
  event,
  showRaw,
}: {
  event: DisplayEvent
  showRaw: boolean
}) {
  const summary = summarizeEvent(event)

  return (
    <article className={`event-card tone-${summary.tone}`}>
      <div className="event-meta">
        <span>{summary.title}</span>
        <span>
          {new Date(event.envelope.timestamp).toLocaleTimeString([], {
            hour: `2-digit`,
            minute: `2-digit`,
            second: `2-digit`,
          })}
        </span>
      </div>
      {summary.body && <pre className="event-body">{summary.body}</pre>}
      {showRaw && (
        <details className="raw-details">
          <summary>raw envelope</summary>
          <pre className="raw-block">{stringify(event.envelope)}</pre>
        </details>
      )}
    </article>
  )
}

export function SessionView({
  initialSession,
}: {
  initialSession: SessionSummary
}) {
  const navigate = useNavigate()
  const { replaceSession } = useSessions()
  const { user } = useBrowserUser()
  const [session, setSession] = useState(initialSession)
  const [prompt, setPrompt] = useState(``)
  const [submitting, setSubmitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [showVerbose, setShowVerbose] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)

  const writer = useMemo(
    () =>
      createBrowserSessionClient({
        agent: session.agent,
        streamUrl: session.clientStreamUrl,
        user,
      }),
    [session.agent, session.clientStreamUrl, user]
  )

  useEffect(() => {
    return () => {
      void writer.close()
    }
  }, [writer])

  const { events, pendingApprovals, error } = useSessionStream(
    session.agent,
    session.clientStreamUrl
  )

  useEffect(() => {
    feedRef.current?.scrollTo({
      top: feedRef.current.scrollHeight,
      behavior: `smooth`,
    })
  }, [events.length, pendingApprovals.length])

  const visibleEvents = useMemo(
    () => (showVerbose ? events : events.filter(shouldRenderByDefault)),
    [events, showVerbose]
  )

  const lastLifecycle = useMemo(() => {
    return [...events]
      .reverse()
      .find(
        (event) =>
          event.envelope.direction === `bridge` &&
          (event.envelope.type === `session_started` ||
            event.envelope.type === `session_resumed` ||
            event.envelope.type === `session_ended`)
      )
  }, [events])

  const sendPrompt = () => {
    if (!prompt.trim()) {
      return
    }

    writer.prompt(prompt.trim())
    setPrompt(``)
  }

  const controlBridge = async (action: `resume` | `restart` | `stop`) => {
    setSubmitting(true)
    setActionError(null)

    try {
      const response = await fetch(`/api/session-control`, {
        method: `POST`,
        headers: {
          "Content-Type": `application/json`,
        },
        body: JSON.stringify({
          id: session.id,
          action,
        }),
      })

      if (!response.ok) {
        throw new Error(await response.text())
      }

      const nextSession = (await response.json()) as SessionSummary
      setSession(nextSession)
      replaceSession(nextSession)
      if (action === `stop`) {
        await navigate({
          to: `/session/$id`,
          params: { id: nextSession.id },
        })
      }
    } catch (controlError) {
      setActionError(
        controlError instanceof Error
          ? controlError.message
          : String(controlError)
      )
    } finally {
      setSubmitting(false)
    }
  }

  const copyShareLink = async () => {
    await navigator.clipboard.writeText(window.location.href)
  }

  return (
    <section className="session-stage">
      <header className="stage-header">
        <div>
          <p className="eyebrow">Session</p>
          <h2>{session.title}</h2>
          <p className="stage-copy">
            {session.agent} · {session.cwd}
          </p>
        </div>

        <div className="stage-actions">
          <span className={`badge ${session.active ? `live` : `idle`}`}>
            {session.active ? `bridge running` : `bridge stopped`}
          </span>
          <button
            className="secondary-button"
            onClick={() =>
              void controlBridge(session.active ? `restart` : `resume`)
            }
            disabled={submitting}
          >
            {session.active ? `Restart Bridge` : `Resume Bridge`}
          </button>
          <button
            className="secondary-button"
            onClick={() => writer.interrupt()}
            disabled={submitting}
          >
            Interrupt
          </button>
          <button
            className="secondary-button"
            onClick={() => void controlBridge(`stop`)}
            disabled={submitting || !session.active}
          >
            Stop
          </button>
          <button
            className="secondary-button"
            onClick={() => void copyShareLink()}
          >
            Copy Link
          </button>
        </div>
      </header>

      <div className="stage-stats">
        <span>events {events.length}</span>
        <span>pending approvals {pendingApprovals.length}</span>
        <span>
          last lifecycle{` `}
          {lastLifecycle?.envelope.direction === `bridge`
            ? lastLifecycle.envelope.type
            : `none`}
        </span>
        {session.debugStream && <span>debug stream on</span>}
      </div>

      {(actionError || error) && (
        <div className="inline-error">{actionError ?? error}</div>
      )}

      {pendingApprovals.length > 0 && (
        <section className="approval-panel">
          <div className="section-head">
            <h3>Pending approvals</h3>
            <span>{pendingApprovals.length}</span>
          </div>
          <div className="approval-list">
            {pendingApprovals.map((event) => {
              const summary = summarizeEvent(event)
              const quickChoice = firstChoiceResponse(event)

              return (
                <article key={event.id} className="approval-card">
                  <div className="approval-head">
                    <strong>{summary.title}</strong>
                    <span>#{event.normalized.id}</span>
                  </div>
                  <pre className="approval-body">{summary.body}</pre>
                  <div className="approval-actions">
                    {quickChoice ? (
                      <button
                        className="primary-button"
                        onClick={() =>
                          writer.respond(event.normalized.id, quickChoice)
                        }
                      >
                        Answer First Option
                      </button>
                    ) : (
                      <button
                        className="primary-button"
                        onClick={() =>
                          writer.respond(
                            event.normalized.id,
                            buildAllowResponse(event)
                          )
                        }
                      >
                        Allow
                      </button>
                    )}

                    {event.normalized.tool !== `permissions` &&
                      event.normalized.tool !== `request_user_input` && (
                        <button
                          className="secondary-button"
                          onClick={() =>
                            writer.respond(
                              event.normalized.id,
                              buildDenyResponse(event)
                            )
                          }
                        >
                          Deny
                        </button>
                      )}

                    <button
                      className="secondary-button"
                      onClick={() => writer.cancelApproval(event.normalized.id)}
                    >
                      Cancel
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      )}

      <div className="feed-toolbar">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={showVerbose}
            onChange={(event) => setShowVerbose(event.target.checked)}
          />
          <span>Show deltas and debug noise</span>
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={showRaw}
            onChange={(event) => setShowRaw(event.target.checked)}
          />
          <span>Show raw envelopes</span>
        </label>
      </div>

      <div ref={feedRef} className="event-feed">
        {visibleEvents.length === 0 ? (
          <div className="empty-state">
            <h3>No events yet</h3>
            <p>
              Send a prompt or resume the bridge to start streaming activity.
            </p>
          </div>
        ) : (
          visibleEvents.map((event) => (
            <EventCard key={event.id} event={event} showRaw={showRaw} />
          ))
        )}
      </div>

      <div className="composer">
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Ask the agent to inspect, edit, or explain something…"
        />
        <div className="composer-actions">
          <span className="composer-hint">
            User intents are durable even if the bridge is stopped.
          </span>
          <button className="primary-button" onClick={() => void sendPrompt()}>
            Send Prompt
          </button>
        </div>
      </div>
    </section>
  )
}
