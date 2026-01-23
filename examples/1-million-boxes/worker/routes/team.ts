import { Hono } from "hono"
import { teamIdToName } from "../lib/teams"
import { assignTeam } from "../lib/team-assignment"
import {
  buildSetCookieHeader,
  createTeamCookie,
  parseTeamCookie,
} from "../lib/team-cookie"
import type { Bindings } from "../index"

export const teamRoutes = new Hono<{ Bindings: Bindings }>()

/**
 * Get or assign team for the current user.
 * Reads team from cookie, or assigns a new team if none exists.
 */
teamRoutes.get(`/`, async (c) => {
  const secret = c.env.TEAM_COOKIE_SECRET || `dev-secret`
  const isProduction = c.env.NODE_ENV === `production`

  const cookieHeader = c.req.header(`cookie`)
  let teamId = await parseTeamCookie(cookieHeader, secret)

  if (teamId === null) {
    // Assign new team
    teamId = assignTeam()
    const cookieValue = await createTeamCookie(teamId, secret)
    c.header(`Set-Cookie`, buildSetCookieHeader(cookieValue, isProduction))
  }

  return c.json({
    team: teamIdToName(teamId),
    teamId,
  })
})
