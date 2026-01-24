import { useCallback, useState } from "react"
import { useGameState } from "../../hooks/useGameState"
import { TeamBadge } from "../ui/TeamBadge"
import { ScoreBoard } from "../ui/ScoreBoard"
import { ShareDialog } from "../ui/ShareDialog"
import { AboutDialog } from "../ui/AboutDialog"
import "./Header.css"

const ABOUT_DISMISSED_KEY = `boxes:about-dismissed`

export function Header() {
  const [shareDialogOpen, setShareDialogOpen] = useState(false)
  // Show about dialog on first load unless already dismissed this session
  const [aboutDialogOpen, setAboutDialogOpen] = useState(() => {
    try {
      return sessionStorage.getItem(ABOUT_DISMISSED_KEY) !== `true`
    } catch {
      return true // Show if sessionStorage unavailable
    }
  })
  // Explicitly depend on version to ensure re-render when game state changes
  const { gameState, version } = useGameState()
  // Get current scores (will update when version changes)
  const scores = gameState.getScores()
  // Suppress unused variable warning - version is used to trigger re-renders
  void version

  // Handle about dialog close - store dismissal in sessionStorage
  const handleAboutOpenChange = useCallback((open: boolean) => {
    setAboutDialogOpen(open)
    if (!open) {
      try {
        sessionStorage.setItem(ABOUT_DISMISSED_KEY, `true`)
      } catch {
        // Ignore if sessionStorage unavailable
      }
    }
  }, [])

  return (
    <>
      <header className="header" data-testid="header">
        <div className="header-left">
          <h1 className="header-title">
            <img
              src="/logo.svg"
              alt="1 Million Boxes"
              className="header-logo"
            />
          </h1>
          <TeamBadge />
        </div>

        {/* Centered team badge for mobile */}
        <div className="header-center">
          <TeamBadge />
        </div>

        <ScoreBoard scores={scores} className="header-scoreboard" />

        <div className="header-right">
          <button
            className="header-button"
            onClick={() => handleAboutOpenChange(true)}
            aria-label="About"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <span className="header-button-text">About</span>
          </button>

          <button
            className="header-button"
            onClick={() => setShareDialogOpen(true)}
            aria-label="Share"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </svg>
            <span className="header-button-text">Share</span>
          </button>
        </div>

        <AboutDialog
          open={aboutDialogOpen}
          onOpenChange={handleAboutOpenChange}
          scores={scores}
        />
        <ShareDialog open={shareDialogOpen} onOpenChange={setShareDialogOpen} />
      </header>

      {/* Floating scoreboard for mobile */}
      <ScoreBoard scores={scores} className="floating-scoreboard" />
    </>
  )
}
