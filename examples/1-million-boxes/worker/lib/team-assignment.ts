/**
 * Simple random team assignment.
 * Returns a team ID (0-3).
 */
export function assignTeam(): number {
  return Math.floor(Math.random() * 4)
}
