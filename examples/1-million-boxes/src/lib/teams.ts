/**
 * Team names in order of team ID.
 */
export const TEAMS = [`RED`, `BLUE`, `GREEN`, `YELLOW`] as const

/**
 * Type for team names.
 */
export type TeamName = (typeof TEAMS)[number]

/**
 * Team colors with primary (stroke) and fill (box) variants.
 */
export const TEAM_COLORS = {
  RED: {
    primary: `#E53935`,
    fill: `rgba(229, 57, 53, 0.5)`,
  },
  BLUE: {
    primary: `#1E88E5`,
    fill: `rgba(30, 136, 229, 0.5)`,
  },
  GREEN: {
    primary: `#43A047`,
    fill: `rgba(67, 160, 71, 0.5)`,
  },
  YELLOW: {
    primary: `#FDD835`,
    fill: `rgba(253, 216, 53, 0.5)`,
  },
} as const

/**
 * Convert a team ID (0-3) to a team name.
 */
export function teamIdToName(teamId: number): TeamName {
  if (teamId < 0 || teamId >= TEAMS.length) {
    throw new Error(`Invalid team ID: ${teamId}`)
  }
  return TEAMS[teamId]
}

/**
 * Convert a team name to a team ID (0-3).
 */
export function teamNameToId(name: TeamName): number {
  const id = TEAMS.indexOf(name)
  if (id === -1) {
    throw new Error(`Invalid team name: ${name}`)
  }
  return id
}

/**
 * Get the colors for a team by ID.
 */
export function getTeamColor(teamId: number): {
  primary: string
  fill: string
} {
  const name = teamIdToName(teamId)
  return TEAM_COLORS[name]
}
