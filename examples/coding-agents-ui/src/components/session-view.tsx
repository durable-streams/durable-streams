import { useEffect, useRef, useState } from "react"
import type {
  AgentTimelineEntry,
  PermissionRequestRow,
} from "@durable-streams/coding-agents/agent-db"
import type { SessionSummary } from "~/lib/session-types"
import { useAgentDBSession } from "~/hooks/use-agent-db-session"
import { useBrowserUser } from "~/hooks/use-browser-user"
import { useSessions } from "~/lib/sessions-context"

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function summarizeEntry(entry: AgentTimelineEntry): {
  tone: string
  title: string
  body?: string
} {
  switch (entry.kind) {
    case `user_message`:
      return {
        tone: `user`,
        title: entry.participant?.name ?? `user`,
        body: entry.text,
      }
    case `assistant_message`:
      return {
        tone: `agent`,
        title: `assistant`,
        body: entry.text,
      }
    case `permission_request`:
      return {
        tone: `approval`,
        title: `approval · ${entry.permissionRequest?.toolName ?? `tool`}`,
        body: stringify(entry.permissionRequest?.input),
      }
    case `approval_response`:
      return {
        tone: `user`,
        title: `${entry.participant?.name ?? `user`} approval`,
        body: stringify({
          decision: entry.approvalResponse?.decision,
          message: entry.approvalResponse?.message,
          updatedInput: entry.approvalResponse?.updatedInput,
          effective: entry.approvalResponse?.effective,
        }),
      }
    case `turn_complete`:
      return {
        tone: entry.turn?.status === `completed` ? `success` : `error`,
        title:
          entry.turn?.status === `completed` ? `turn complete` : `turn failed`,
        body: stringify({
          inputTokens: entry.turn?.inputTokens,
          outputTokens: entry.turn?.outputTokens,
          cachedInputTokens: entry.turn?.cachedInputTokens,
          reasoningOutputTokens: entry.turn?.reasoningOutputTokens,
          costUsd: entry.turn?.costUsd,
        }),
      }
    case `session_event`:
      if (entry.sessionEvent?.kind === `status_change`) {
        return {
          tone: `bridge`,
          title: `status`,
          body:
            typeof entry.sessionEvent.data === `object` &&
            entry.sessionEvent.data !== null &&
            `status` in entry.sessionEvent.data
              ? String(
                  (entry.sessionEvent.data as { status?: unknown }).status ?? ``
                )
              : undefined,
        }
      }
      return {
        tone: `bridge`,
        title:
          entry.sessionEvent?.kind === `session_init`
            ? `session init`
            : (entry.sessionEvent?.kind ?? `session event`),
        body: entry.sessionEvent?.data
          ? stringify(entry.sessionEvent.data)
          : undefined,
      }
    case `tool_call`:
      return {
        tone: `agent`,
        title: `tool call · ${entry.toolCall?.toolName ?? `tool`}`,
        body: stringify(entry.toolCall?.input ?? entry.toolCall?.output),
      }
  }

  return {
    tone: `bridge`,
    title: `event`,
    body: stringify(entry),
  }
}

function shouldRenderByDefault(entry: AgentTimelineEntry): boolean {
  return (
    entry.kind === `user_message` ||
    entry.kind === `assistant_message` ||
    entry.kind === `permission_request` ||
    entry.kind === `approval_response` ||
    entry.kind === `turn_complete` ||
    entry.kind === `tool_call` ||
    (entry.kind === `session_event` &&
      (entry.sessionEvent?.kind === `session_started` ||
        entry.sessionEvent?.kind === `session_resumed` ||
        entry.sessionEvent?.kind === `session_ended` ||
        entry.sessionEvent?.kind === `session_init` ||
        entry.sessionEvent?.kind === `interrupt_requested` ||
        entry.sessionEvent?.kind === `status_change`))
  )
}

function buildAllowResponse(
  agent: SessionSummary[`agent`],
  request: PermissionRequestRow
): object {
  if (agent === `claude`) {
    return {
      behavior: `allow`,
      updatedInput: request.input,
    }
  }

  if (request.toolName === `permissions`) {
    return {
      permissions: request.input,
      scope: `turn`,
    }
  }

  return { behavior: `allow` }
}

function firstChoiceResponse(request: PermissionRequestRow): object | null {
  if (request.toolName !== `request_user_input`) {
    return null
  }

  const input = request.input as {
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

function buildDenyResponse(
  agent: SessionSummary[`agent`],
  _request: PermissionRequestRow
): object {
  if (agent === `claude`) {
    return {
      behavior: `deny`,
      message: `Denied by user`,
    }
  }

  return { behavior: `deny` }
}

function EventCard({
  entry,
  showRaw,
}: {
  entry: AgentTimelineEntry
  showRaw: boolean
}) {
  const summary = summarizeEntry(entry)

  return (
    <article className={`event-card tone-${summary.tone}`}>
      <div className="event-meta">
        <span>{summary.title}</span>
        <span>
          {new Date(entry.createdAt).toLocaleTimeString([], {
            hour: `2-digit`,
            minute: `2-digit`,
            second: `2-digit`,
          })}
        </span>
      </div>
      {summary.body && <pre className="event-body">{summary.body}</pre>}
      {showRaw && (
        <details className="raw-details">
          <summary>raw row</summary>
          <pre className="raw-block">{stringify(entry)}</pre>
        </details>
      )}
    </article>
  )
}

function buildPendingApprovalSummary(request: PermissionRequestRow): {
  title: string
  body?: string
} {
  return {
    title: `approval · ${request.toolName ?? `tool`}`,
    body: stringify(request.input),
  }
}

function sessionBadge(session: SessionSummary): {
  tone: string
  label: string
} {
  switch (session.pendingAction) {
    case `starting`:
      return { tone: `idle`, label: `starting session` }
    case `resuming`:
      return { tone: `live`, label: `resuming bridge` }
    case `restarting`:
      return { tone: `live`, label: `restarting bridge` }
    case `stopping`:
      return { tone: `idle`, label: `stopping bridge` }
    default:
      return session.active
        ? { tone: `live`, label: `bridge running` }
        : { tone: `idle`, label: `bridge stopped` }
  }
}

export function SessionView({
  initialSession,
}: {
  initialSession: SessionSummary
}) {
  const { sessions, controlSession } = useSessions()
  const { user } = useBrowserUser()
  const [prompt, setPrompt] = useState(``)
  const [submitting, setSubmitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [showVerbose, setShowVerbose] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)
  const session =
    sessions.find((entry) => entry.id === initialSession.id) ?? initialSession
  const isStarting = session.pendingAction === `starting`
  const isPendingControl =
    session.pendingAction === `resuming` ||
    session.pendingAction === `restarting` ||
    session.pendingAction === `stopping`
  const badge = sessionBadge(session)

  const {
    db,
    timelineEntries,
    timelineRow,
    pendingApprovals,
    sessionHeader,
    error,
  } = useAgentDBSession(session.clientStreamUrl, session.id, !isStarting)

  useEffect(() => {
    feedRef.current?.scrollTo({
      top: feedRef.current.scrollHeight,
      behavior: `smooth`,
    })
  }, [timelineEntries.length, pendingApprovals.length])

  const visibleEntries = showVerbose
    ? timelineEntries
    : timelineEntries.filter(shouldRenderByDefault)

  const lastLifecycle = [...timelineEntries]
    .reverse()
    .find(
      (entry) =>
        entry.kind === `session_event` &&
        (entry.sessionEvent?.kind === `session_started` ||
          entry.sessionEvent?.kind === `session_resumed` ||
          entry.sessionEvent?.kind === `session_ended`)
    )

  const sendPrompt = () => {
    if (!prompt.trim()) {
      return
    }

    db.actions.prompt({
      agent: session.agent,
      user,
      text: prompt.trim(),
    })
    setPrompt(``)
  }

  const controlBridge = async (action: `resume` | `restart` | `stop`) => {
    setSubmitting(true)
    setActionError(null)

    try {
      const transaction = controlSession(session, action)
      await transaction.isPersisted.promise
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
          <span className={`badge ${badge.tone}`}>{badge.label}</span>
          <button
            className="secondary-button"
            onClick={() =>
              void controlBridge(session.active ? `restart` : `resume`)
            }
            disabled={submitting || isStarting || isPendingControl}
          >
            {isStarting
              ? `Starting…`
              : session.active
                ? `Restart Bridge`
                : `Resume Bridge`}
          </button>
          <button
            className="secondary-button"
            onClick={() =>
              db.actions.interrupt({
                agent: session.agent,
                user,
              })
            }
            disabled={submitting || isStarting || isPendingControl}
          >
            Interrupt
          </button>
          <button
            className="secondary-button"
            onClick={() => void controlBridge(`stop`)}
            disabled={
              submitting || !session.active || isStarting || isPendingControl
            }
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
        <span>events {visibleEntries.length}</span>
        <span>pending approvals {pendingApprovals.length}</span>
        <span>
          last lifecycle{` `}
          {lastLifecycle?.sessionEvent?.kind ?? `none`}
        </span>
        {isStarting && <span>session creation pending</span>}
        {sessionHeader?.status && <span>status {sessionHeader.status}</span>}
        {timelineRow.turns.length > 0 && (
          <span>turns {timelineRow.turns.length}</span>
        )}
        {session.debugStream && <span>debug stream on</span>}
      </div>

      {(actionError || error) && (
        <div className="inline-error">{actionError ?? error}</div>
      )}

      {isStarting && !actionError && !error && (
        <div className="inline-error">
          Waiting for the session stream to be created before attaching the live
          reader.
        </div>
      )}

      {pendingApprovals.length > 0 && (
        <section className="approval-panel">
          <div className="section-head">
            <h3>Pending approvals</h3>
            <span>{pendingApprovals.length}</span>
          </div>
          <div className="approval-list">
            {pendingApprovals.map((request) => {
              const summary = buildPendingApprovalSummary(request)
              const quickChoice = firstChoiceResponse(request)

              return (
                <article key={request.id} className="approval-card">
                  <div className="approval-head">
                    <strong>{summary.title}</strong>
                    <span>#{request.id}</span>
                  </div>
                  <pre className="approval-body">{summary.body}</pre>
                  <div className="approval-actions">
                    {quickChoice ? (
                      <button
                        className="primary-button"
                        onClick={() =>
                          db.actions.respond({
                            agent: session.agent,
                            user,
                            requestId: request.id,
                            response: quickChoice,
                          })
                        }
                      >
                        Answer First Option
                      </button>
                    ) : (
                      <button
                        className="primary-button"
                        onClick={() =>
                          db.actions.respond({
                            agent: session.agent,
                            user,
                            requestId: request.id,
                            response: buildAllowResponse(
                              session.agent,
                              request
                            ),
                          })
                        }
                      >
                        Allow
                      </button>
                    )}

                    {request.toolName !== `permissions` &&
                      request.toolName !== `request_user_input` && (
                        <button
                          className="secondary-button"
                          onClick={() =>
                            db.actions.respond({
                              agent: session.agent,
                              user,
                              requestId: request.id,
                              response: buildDenyResponse(
                                session.agent,
                                request
                              ),
                            })
                          }
                        >
                          Deny
                        </button>
                      )}

                    <button
                      className="secondary-button"
                      onClick={() =>
                        db.actions.cancel({
                          agent: session.agent,
                          user,
                          requestId: request.id,
                        })
                      }
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
          <span>Show raw query rows</span>
        </label>
      </div>

      <div ref={feedRef} className="event-feed">
        {visibleEntries.length === 0 ? (
          <div className="empty-state">
            <h3>No events yet</h3>
            <p>
              {isStarting
                ? `The session record exists locally. Stream reads will begin as soon as the server finishes creating the session.`
                : `Send a prompt or resume the bridge to start streaming activity.`}
            </p>
          </div>
        ) : (
          visibleEntries.map((entry) => (
            <EventCard key={entry.id} entry={entry} showRaw={showRaw} />
          ))
        )}
      </div>

      <div className="composer">
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={isStarting || isPendingControl}
          placeholder="Ask the agent to inspect, edit, or explain something…"
        />
        <div className="composer-actions">
          <span className="composer-hint">
            User intents are durable even if the bridge is stopped.
          </span>
          <button
            className="primary-button"
            onClick={() => void sendPrompt()}
            disabled={isStarting || isPendingControl}
          >
            {isStarting ? `Starting…` : `Send Prompt`}
          </button>
        </div>
      </div>
    </section>
  )
}
