import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useState, useEffect, useCallback } from "react"
import { SessionList } from "~/components/SessionList"
import { RepoSelector } from "~/components/RepoSelector"
import type { Session, GitHubRepo } from "~/lib/types"
import "~/styles/main.css"

export const Route = createFileRoute("/")({
  component: HomePage,
})

function HomePage() {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<Session[]>([])
  const [showRepoSelector, setShowRepoSelector] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch sessions on mount
  const fetchSessions = useCallback(async () => {
    try {
      const response = await fetch("/api/sessions")
      if (!response.ok) {
        throw new Error("Failed to fetch sessions")
      }
      const data = await response.json()
      setSessions(data.sessions)
    } catch (err) {
      console.error("Failed to fetch sessions:", err)
      setError(err instanceof Error ? err.message : "Failed to load sessions")
    }
  }, [])

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  const handleNewSession = () => {
    setShowRepoSelector(true)
  }

  const handleCreateSession = async (repo: GitHubRepo, branch?: string) => {
    setIsCreating(true)
    setShowRepoSelector(false)
    setError(null)

    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoOwner: repo.owner.login,
          repoName: repo.name,
          branch,
        }),
      })

      if (!response.ok) {
        throw new Error("Failed to create session")
      }

      const session = await response.json()
      await fetchSessions()

      // Navigate to the new session
      navigate({ to: "/session/$sessionId", params: { sessionId: session.id } })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create session")
    } finally {
      setIsCreating(false)
    }
  }

  const handleDeleteSession = async (sessionId: string) => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}`, {
        method: "DELETE",
      })

      if (!response.ok) {
        throw new Error("Failed to delete session")
      }

      await fetchSessions()
    } catch (err) {
      console.error("Failed to delete session:", err)
    }
  }

  return (
    <div className="app">
      <SessionList
        sessions={sessions}
        onDelete={handleDeleteSession}
        onNewSession={handleNewSession}
        isCreating={isCreating}
      />

      <main className="main-content">
        <div className="welcome-screen">
          <div className="logo">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="logo-icon"
            >
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </div>
          <h1>Claude Code Web</h1>
          <p className="tagline">
            AI-powered coding assistant in your browser
          </p>

          {error && <div className="error-banner">{error}</div>}

          <div className="quick-actions">
            <button
              onClick={handleNewSession}
              disabled={isCreating}
              className="btn-primary btn-large"
            >
              {isCreating ? "Creating..." : "Start New Session"}
            </button>
          </div>

          <div className="features">
            <div className="feature">
              <h3>Persistent Sessions</h3>
              <p>Your terminal history is saved and resumable</p>
            </div>
            <div className="feature">
              <h3>GitHub Integration</h3>
              <p>Clone and work on any repository</p>
            </div>
            <div className="feature">
              <h3>Parallel Tasks</h3>
              <p>Spawn sub-instances for concurrent work</p>
            </div>
          </div>
        </div>
      </main>

      {showRepoSelector && (
        <div className="modal-overlay">
          <RepoSelector
            onSelect={handleCreateSession}
            onCancel={() => setShowRepoSelector(false)}
          />
        </div>
      )}
    </div>
  )
}
