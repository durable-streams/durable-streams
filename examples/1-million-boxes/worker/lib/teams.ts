/**
 * Team definitions for the game.
 */

export type TeamName = `RED` | `BLUE` | `GREEN` | `YELLOW`

export const TEAM_COLORS: Record<TeamName, string> = {
  RED: `#e74c3c`,
  BLUE: `#3498db`,
  GREEN: `#2ecc71`,
  YELLOW: `#f1c40f`,
}

export const TEAM_NAMES: Array<TeamName> = [`RED`, `BLUE`, `GREEN`, `YELLOW`]

/**
 * Convert team ID (0-3) to team name.
 */
export function teamIdToName(teamId: number): TeamName {
  return TEAM_NAMES[teamId] ?? `RED`
}

/**
 * Convert team name to team ID (0-3).
 */
export function teamNameToId(name: TeamName): number {
  return TEAM_NAMES.indexOf(name)
}
