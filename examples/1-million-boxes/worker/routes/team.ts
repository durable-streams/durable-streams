import { Hono } from "hono"
import { teamIdToName } from "../lib/teams"
import { assignTeam } from "../lib/team-assignment"
import {
  buildSetCookieHeader,
  createTeamCookie,
  parseTeamCookie,
} from "../lib/team-cookie"
import {
  buildPlayerCookieHeader,
  createPlayerCookie,
  generatePlayerId,
  parsePlayerCookie,
} from "../lib/player-cookie"
import type { Bindings } from "../index"

export const teamRoutes = new Hono<{ Bindings: Bindings }>()

/**
 * Get or assign team and player ID for the current user.
 * Reads from cookies, or assigns new values if none exist.
 */
teamRoutes.get(`/`, async (c) => {
  const secret = c.env.TEAM_COOKIE_SECRET || `dev-secret`
  const isProduction = c.env.NODE_ENV === `production`

  const cookieHeader = c.req.header(`cookie`)

  // Parse team cookie
  let teamId = await parseTeamCookie(cookieHeader, secret)
  if (teamId === null) {
    teamId = assignTeam()
    const cookieValue = await createTeamCookie(teamId, secret)
    c.header(`Set-Cookie`, buildSetCookieHeader(cookieValue, isProduction), {
      append: true,
    })
  }

  // Parse player cookie
  let playerId = await parsePlayerCookie(cookieHeader, secret)
  if (playerId === null) {
    playerId = generatePlayerId()
    const cookieValue = await createPlayerCookie(playerId, secret)
    c.header(`Set-Cookie`, buildPlayerCookieHeader(cookieValue, isProduction), {
      append: true,
    })
  }

  return c.json({
    team: teamIdToName(teamId),
    teamId,
    playerId,
  })
})
