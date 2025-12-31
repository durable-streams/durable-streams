import { Link } from "@tanstack/react-router"
import type { Session } from "~/lib/types"
import clsx from "clsx"

interface SessionListProps {
  sessions: Session[]
  activeSessionId?: string
  onDelete: (sessionId: string) => void
  onNewSession: () => void
  isCreating: boolean
}

export function SessionList({
  sessions,
  activeSessionId,
  onDelete,
  onNewSession,
  isCreating,
}: SessionListProps) {
  // Separate main sessions from sub-sessions
  const mainSessions = sessions.filter((s) => !s.parentSessionId)
  const subSessionsMap = new Map<string, Session[]>()

  sessions
    .filter((s) => s.parentSessionId)
    .forEach((sub) => {
      const existing = subSessionsMap.get(sub.parentSessionId!) || []
      existing.push(sub)
      subSessionsMap.set(sub.parentSessionId!, existing)
    })

  return (
    <aside className="session-sidebar">
      <div className="sidebar-header">
        <h2>Sessions</h2>
        <button
          onClick={onNewSession}
          disabled={isCreating}
          className="new-session-btn"
          title="Create new session"
        >
          {isCreating ? "..." : "+ New"}
        </button>
      </div>

      <ul className="session-list">
        {mainSessions.map((session) => (
          <SessionItem
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            onDelete={() => onDelete(session.id)}
            subSessions={subSessionsMap.get(session.id)}
            activeSessionId={activeSessionId}
            onDeleteSub={onDelete}
          />
        ))}
      </ul>

      {sessions.length === 0 && (
        <p className="no-sessions">
          No sessions yet.
          <br />
          Create one to start coding.
        </p>
      )}
    </aside>
  )
}

function SessionItem({
  session,
  isActive,
  onDelete,
  subSessions,
  activeSessionId,
  onDeleteSub,
}: {
  session: Session
  isActive: boolean
  onDelete: () => void
  subSessions?: Session[]
  activeSessionId?: string
  onDeleteSub: (id: string) => void
}) {
  const stateColors: Record<string, string> = {
    stopped: "state-stopped",
    starting: "state-starting",
    running: "state-running",
    idle: "state-idle",
  }

  return (
    <li className="session-item-wrapper">
      <Link
        to="/session/$sessionId"
        params={{ sessionId: session.id }}
        className={clsx("session-item", {
          active: isActive,
          [stateColors[session.state]]: true,
        })}
      >
        <div className="session-info">
          <span className="session-name" title={session.name}>
            {session.name}
          </span>
          <span className="session-repo">
            {session.repoOwner}/{session.repoName}
            {session.branch && ` (${session.branch})`}
          </span>
          <span className={clsx("session-state", stateColors[session.state])}>
            {session.state}
          </span>
        </div>
        <button
          className="delete-btn"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onDelete()
          }}
          title="Delete session"
        >
          &times;
        </button>
      </Link>

      {subSessions && subSessions.length > 0 && (
        <ul className="sub-session-list">
          {subSessions.map((sub) => (
            <li key={sub.id}>
              <Link
                to="/session/$sessionId"
                params={{ sessionId: sub.id }}
                className={clsx("session-item sub-session", {
                  active: sub.id === activeSessionId,
                  [stateColors[sub.state]]: true,
                })}
              >
                <div className="session-info">
                  <span className="session-name">{sub.name}</span>
                  <span className={clsx("session-state", stateColors[sub.state])}>
                    {sub.state}
                  </span>
                </div>
                <button
                  className="delete-btn"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onDeleteSub(sub.id)
                  }}
                >
                  &times;
                </button>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}
