import { TEAMS, TEAM_COLORS } from "../../lib/teams"
import { TOTAL_BOX_COUNT } from "../../lib/config"
import type { TeamName } from "../../lib/teams"
import "./ScoreBoard.css"

export interface ScoreBoardProps {
  scores?: [number, number, number, number]
  className?: string
}

interface TeamScore {
  team: TeamName
  score: number
  color: string
}

export function ScoreBoard({
  scores = [0, 0, 0, 0],
  className = ``,
}: ScoreBoardProps) {
  // Calculate claimed and remaining
  const totalClaimed = scores.reduce((a, b) => a + b, 0)
  const remaining = TOTAL_BOX_COUNT - totalClaimed

  // Create team scores - sort by score if there are any, otherwise keep original order
  const hasScores = totalClaimed > 0
  const teamScores: Array<TeamScore> = TEAMS.map((team, i) => ({
    team,
    score: scores[i],
    color: TEAM_COLORS[team].primary,
  }))

  // Only sort if there are actual scores
  if (hasScores) {
    teamScores.sort((a, b) => b.score - a.score)
  }

  return (
    <div className={`scoreboard ${className}`.trim()} data-testid="scoreboard">
      {teamScores.map(({ team, score, color }) => (
        <div
          key={team}
          className="scoreboard-item"
          data-testid={`score-${team.toLowerCase()}`}
        >
          <span
            className="scoreboard-indicator"
            style={{ background: color }}
          />
          <span className="scoreboard-value">{score.toLocaleString()}</span>
        </div>
      ))}
      <div className="scoreboard-item scoreboard-remaining">
        <span className="scoreboard-indicator" style={{ background: `#999` }} />
        <span className="scoreboard-value">{remaining.toLocaleString()}</span>
      </div>
    </div>
  )
}
