import { useTeam } from "../../contexts/team-context"
import { TEAM_COLORS } from "../../lib/teams"
import "./TeamBadge.css"

export function TeamBadge() {
  const { team, teamId } = useTeam()
  const color = TEAM_COLORS[team].primary

  return (
    <div className="team-badge" data-testid="team-badge">
      <div
        className="team-badge-dot"
        data-testid="team-color-dot"
        style={{ background: color }}
      />
      <span className="team-badge-name" data-testid="team-name">
        {team.charAt(0) + team.slice(1).toLowerCase()}
      </span>
      <span className="team-badge-id" data-testid="team-id">
        #{teamId}
      </span>
    </div>
  )
}
