import { startTransition, useEffect, useMemo, useState } from "react"
import { Link, useLocation, useNavigate } from "@tanstack/react-router"
import type { CreateSessionPayload, SessionSummary } from "~/lib/session-types"
import { useBrowserUser } from "~/hooks/use-browser-user"
import { useSessions } from "~/lib/sessions-context"

function defaultPayload(): CreateSessionPayload {
  return {
    title: ``,
    agent: `claude`,
    cwd: ``,
    permissionMode: `plan`,
    approvalPolicy: `on-request`,
    sandboxMode: `workspace-write`,
    experimentalFeatures: [
      `request_permissions_tool`,
      `default_mode_request_user_input`,
    ],
    debugStream: false,
  }
}

function prettyPath(path: string): string {
  const parts = path.split(`/`).filter(Boolean)
  return parts.slice(-2).join(`/`) || path
}

function SessionListItem({ session }: { session: SessionSummary }) {
  const location = useLocation()
  const active = location.pathname === `/session/${session.id}`

  return (
    <Link
      to="/session/$id"
      params={{ id: session.id }}
      className={`session-nav-item ${active ? `active` : ``}`}
    >
      <div className="session-nav-head">
        <span className={`status-dot ${session.active ? `live` : `idle`}`} />
        <span className="session-agent">{session.agent}</span>
        <span className="session-updated">
          {new Date(session.updatedAt).toLocaleTimeString([], {
            hour: `2-digit`,
            minute: `2-digit`,
          })}
        </span>
      </div>
      <div className="session-title">{session.title}</div>
      <div className="session-path">{prettyPath(session.cwd)}</div>
    </Link>
  )
}

export function SessionSidebar({ defaultCwd }: { defaultCwd: string }) {
  const navigate = useNavigate()
  const { sessions, replaceSession } = useSessions()
  const { user, setUser } = useBrowserUser()
  const [payload, setPayload] = useState<CreateSessionPayload>(() => ({
    ...defaultPayload(),
    cwd: defaultCwd,
  }))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setPayload((current) =>
      current.cwd === ``
        ? {
            ...current,
            cwd: defaultCwd,
          }
        : current
    )
  }, [defaultCwd])

  const codexFeatures = useMemo(
    () => new Set(payload.experimentalFeatures ?? []),
    [payload.experimentalFeatures]
  )

  const toggleFeature = (feature: string) => {
    setPayload((current) => {
      const next = new Set(current.experimentalFeatures ?? [])
      if (next.has(feature)) {
        next.delete(feature)
      } else {
        next.add(feature)
      }

      return {
        ...current,
        experimentalFeatures: [...next],
      }
    })
  }

  const submit = async () => {
    setSubmitting(true)
    setError(null)

    try {
      const response = await fetch(`/api/sessions`, {
        method: `POST`,
        headers: {
          "Content-Type": `application/json`,
        },
        body: JSON.stringify(payload),
      })

      if (!response.ok) {
        throw new Error(await response.text())
      }

      const session = (await response.json()) as SessionSummary
      startTransition(() => {
        replaceSession(session)
      })
      await navigate({
        to: `/session/$id`,
        params: { id: session.id },
      })
      setPayload({
        ...defaultPayload(),
        cwd: defaultCwd,
      })
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : String(submitError)
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <aside className="sidebar-panel">
      <div className="sidebar-brand">
        <p className="eyebrow">Prototype</p>
        <h1>Coding Agents</h1>
        <p className="sidebar-copy">
          Shared Claude Code and Codex sessions over durable streams.
        </p>
      </div>

      <div className="sidebar-section">
        <div className="section-head">
          <h2>New Session</h2>
          <span>{sessions.length} total</span>
        </div>

        <label>
          <span>Title</span>
          <input
            value={payload.title ?? ``}
            onChange={(event) =>
              setPayload((current) => ({
                ...current,
                title: event.target.value,
              }))
            }
            placeholder="claude · durable-streams"
          />
        </label>

        <div className="grid-two">
          <label>
            <span>Agent</span>
            <select
              value={payload.agent}
              onChange={(event) =>
                setPayload((current) => ({
                  ...current,
                  agent: event.target.value as CreateSessionPayload[`agent`],
                  permissionMode:
                    event.target.value === `claude` ? `plan` : `untrusted`,
                }))
              }
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </label>

          <label>
            <span>Permission Mode</span>
            <input
              value={payload.permissionMode ?? ``}
              onChange={(event) =>
                setPayload((current) => ({
                  ...current,
                  permissionMode: event.target.value,
                }))
              }
              placeholder={payload.agent === `claude` ? `plan` : `untrusted`}
            />
          </label>
        </div>

        <label>
          <span>Working Directory</span>
          <input
            value={payload.cwd}
            onChange={(event) =>
              setPayload((current) => ({
                ...current,
                cwd: event.target.value,
              }))
            }
          />
        </label>

        <label>
          <span>Model</span>
          <input
            value={payload.model ?? ``}
            onChange={(event) =>
              setPayload((current) => ({
                ...current,
                model: event.target.value,
              }))
            }
            placeholder="optional"
          />
        </label>

        {payload.agent === `codex` && (
          <>
            <div className="grid-two">
              <label>
                <span>Approval Policy</span>
                <select
                  value={payload.approvalPolicy ?? `on-request`}
                  onChange={(event) =>
                    setPayload((current) => ({
                      ...current,
                      approvalPolicy: event.target
                        .value as CreateSessionPayload[`approvalPolicy`],
                    }))
                  }
                >
                  <option value="untrusted">untrusted</option>
                  <option value="on-request">on-request</option>
                  <option value="on-failure">on-failure</option>
                  <option value="never">never</option>
                </select>
              </label>

              <label>
                <span>Sandbox</span>
                <select
                  value={payload.sandboxMode ?? `workspace-write`}
                  onChange={(event) =>
                    setPayload((current) => ({
                      ...current,
                      sandboxMode: event.target
                        .value as CreateSessionPayload[`sandboxMode`],
                    }))
                  }
                >
                  <option value="read-only">read-only</option>
                  <option value="workspace-write">workspace-write</option>
                  <option value="danger-full-access">danger-full-access</option>
                </select>
              </label>
            </div>

            <label>
              <span>Developer Instructions</span>
              <textarea
                value={payload.developerInstructions ?? ``}
                onChange={(event) =>
                  setPayload((current) => ({
                    ...current,
                    developerInstructions: event.target.value,
                  }))
                }
                placeholder="optional"
              />
            </label>

            <div className="checkbox-group">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={codexFeatures.has(`request_permissions_tool`)}
                  onChange={() => toggleFeature(`request_permissions_tool`)}
                />
                <span>Enable `request_permissions_tool`</span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={codexFeatures.has(`default_mode_request_user_input`)}
                  onChange={() =>
                    toggleFeature(`default_mode_request_user_input`)
                  }
                />
                <span>Enable `request_user_input`</span>
              </label>
            </div>
          </>
        )}

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={payload.debugStream === true}
            onChange={(event) =>
              setPayload((current) => ({
                ...current,
                debugStream: event.target.checked,
              }))
            }
          />
          <span>Persist bridge debug events to the stream</span>
        </label>

        {error && <p className="inline-error">{error}</p>}

        <button
          className="primary-button"
          disabled={submitting || !payload.cwd.trim()}
          onClick={() => void submit()}
        >
          {submitting ? `Starting…` : `Start Session`}
        </button>
      </div>

      <div className="sidebar-section">
        <div className="section-head">
          <h2>Sessions</h2>
          <span>shareable URLs</span>
        </div>

        <div className="session-list">
          {sessions.map((session) => (
            <SessionListItem key={session.id} session={session} />
          ))}
        </div>
      </div>

      <div className="sidebar-section identity-section">
        <div className="section-head">
          <h2>Browser Identity</h2>
          <span>stream author</span>
        </div>

        <label>
          <span>Name</span>
          <input
            value={user.name}
            onChange={(event) =>
              setUser((current) => ({
                ...current,
                name: event.target.value,
              }))
            }
          />
        </label>

        <label>
          <span>Email</span>
          <input
            value={user.email}
            onChange={(event) =>
              setUser((current) => ({
                ...current,
                email: event.target.value,
              }))
            }
          />
        </label>
      </div>
    </aside>
  )
}
