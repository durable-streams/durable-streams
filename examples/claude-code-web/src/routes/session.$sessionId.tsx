import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useState, useEffect, useCallback } from "react"
import { SessionList } from "~/components/SessionList"
import { Terminal } from "~/components/Terminal"
import { DirectAccess } from "~/components/DirectAccess"
import type { Session } from "~/lib/types"
import "~/styles/main.css"

export const Route = createFileRoute("/session/$sessionId")({
  component: SessionPage,
})

function SessionPage() {
  const { sessionId } = Route.useParams()
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentSession, setCurrentSession] = useState<Session | null>(null)
  const [streamUrls, setStreamUrls] = useState<{
    inputStreamUrl: string
    outputStreamUrl: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [showDirectAccess, setShowDirectAccess] = useState(false)

  // Fetch all sessions
  const fetchSessions = useCallback(async () => {
    try {
      const response = await fetch("/api/sessions")
      if (!response.ok) throw new Error("Failed to fetch sessions")
      const data = await response.json()
      setSessions(data.sessions)
      return data.sessions
    } catch (err) {
      console.error("Failed to fetch sessions:", err)
      return []
    }
  }, [])

  // Connect to the session
  const connectToSession = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await fetch(`/api/sessions/${sessionId}/connect`, {
        method: "POST",
      })

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error("Session not found")
        }
        throw new Error("Failed to connect to session")
      }

      const data = await response.json()
      setCurrentSession(data.session)
      setStreamUrls({
        inputStreamUrl: data.inputStreamUrl,
        outputStreamUrl: data.outputStreamUrl,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed")
    } finally {
      setIsLoading(false)
    }
  }, [sessionId])

  // Initial load
  useEffect(() => {
    fetchSessions()
    connectToSession()
  }, [fetchSessions, connectToSession])

  // Handle terminal resize
  const handleResize = useCallback(
    async (cols: number, rows: number) => {
      try {
        await fetch(`/api/sessions/${sessionId}/resize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cols, rows }),
        })
      } catch (err) {
        console.error("Failed to resize:", err)
      }
    },
    [sessionId]
  )

  // Handle session deletion
  const handleDeleteSession = async (id: string) => {
    try {
      await fetch(`/api/sessions/${id}`, { method: "DELETE" })
      await fetchSessions()

      if (id === sessionId) {
        navigate({ to: "/" })
      }
    } catch (err) {
      console.error("Failed to delete session:", err)
    }
  }

  // Handle new session (redirect to home)
  const handleNewSession = () => {
    navigate({ to: "/" })
  }

  return (
    <div className="app">
      <SessionList
        sessions={sessions}
        activeSessionId={sessionId}
        onDelete={handleDeleteSession}
        onNewSession={handleNewSession}
        isCreating={false}
      />

      <main className="main-content terminal-view">
        {error && (
          <div className="error-banner">
            {error}
            <button onClick={() => navigate({ to: "/" })}>Go Home</button>
          </div>
        )}

        {isLoading && (
          <div className="loading-overlay">
            <div className="spinner" />
            <p>Connecting to session...</p>
          </div>
        )}

        {currentSession && streamUrls && !isLoading && (
          <>
            <div className="session-header">
              <div className="session-info">
                <h2>{currentSession.name}</h2>
                <span className="repo-badge">
                  {currentSession.repoOwner}/{currentSession.repoName}
                  {currentSession.branch && ` @ ${currentSession.branch}`}
                </span>
                <span className={`state-badge state-${currentSession.state}`}>
                  {currentSession.state}
                </span>
              </div>
              <div className="session-actions">
                <button
                  onClick={() => setShowDirectAccess(true)}
                  className="btn-secondary"
                  title="Open direct shell access"
                >
                  Shell
                </button>
              </div>
            </div>

            <Terminal
              sessionId={sessionId}
              inputStreamUrl={streamUrls.inputStreamUrl}
              outputStreamUrl={streamUrls.outputStreamUrl}
              onResize={handleResize}
            />
          </>
        )}

        {showDirectAccess && (
          <DirectAccess
            sessionId={sessionId}
            onClose={() => setShowDirectAccess(false)}
          />
        )}
      </main>
    </div>
  )
}
