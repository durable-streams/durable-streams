import { useTeam } from "../../contexts/team-context"
import { TEAM_COLORS } from "../../../shared/teams"
import "./TeamBadge.css"

export function TeamBadge() {
  const { team } = useTeam()
  const color = TEAM_COLORS[team].primary
  const teamName = team.charAt(0) + team.slice(1).toLowerCase()

  return (
    <div className="team-badge" data-testid="team-badge">
      <div
        className="team-badge-dot"
        data-testid="team-color-dot"
        style={{ background: color }}
      />
      <span className="team-badge-name" data-testid="team-name">
        {teamName}
        <span className="team-badge-suffix"> Team</span>
      </span>
    </div>
  )
}
