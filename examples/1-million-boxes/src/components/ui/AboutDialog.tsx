import { Dialog } from "@base-ui/react/dialog"
import { TEAMS, TEAM_COLORS } from "../../lib/teams"
import { useTeam } from "../../contexts/team-context"
import {
  MAX_QUOTA,
  QUOTA_REFILL_INTERVAL_MS,
  TOTAL_BOX_COUNT,
} from "../../lib/config"
import type { TeamName } from "../../lib/teams"
import "./AboutDialog.css"

export interface AboutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  scores?: [number, number, number, number]
}

interface TeamScore {
  team: TeamName
  score: number
  color: string
}

export function AboutDialog({
  open,
  onOpenChange,
  scores = [0, 0, 0, 0],
}: AboutDialogProps) {
  const { team: userTeam } = useTeam()
  const userTeamColor = TEAM_COLORS[userTeam].primary

  // Calculate claimed and remaining
  const totalClaimed = scores.reduce((a, b) => a + b, 0)
  const remaining = TOTAL_BOX_COUNT - totalClaimed

  // Create team scores sorted by score (descending)
  const hasScores = totalClaimed > 0
  const teamScores: Array<TeamScore> = TEAMS.map((team, i) => ({
    team,
    score: scores[i],
    color: TEAM_COLORS[team].primary,
  }))

  if (hasScores) {
    teamScores.sort((a, b) => b.score - a.score)
  }

  const refillSeconds = QUOTA_REFILL_INTERVAL_MS / 1000

  // Format team name for display (capitalize first letter only)
  const teamDisplayName = userTeam.charAt(0) + userTeam.slice(1).toLowerCase()

  // Yellow team needs dark text for contrast
  const buttonTextColor = userTeam === `YELLOW` ? `#333` : `white`

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="about-dialog-backdrop" />
        <Dialog.Popup className="about-dialog-popup">
          <Dialog.Title className="about-dialog-title">
            <img
              src="/logo.svg"
              alt="1 Million Boxes"
              className="about-dialog-logo"
            />
          </Dialog.Title>

          <div className="about-dialog-content">
            <p>
              A massive multiplayer Dots &amp; Boxes game with{` `}
              <strong>1,000,000 boxes</strong> on a 1000×1000 grid.
            </p>

            <h3 className="about-dialog-section-title">How to Play</h3>
            <ul className="about-dialog-rules">
              <li>
                <span className="desktop-only">Click</span>
                <span className="mobile-only">Tap</span> between two dots to
                draw a line
              </li>
              <li>
                Complete all four sides of a box to claim it for your team
              </li>
              <li>The team with the most boxes wins!</li>
            </ul>

            <h3 className="about-dialog-section-title">Quota System</h3>
            <ul className="about-dialog-rules">
              <li>
                You have <strong>{MAX_QUOTA} moves</strong> available at a time
              </li>
              <li>
                Moves refill at <strong>1 every {refillSeconds} seconds</strong>
              </li>
              <li>
                <strong>Bonus:</strong> Completing a box refunds your move!
              </li>
              <li>Complete 2 boxes with one line? Get 2 moves back!</li>
            </ul>

            <h3 className="about-dialog-section-title">Team Leaderboard</h3>
            <div className="about-dialog-leaderboard">
              {teamScores.map(({ team, score, color }, index) => (
                <div key={team} className="about-leaderboard-item">
                  <span className="about-leaderboard-rank">{index + 1}</span>
                  <span
                    className="about-leaderboard-dot"
                    style={{ background: color }}
                  />
                  <span className="about-leaderboard-team">{team}</span>
                  <span className="about-leaderboard-score">
                    {score.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>

            <div className="about-dialog-stats">
              <div className="about-stat">
                <span className="about-stat-value">
                  {remaining.toLocaleString()}
                </span>
                <span className="about-stat-label">boxes available</span>
              </div>
              <div className="about-stat">
                <span className="about-stat-value">
                  {totalClaimed.toLocaleString()}
                </span>
                <span className="about-stat-label">boxes claimed</span>
              </div>
            </div>

            <p className="about-dialog-tech">
              Built with{` `}
              <a
                href="http://github.com/durable-streams/durable-streams/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Durable Streams
              </a>
              {` `}for real-time synchronization.
            </p>
          </div>

          <Dialog.Close
            className="about-dialog-close-button"
            style={{
              background: userTeamColor,
              color: buttonTextColor,
            }}
          >
            You're on the {teamDisplayName} team, Play!
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
