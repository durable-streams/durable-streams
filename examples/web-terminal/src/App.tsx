import { useCallback, useEffect, useRef, useState } from "react"
import { DurableStream } from "@durable-streams/client"
import { createTerminal } from "./lib/terminal"
import type { TerminalInstance } from "./lib/terminal"

interface Session {
  sessionId: string
  containerId: string
  createdAt: string
  lastActivity: string
  isActive: boolean
  inputStreamUrl: string
  outputStreamUrl: string
}

interface ConnectedSession {
  sessionId: string
  inputStreamUrl: string
  outputStreamUrl: string
}

const API_URL = `/api`

// Simple URL routing helpers
function getSessionIdFromUrl(): string | null {
  const path = window.location.pathname
  const match = path.match(/^\/session\/([a-f0-9-]+)$/i)
  return match ? match[1] : null
}

function setSessionUrl(sessionId: string | null) {
  const newPath = sessionId ? `/session/${sessionId}` : `/`
  window.history.pushState({}, ``, newPath)
}

export default function App() {
  const [sessions, setSessions] = useState<Array<Session>>([])
  const [activeSession, setActiveSession] = useState<ConnectedSession | null>(
    null
  )
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPoweredOn, setIsPoweredOn] = useState(false)
  const [initialLoadDone, setInitialLoadDone] = useState(false)

  const terminalRef = useRef<HTMLDivElement>(null)
  const terminalInstanceRef = useRef<TerminalInstance | null>(null)
  const inputStreamRef = useRef<DurableStream | null>(null)
  const outputAbortRef = useRef<AbortController | null>(null)

  // Fetch sessions on mount
  useEffect(() => {
    fetchSessions().then(() => setInitialLoadDone(true))
  }, [])

  const fetchSessions = async () => {
    try {
      const response = await fetch(`${API_URL}/sessions`)
      const data = await response.json()
      setSessions(data.sessions)
    } catch (err) {
      console.error(`Failed to fetch sessions:`, err)
    }
  }

  const createNewSession = async () => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch(`${API_URL}/sessions`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify({}),
      })

      if (!response.ok) {
        throw new Error(`Failed to create session`)
      }

      const session: ConnectedSession = await response.json()

      await fetchSessions()
      await connectToSession(session)
    } catch (err) {
      setError(err instanceof Error ? err.message : `Unknown error`)
    } finally {
      setIsLoading(false)
    }
  }

  const connectToSession = useCallback(
    async (session: ConnectedSession | { sessionId: string }) => {
      // Cleanup previous session
      if (outputAbortRef.current) {
        outputAbortRef.current.abort()
      }
      if (terminalInstanceRef.current) {
        terminalInstanceRef.current.dispose()
        terminalInstanceRef.current = null
      }

      setIsLoading(true)
      setError(null)
      setIsPoweredOn(false)

      try {
        // Connect to existing session
        const response = await fetch(
          `${API_URL}/sessions/${session.sessionId}/connect`,
          {
            method: `POST`,
          }
        )

        if (!response.ok) {
          throw new Error(`Failed to connect to session`)
        }

        const connectedSession: ConnectedSession = await response.json()
        setActiveSession(connectedSession)
        setSessionUrl(connectedSession.sessionId)

        // Wait for terminal container to be ready
        await new Promise((resolve) => setTimeout(resolve, 100))

        if (!terminalRef.current) {
          throw new Error(`Terminal container not ready`)
        }

        // Create terminal instance
        const terminal = createTerminal(terminalRef.current, {
          fontSize: 15,
        })
        terminalInstanceRef.current = terminal

        // Trigger power-on animation
        setIsPoweredOn(true)

        // Set up output stream subscription
        const outputAbort = new AbortController()
        outputAbortRef.current = outputAbort

        const outputStream = new DurableStream({
          url: connectedSession.outputStreamUrl,
        })

        // First, catch up on existing output (but limit to last 32KB for performance)
        const catchUpRes = await outputStream.stream({
          live: false,
          signal: outputAbort.signal,
        })

        let totalBytes = 0
        const MAX_CATCHUP_BYTES = 32 * 1024 // 32KB
        const catchUpChunks: Array<Uint8Array> = []

        catchUpRes.subscribeBytes((chunk) => {
          catchUpChunks.push(chunk.data)
          totalBytes += chunk.data.length
        })

        // Wait for catchup to complete
        await new Promise((resolve) => setTimeout(resolve, 200))

        // Only render the last 32KB of history
        if (totalBytes > 0) {
          let bytesToSkip = Math.max(0, totalBytes - MAX_CATCHUP_BYTES)
          for (const chunk of catchUpChunks) {
            if (bytesToSkip >= chunk.length) {
              bytesToSkip -= chunk.length
              continue
            }
            const data = bytesToSkip > 0 ? chunk.slice(bytesToSkip) : chunk
            bytesToSkip = 0
            const text = new TextDecoder().decode(data)
            terminal.write(text)
          }
        }

        // Now subscribe to live updates
        const liveRes = await outputStream.stream({
          live: `long-poll`,
          signal: outputAbort.signal,
        })

        liveRes.subscribeBytes((chunk) => {
          if (outputAbort.signal.aborted) return
          const text = new TextDecoder().decode(chunk.data)
          terminal.write(text)
        })

        // Set up input stream
        const inputStream = await DurableStream.create({
          url: connectedSession.inputStreamUrl,
          contentType: `application/octet-stream`,
        })
        inputStreamRef.current = inputStream

        // Wire up keyboard input
        terminal.onData(async (data: string) => {
          try {
            const encoder = new TextEncoder()
            await inputStreamRef.current?.append(encoder.encode(data))
          } catch (err) {
            console.error(`Failed to send input:`, err)
          }
        })

        // Wire up paste events
        terminal.onPaste(async (text: string) => {
          try {
            const encoder = new TextEncoder()
            await inputStreamRef.current?.append(encoder.encode(text))
          } catch (err) {
            console.error(`Failed to send paste:`, err)
          }
        })

        // Wire up resize events
        terminal.onResize(async (cols: number, rows: number) => {
          try {
            await fetch(
              `${API_URL}/sessions/${connectedSession.sessionId}/resize`,
              {
                method: `POST`,
                headers: { "Content-Type": `application/json` },
                body: JSON.stringify({ cols, rows }),
              }
            )
          } catch (err) {
            console.error(`Failed to send resize:`, err)
          }
        })

        // Ensure terminal is fitted before getting dimensions
        terminal.fit()

        // Send initial size (wait a tick for fit to apply)
        await new Promise((resolve) => setTimeout(resolve, 50))
        const { cols, rows } = terminal.getDimensions()
        console.log(`Sending initial resize: ${cols}x${rows}`)
        await fetch(
          `${API_URL}/sessions/${connectedSession.sessionId}/resize`,
          {
            method: `POST`,
            headers: { "Content-Type": `application/json` },
            body: JSON.stringify({ cols, rows }),
          }
        )

        terminal.focus()

        // Refresh sessions list
        await fetchSessions()
      } catch (err) {
        setError(err instanceof Error ? err.message : `Unknown error`)
        setActiveSession(null)
      } finally {
        setIsLoading(false)
      }
    },
    []
  )

  const disconnectSession = async () => {
    if (!activeSession) return

    if (outputAbortRef.current) {
      outputAbortRef.current.abort()
      outputAbortRef.current = null
    }

    if (terminalInstanceRef.current) {
      terminalInstanceRef.current.dispose()
      terminalInstanceRef.current = null
    }

    try {
      await fetch(`${API_URL}/sessions/${activeSession.sessionId}/disconnect`, {
        method: `POST`,
      })
    } catch (err) {
      console.error(`Failed to disconnect:`, err)
    }

    setActiveSession(null)
    setIsPoweredOn(false)
    inputStreamRef.current = null
    setSessionUrl(null)

    await fetchSessions()
  }

  const deleteSession = async (sessionId: string) => {
    if (activeSession?.sessionId === sessionId) {
      await disconnectSession()
    }

    try {
      await fetch(`${API_URL}/sessions/${sessionId}`, {
        method: `DELETE`,
      })
      await fetchSessions()
    } catch (err) {
      console.error(`Failed to delete session:`, err)
    }
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (outputAbortRef.current) {
        outputAbortRef.current.abort()
      }
      if (terminalInstanceRef.current) {
        terminalInstanceRef.current.dispose()
      }
    }
  }, [])

  // Auto-connect from URL on initial load
  useEffect(() => {
    if (!initialLoadDone) return

    const sessionId = getSessionIdFromUrl()
    if (sessionId && !activeSession) {
      connectToSession({ sessionId })
    }
  }, [initialLoadDone, activeSession, connectToSession])

  // Handle browser back/forward navigation
  useEffect(() => {
    const handlePopState = () => {
      const sessionId = getSessionIdFromUrl()
      if (sessionId && sessionId !== activeSession?.sessionId) {
        connectToSession({ sessionId })
      } else if (!sessionId && activeSession) {
        disconnectSession()
      }
    }

    window.addEventListener(`popstate`, handlePopState)
    return () => window.removeEventListener(`popstate`, handlePopState)
  }, [activeSession, connectToSession])

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>Sessions</h2>
          <button
            onClick={createNewSession}
            disabled={isLoading}
            className="new-session-btn"
          >
            + New
          </button>
        </div>

        <ul className="session-list">
          {sessions.map((session) => (
            <li
              key={session.sessionId}
              className={`session-item ${
                activeSession?.sessionId === session.sessionId ? `active` : ``
              } ${session.isActive ? `connected` : ``}`}
            >
              <button
                className="session-btn"
                onClick={() =>
                  connectToSession({ sessionId: session.sessionId })
                }
              >
                <span className="session-id">
                  {session.sessionId.slice(0, 8)}
                </span>
                <span className="session-status">
                  {session.isActive ? `online` : `offline`}
                </span>
              </button>
              <button
                className="delete-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteSession(session.sessionId)
                }}
                title="Delete session"
              >
                ×
              </button>
            </li>
          ))}
        </ul>

        {sessions.length === 0 && (
          <p className="no-sessions">
            No active sessions.
            <br />
            Create one to begin.
          </p>
        )}
      </aside>

      <main className={`terminal-area ${activeSession ? `active` : ``}`}>
        {error && <div className="error">{error}</div>}

        {!activeSession && !isLoading && (
          <div className="placeholder">
            <p>Awaiting connection...</p>
          </div>
        )}

        {isLoading && (
          <div className="loading">
            <p>Initializing...</p>
          </div>
        )}

        <div
          ref={terminalRef}
          className={`terminal-container ${isPoweredOn ? `powered-on` : ``}`}
          tabIndex={0}
          style={{
            display: activeSession && !isLoading ? `block` : `none`,
          }}
        />
      </main>
    </div>
  )
}
