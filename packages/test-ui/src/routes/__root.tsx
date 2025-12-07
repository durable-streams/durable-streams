import { Link, Outlet, createRootRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { DurableStream } from "@durable-streams/writer"
import "../styles.css"

interface Stream {
  path: string
  contentType?: string
}

function RootLayout() {
  const [streams, setStreams] = useState<Array<Stream>>([])
  const [newStreamPath, setNewStreamPath] = useState(``)
  const [newStreamContentType, setNewStreamContentType] = useState(`text/plain`)
  const [error, setError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const SERVER_URL = `http://${window.location.hostname}:8787`

  useEffect(() => {
    void loadStreamsFromRegistry()
  }, [])

  const loadStreamsFromRegistry = async () => {
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

      // Read all chunks from the registry
      const loadedStreams: Array<Stream> = []

      try {
        for await (const chunk of registryStream.read({ offset: `-1` })) {
          console.log(`Registry chunk:`, chunk)
          if (chunk.data.length > 0) {
            const text = new TextDecoder().decode(chunk.data)
            console.log(`Registry text:`, text)
            const lines = text.trim().split(`\n`).filter(Boolean)

            for (const line of lines) {
              try {
                const event = JSON.parse(line)
                console.log(`Registry event:`, event)
                if (event.type === `created`) {
                  loadedStreams.push({
                    path: event.path,
                    contentType: event.contentType,
                  })
                } else if (event.type === `deleted`) {
                  const index = loadedStreams.findIndex(
                    (s) => s.path === event.path
                  )
                  if (index !== -1) {
                    loadedStreams.splice(index, 1)
                  }
                }
              } catch (e) {
                console.error(`Error parsing registry line:`, line, e)
              }
            }
          }
          console.log(`Loaded streams:`, loadedStreams)
          setStreams(loadedStreams)
        }
      } catch (readErr) {
        console.error(`Error reading registry stream:`, readErr)
      }
    } catch (err) {
      console.error(`Failed to load streams from registry:`, err)
    }
  }

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

      setStreams([
        ...streams,
        { path: newStreamPath, contentType: newStreamContentType },
      ])
      setNewStreamPath(``)
    } catch (err: any) {
      setError(`Failed to create stream: ${err.message}`)
    }
  }

  const deleteStream = async (path: string) => {
    try {
      setError(null)
      const stream = new DurableStream({
        url: `${SERVER_URL}/v1/stream/${path}`,
      })
      await stream.delete()

      setStreams(streams.filter((s) => s.path !== path))
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
        <h2>Streams</h2>
        <div className="create-stream">
          <input
            type="text"
            placeholder="Stream path"
            value={newStreamPath}
            onChange={(e) => setNewStreamPath(e.target.value)}
            onKeyPress={(e) => e.key === `Enter` && void createStream()}
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
                <div className="stream-path">{stream.path}</div>
                <div className="stream-type">
                  {stream.contentType || `unknown`}
                </div>
              </div>
              <button
                className="delete-btn"
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
