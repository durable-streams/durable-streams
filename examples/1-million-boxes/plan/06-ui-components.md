# Phase 06: UI Components

## Goal

Implement all the UI components: quota meter, team badge, scoreboard, zoom controls, and share dialog using Base UI.

## Dependencies

- Phase 04 (Frontend Foundation)

## Tasks

### 6.1 Complete QuotaMeter Component

Update `src/components/ui/QuotaMeter.tsx`:

```tsx
import * as Progress from "@base-ui/react/progress"
import { useQuota } from "../../contexts/quota-context"
import "./QuotaMeter.css"

export function QuotaMeter() {
  const { remaining, max, refillIn } = useQuota()
  const percent = (remaining / max) * 100
  const color = remaining > 5 ? "full" : remaining > 2 ? "mid" : "low"
  const isEmpty = remaining === 0

  return (
    <div
      className={`quota-meter ${isEmpty ? "quota-empty" : ""}`}
      data-testid="quota-meter"
    >
      <div className="quota-visual">
        <Progress.Root value={remaining} max={max} className="quota-progress">
          <Progress.Track className="quota-track">
            <Progress.Indicator
              className={`quota-indicator quota-${color}`}
              style={{ width: `${percent}%` }}
            />
          </Progress.Track>
        </Progress.Root>

        {/* Segmented display */}
        <div className="quota-segments">
          {Array.from({ length: max }).map((_, i) => (
            <div
              key={i}
              className={`quota-segment ${i < remaining ? "filled" : ""} ${i < remaining ? `segment-${color}` : ""}`}
            />
          ))}
        </div>
      </div>

      <div className="quota-info">
        <span className="quota-text">
          {remaining}/{max} lines
        </span>
        {remaining < max && (
          <span className="quota-refill">+1 in {refillIn}s</span>
        )}
        {isEmpty && <span className="quota-recharging">Recharging...</span>}
      </div>
    </div>
  )
}
```

Update `src/components/ui/QuotaMeter.css`:

```css
.quota-meter {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 120px;
}

.quota-visual {
  position: relative;
}

.quota-progress {
  width: 100%;
  height: 8px;
}

.quota-track {
  width: 100%;
  height: 100%;
  background: #e0e0e0;
  border-radius: 4px;
  overflow: hidden;
}

.quota-indicator {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s ease;
}

.quota-full {
  background: var(--quota-full);
}
.quota-mid {
  background: var(--quota-mid);
}
.quota-low {
  background: var(--quota-low);
}

.quota-segments {
  display: flex;
  gap: 2px;
  margin-top: 4px;
}

.quota-segment {
  flex: 1;
  height: 4px;
  background: #e0e0e0;
  border-radius: 2px;
  transition: background 0.2s;
}

.quota-segment.filled.segment-full {
  background: var(--quota-full);
}
.quota-segment.filled.segment-mid {
  background: var(--quota-mid);
}
.quota-segment.filled.segment-low {
  background: var(--quota-low);
}

.quota-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.quota-text {
  font-weight: 600;
  color: var(--color-text);
}

.quota-refill {
  color: #666;
}

.quota-recharging {
  color: var(--quota-low);
  font-weight: 500;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

.quota-empty .quota-meter {
  opacity: 0.7;
}
```

### 6.2 Complete TeamBadge Component

Update `src/components/ui/TeamBadge.tsx`:

```tsx
import { useTeam } from "../../contexts/team-context"
import { TEAM_COLORS, TeamName } from "../../lib/teams"
import "./TeamBadge.css"

export function TeamBadge() {
  const { team, teamId } = useTeam()
  const color = TEAM_COLORS[team]

  return (
    <div className="team-badge" data-testid="team-badge">
      <div
        className="team-color-dot"
        style={{ backgroundColor: color.primary }}
      />
      <span className="team-name">{team}</span>
    </div>
  )
}
```

Create `src/components/ui/TeamBadge.css`:

```css
.team-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: white;
  border-radius: 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.team-color-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  box-shadow: inset 0 -2px 4px rgba(0, 0, 0, 0.2);
}

.team-name {
  font-weight: 600;
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
```

### 6.3 Complete ScoreBoard Component

Update `src/components/ui/ScoreBoard.tsx`:

```tsx
import { TEAMS, TEAM_COLORS } from "../../lib/teams"
import { useGameState } from "../../hooks/useGameState"
import "./ScoreBoard.css"

export function ScoreBoard() {
  const { gameState } = useGameState()
  const scores = gameState.getScores()

  // Sort teams by score descending
  const rankedTeams = TEAMS.map((team, i) => ({
    team,
    teamId: i,
    score: scores[i],
    color: TEAM_COLORS[team],
  })).sort((a, b) => b.score - a.score)

  return (
    <div className="scoreboard" data-testid="scoreboard">
      {rankedTeams.map(({ team, teamId, score, color }) => (
        <div
          key={team}
          className="score-item"
          data-testid={`score-${team.toLowerCase()}`}
        >
          <div
            className="score-color"
            style={{ backgroundColor: color.primary }}
          />
          <span className="score-value">{score.toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}
```

Create `src/components/ui/ScoreBoard.css`:

```css
.scoreboard {
  display: flex;
  gap: 16px;
  align-items: center;
}

.score-item {
  display: flex;
  align-items: center;
  gap: 4px;
}

.score-color {
  width: 12px;
  height: 12px;
  border-radius: 2px;
}

.score-value {
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  min-width: 40px;
}

/* Responsive: stack on mobile */
@media (max-width: 480px) {
  .scoreboard {
    flex-wrap: wrap;
    gap: 8px;
  }

  .score-item {
    flex: 0 0 45%;
  }
}
```

### 6.4 Complete ZoomControls Component

Update `src/components/ui/ZoomControls.tsx`:

```tsx
import { useViewState } from "../../hooks/useViewState"
import "./ZoomControls.css"

export function ZoomControls() {
  const { view, zoomIn, zoomOut, resetView } = useViewState()

  // Show zoom percentage
  const zoomPercent = Math.round(view.zoom * 100)

  return (
    <div className="zoom-controls">
      <button
        className="zoom-btn"
        onClick={zoomOut}
        data-testid="zoom-out"
        aria-label="Zoom out"
        disabled={view.zoom <= 0.1}
      >
        −
      </button>

      <button
        className="zoom-level"
        onClick={resetView}
        aria-label="Reset zoom"
      >
        {zoomPercent}%
      </button>

      <button
        className="zoom-btn"
        onClick={zoomIn}
        data-testid="zoom-in"
        aria-label="Zoom in"
        disabled={view.zoom >= 10}
      >
        +
      </button>
    </div>
  )
}
```

Create `src/components/ui/ZoomControls.css`:

```css
.zoom-controls {
  display: flex;
  align-items: center;
  gap: 4px;
  background: white;
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.zoom-btn {
  width: var(--touch-min);
  height: var(--touch-min);
  border: none;
  background: transparent;
  font-size: 20px;
  font-weight: 600;
  cursor: pointer;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text);
  transition: background 0.2s;
}

.zoom-btn:hover:not(:disabled) {
  background: #f0f0f0;
}

.zoom-btn:active:not(:disabled) {
  background: #e0e0e0;
}

.zoom-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.zoom-level {
  min-width: 48px;
  height: 32px;
  border: none;
  background: #f5f5f5;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 4px;
  padding: 0 8px;
}

.zoom-level:hover {
  background: #e8e8e8;
}
```

### 6.5 ShareDialog Component

Create `src/components/ui/ShareDialog.tsx`:

```tsx
import { useState } from "react"
import * as Dialog from "@base-ui/react/dialog"
import "./ShareDialog.css"

interface ShareDialogProps {
  open: boolean
  onClose: () => void
}

export function ShareDialog({ open, onClose }: ShareDialogProps) {
  const [copied, setCopied] = useState(false)
  const shareUrl = typeof window !== "undefined" ? window.location.href : ""

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error("Failed to copy:", err)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className="dialog-popup">
          <Dialog.Title className="dialog-title">Share this game</Dialog.Title>
          <Dialog.Description className="dialog-description">
            Copy the link to invite others to play
          </Dialog.Description>

          <div className="share-input-group">
            <input
              type="text"
              value={shareUrl}
              readOnly
              className="share-input"
              onClick={(e) => e.currentTarget.select()}
            />
            <button className="share-copy-btn" onClick={handleCopy}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>

          <Dialog.Close className="dialog-close">×</Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
```

Create `src/components/ui/ShareDialog.css`:

```css
.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 100;
}

.dialog-popup {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: white;
  border-radius: 12px;
  padding: 24px;
  max-width: 400px;
  width: 90%;
  z-index: 101;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
}

.dialog-title {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 8px;
}

.dialog-description {
  font-size: 14px;
  color: #666;
  margin: 0 0 20px;
}

.share-input-group {
  display: flex;
  gap: 8px;
}

.share-input {
  flex: 1;
  padding: 10px 12px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 14px;
  background: #f9f9f9;
}

.share-copy-btn {
  padding: 10px 16px;
  background: var(--color-blue);
  color: white;
  border: none;
  border-radius: 6px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
  min-width: 80px;
}

.share-copy-btn:hover {
  background: #1976d2;
}

.dialog-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  font-size: 24px;
  cursor: pointer;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #999;
}

.dialog-close:hover {
  background: #f0f0f0;
  color: #333;
}
```

### 6.6 Share Button in Header

Update `src/components/layout/Header.tsx` to include share button:

```tsx
import { useState } from "react"
import { TeamBadge } from "../ui/TeamBadge"
import { ScoreBoard } from "../ui/ScoreBoard"
import { ShareDialog } from "../ui/ShareDialog"
import "./Header.css"

export function Header() {
  const [shareOpen, setShareOpen] = useState(false)

  return (
    <header className="header" data-testid="header">
      <TeamBadge />
      <ScoreBoard />
      <button
        className="share-btn"
        onClick={() => setShareOpen(true)}
        aria-label="Share game"
      >
        Share
      </button>
      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} />
    </header>
  )
}
```

Add to `src/components/layout/Header.css`:

```css
.share-btn {
  padding: 8px 16px;
  background: var(--color-text);
  color: white;
  border: none;
  border-radius: 6px;
  font-weight: 500;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.2s;
}

.share-btn:hover {
  background: #444;
}
```

## Deliverables

- [ ] Complete `QuotaMeter` with segments and animation
- [ ] Complete `TeamBadge` with color dot
- [ ] Complete `ScoreBoard` with sorted scores
- [ ] Complete `ZoomControls` with percentage display
- [ ] `ShareDialog` with copy functionality
- [ ] Share button in header
- [ ] All CSS styling complete
- [ ] Components render correctly

## Next Phase

→ `07-realtime-sync.md`
