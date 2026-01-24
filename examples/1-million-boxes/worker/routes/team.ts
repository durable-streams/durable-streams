import { Hono } from "hono"
import { teamIdToName } from "../lib/teams"
import { assignTeam } from "../lib/team-assignment"
import {
  buildIdentityCookieHeader,
  createIdentityCookie,
  generatePlayerId,
  parseIdentityCookie,
} from "../lib/identity-cookie"
import type { Bindings } from "../index"

export const teamRoutes = new Hono<{ Bindings: Bindings }>()

/**
 * Get or assign team and player ID for the current user.
 * Reads from combined identity cookie, or assigns new values if none exist.
 *
 * Cookie format: playerId.teamId.hmac (cryptographically linked)
 */
teamRoutes.get(`/`, async (c) => {
  const secret = c.env.TEAM_COOKIE_SECRET || `dev-secret`
  const isProduction = c.env.NODE_ENV === `production`

  const cookieHeader = c.req.header(`cookie`)

  // Parse combined identity cookie
  let identity = await parseIdentityCookie(cookieHeader, secret)

  if (identity === null) {
    // Generate new identity
    const playerId = generatePlayerId()
    const teamId = assignTeam()
    identity = { playerId, teamId }

    // Set combined cookie
    const cookieValue = await createIdentityCookie(playerId, teamId, secret)
    c.header(`Set-Cookie`, buildIdentityCookieHeader(cookieValue, isProduction))
  }

  return c.json({
    team: teamIdToName(identity.teamId),
    teamId: identity.teamId,
    playerId: identity.playerId,
  })
})
