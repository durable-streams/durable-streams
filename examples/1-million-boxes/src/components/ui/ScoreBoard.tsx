import { TEAMS, TEAM_COLORS } from "../../lib/teams"
import type { TeamName } from "../../lib/teams"
import "./ScoreBoard.css"

export interface ScoreBoardProps {
  scores?: [number, number, number, number]
}

interface TeamScore {
  team: TeamName
  score: number
  color: string
}

export function ScoreBoard({ scores = [0, 0, 0, 0] }: ScoreBoardProps) {
  // Create team scores and sort by score descending
  const teamScores: Array<TeamScore> = TEAMS.map((team, i) => ({
    team,
    score: scores[i],
    color: TEAM_COLORS[team].primary,
  })).sort((a, b) => b.score - a.score)

  return (
    <div className="scoreboard" data-testid="scoreboard">
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
    </div>
  )
}
