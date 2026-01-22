import { TEAMS, TEAM_COLORS } from "../../lib/teams"
import type { TeamName } from "../../lib/teams"
import "./ScoreBoard.css"

export function ScoreBoard() {
  // TODO: Get scores from game state
  const scores: Record<TeamName, number> = {
    RED: 0,
    BLUE: 0,
    GREEN: 0,
    YELLOW: 0,
  }

  return (
    <div className="scoreboard" data-testid="scoreboard">
      {TEAMS.map((team) => (
        <span
          key={team}
          className="scoreboard-item"
          data-testid={`score-${team.toLowerCase()}`}
          style={{ color: TEAM_COLORS[team].primary }}
        >
          {team.charAt(0)}: {scores[team]}
        </span>
      ))}
    </div>
  )
}
