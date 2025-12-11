import { Link, Outlet, createRootRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { DurableStream } from "@durable-streams/writer"
import "../styles.css"

interface Stream {
  path: string
  contentType?: string
}

interface RegistryEvent {
  type: `created` | `deleted`
  path: string
  contentType?: string
  timestamp: number
}

function RootLayout() {
  const [streams, setStreams] = useState<Array<Stream>>([])
  const [newStreamPath, setNewStreamPath] = useState(``)
  const [newStreamContentType, setNewStreamContentType] = useState(`text/plain`)
  const [error, setError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const SERVER_URL = `${window.location.protocol}//${window.location.host}`

  useEffect(() => {
    const controller = new AbortController()

    const followRegistry = async () => {
      try {
        const registryStream = new DurableStream({
          url: `${SERVER_URL}/v1/stream/__registry__`,
        })

        // Check if registry exists, create it if it doesn't
        const exists = await registryStream.head().catch(() => null)
        if (!exists) {
          await DurableStream.create({
            url: `${SERVER_URL}/v1/stream/__registry__`,
            contentType: `application/json`,
          })
        }

        // Follow the registry stream for live updates
        const streamMap = new Map<string, Stream>()

        for await (const value of registryStream.jsonStream({
          offset: `-1`,
          live: `long-poll`,
          signal: controller.signal,
        })) {
          const event = value as RegistryEvent
          if (event.type === `created`) {
            streamMap.set(event.path, {
              path: event.path,
              contentType: event.contentType,
            })
          } else {
            streamMap.delete(event.path)
          }

          // Update state with current streams
          setStreams(Array.from(streamMap.values()))
        }
      } catch (err: any) {
        if (err.name !== `AbortError`) {
          console.error(`Failed to follow registry:`, err)
        }
      }
    }

    void followRegistry()

    return () => {
      controller.abort()
    }
  }, [])

  const createStream = async () => {
    if (!newStreamPath.trim()) {
      setError(`Stream path cannot be empty`)
      return
    }

    try {
      setError(null)
      await DurableStream.create({
        url: `${SERVER_URL}/v1/stream/${newStreamPath}`,
        contentType: newStreamContentType,
      })

      // Stream will be added automatically via registry updates
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
      await stream.delete()

      // Stream will be removed automatically via registry updates
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
            <Link
              key={stream.path}
              to="/stream/$streamPath"
              params={{ streamPath: stream.path }}
              className="stream-item"
              activeProps={{ className: `stream-item active` }}
              onClick={() => setSidebarOpen(false)}
            >
              <div>
                <div className="stream-path">
                  {decodeURIComponent(stream.path)}
                </div>
                <div className="stream-type">
                  {stream.contentType?.toLowerCase() || `unknown`}
                </div>
              </div>
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
            </Link>
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
