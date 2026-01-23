import { useState } from "react"
import { useGameState } from "../../hooks/useGameState"
import { TeamBadge } from "../ui/TeamBadge"
import { ScoreBoard } from "../ui/ScoreBoard"
import { ShareDialog } from "../ui/ShareDialog"
import { AboutDialog } from "../ui/AboutDialog"
import "./Header.css"

export function Header() {
  const [shareDialogOpen, setShareDialogOpen] = useState(false)
  const [aboutDialogOpen, setAboutDialogOpen] = useState(false)
  const { gameState } = useGameState()

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

        <ScoreBoard
          scores={gameState.getScores()}
          className="header-scoreboard"
        />

        <div className="header-right">
          <button
            className="header-button"
            onClick={() => setAboutDialogOpen(true)}
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

        <AboutDialog open={aboutDialogOpen} onOpenChange={setAboutDialogOpen} />
        <ShareDialog open={shareDialogOpen} onOpenChange={setShareDialogOpen} />
      </header>

      {/* Floating scoreboard for mobile */}
      <ScoreBoard
        scores={gameState.getScores()}
        className="floating-scoreboard"
      />
    </>
  )
}
