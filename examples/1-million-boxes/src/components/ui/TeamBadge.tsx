import { TEAM_COLORS } from "../../lib/teams"
import type { TeamName } from "../../lib/teams"

export interface TeamBadgeProps {
  team: TeamName
  teamId: number
}

export function TeamBadge({ team, teamId }: TeamBadgeProps) {
  const color = TEAM_COLORS[team].primary

  return (
    <div
      className="team-badge"
      data-testid="team-badge"
      style={{
        display: `flex`,
        alignItems: `center`,
        gap: `8px`,
      }}
    >
      <div
        data-testid="team-color-dot"
        style={{
          width: 16,
          height: 16,
          borderRadius: `50%`,
          background: color,
        }}
      />
      <span data-testid="team-name">
        {team.charAt(0) + team.slice(1).toLowerCase()}
      </span>
      <span
        data-testid="team-id"
        style={{ color: `var(--color-muted)`, fontSize: `0.875rem` }}
      >
        #{teamId}
      </span>
    </div>
  )
}
