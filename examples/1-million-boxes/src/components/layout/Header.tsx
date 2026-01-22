import { useState } from "react"
import { TeamBadge } from "../ui/TeamBadge"
import { ScoreBoard } from "../ui/ScoreBoard"
import { ShareDialog } from "../ui/ShareDialog"
import "./Header.css"

export function Header() {
  const [shareDialogOpen, setShareDialogOpen] = useState(false)

  return (
    <header className="header" data-testid="header">
      <TeamBadge />
      <ScoreBoard />
      <button
        className="header-share-button"
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
        <span className="header-share-text">Share</span>
      </button>
      <ShareDialog open={shareDialogOpen} onOpenChange={setShareDialogOpen} />
    </header>
  )
}
