import { Link, Outlet, createRootRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { DurableStream } from "@durable-streams/client"
import { and, eq, gt, useLiveQuery } from "@tanstack/react-db"
import { useStreamDB } from "../lib/stream-db-context"
import { usePresence } from "../hooks/usePresence"
import type { StreamMetadata } from "../lib/schemas"
import "../styles.css"

const SERVER_URL = `http://${window.location.hostname}:4437`

function StreamListItem({ stream }: { stream: StreamMetadata }) {
  const { presenceDB } = useStreamDB()
  const [now, setNow] = useState(Date.now())

  // Update "now" every 5 seconds to re-evaluate stale indicators
  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now())
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  // Query viewers for this stream
  const { data: viewers = [] } = useLiveQuery(
    (q) =>
      q
        .from({ presence: presenceDB.collections.presence })
        .where(({ presence }) =>
          and(
            eq(presence.streamPath, stream.path),
            gt(presence.lastSeen, now - 60000)
          )
        ),
    [stream.path, now]
  )

  // Query typing users for this stream
  const { data: typingUsers = [] } = useLiveQuery(
    (q) =>
      q
        .from({ presence: presenceDB.collections.presence })
        .where(({ presence }) =>
          and(
            eq(presence.streamPath, stream.path),
            eq(presence.isTyping, true),
            gt(presence.lastSeen, now - 60000)
          )
        ),
    [stream.path, now]
  )

  return (
    <Link
      to="/stream/$streamPath"
      params={{ streamPath: stream.path }}
      className="stream-item"
      activeProps={{ className: `stream-item active` }}
    >
      <div className="stream-info">
        <div className="stream-path">{decodeURIComponent(stream.path)}</div>
        <div className="stream-meta">
          <span className="stream-type">
            {stream.contentType.toLowerCase()}
          </span>
          {typingUsers.length > 0 && <span className="typing-spinner">⌛</span>}
          {viewers.length > 0 && (
            <div className="viewers">
              {viewers.map((v) => (
                <div
                  key={v.sessionId}
                  className="viewer-dot"
                  style={{ backgroundColor: v.color }}
                  title={`User ${v.userId.slice(0, 8)}`}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </Link>
  )
}

function RootLayout() {
  const { registryDB } = useStreamDB()
  const [newStreamPath, setNewStreamPath] = useState(``)
  const [newStreamContentType, setNewStreamContentType] = useState(`text/plain`)
  const [error, setError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Use presence hook for heartbeat and cleanup
  usePresence()

  // Query all streams from registry
  const { data: streams = [] } = useLiveQuery((q) =>
    q.from({ streams: registryDB.collections.streams })
  )

  const createStream = async () => {
    if (!newStreamPath.trim()) {
      setError(`Stream path cannot be empty`)
      return
    }

    try {
      setError(null)
      // Create the actual stream - server registry hook will update __registry__
      await DurableStream.create({
        url: `${SERVER_URL}/v1/stream/${newStreamPath}`,
        contentType: newStreamContentType,
      })

      setNewStreamPath(``)
    } catch (err: any) {
      setError(`Failed to create stream: ${err.message}`)
    }
  }

  const deleteStream = async (path: string) => {
    if (
      !window.confirm(
        `Delete stream "${decodeURIComponent(path)}"?\n\nThis action cannot be undone.`
      )
    ) {
      return
    }

    try {
      setError(null)
      const stream = new DurableStream({
        url: `${SERVER_URL}/v1/stream/${path}`,
      })
      // Delete the stream - server registry hook will update __registry__
      await stream.delete()
    } catch (err: any) {
      setError(`Failed to delete stream: ${err.message}`)
    }
  }

  return (
    <div className="container">
      <button
        className="menu-toggle"
        onClick={() => setSidebarOpen(!sidebarOpen)}
      >
        ☰
      </button>
      <div className={`sidebar ${sidebarOpen ? `open` : ``}`}>
        <div className="create-stream">
          <input
            type="text"
            placeholder="New stream path"
            value={newStreamPath}
            onChange={(e) => setNewStreamPath(e.target.value)}
            onKeyDown={(e) => e.key === `Enter` && void createStream()}
          />
          <select
            value={newStreamContentType}
            onChange={(e) => setNewStreamContentType(e.target.value)}
          >
            <option value="text/plain">text/plain</option>
            <option value="application/json">application/json</option>
            <option value="application/octet-stream">binary</option>
          </select>
          <button onClick={createStream}>Create</button>
        </div>
        <div className="stream-list">
          {streams.map((stream) => (
            <div key={stream.path} style={{ position: `relative` }}>
              <StreamListItem stream={stream} />
              <button
                className="delete-btn"
                title={`Delete stream: ${decodeURIComponent(stream.path)}`}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  void deleteStream(stream.path)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="main">
        {error && <div className="error">{error}</div>}
        <Outlet />
      </div>
    </div>
  )
}

export const Route = createRootRoute({
  component: RootLayout,
})
