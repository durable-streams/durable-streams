import { createServerFn } from "@tanstack/react-start"
import {
  getRequestHeader,
  setResponseHeader,
} from "@tanstack/react-start/server"
import { z } from "zod"
import { env } from "cloudflare:workers"
import { teamIdToName } from "../lib/teams"
import {
  buildSetCookieHeader,
  createTeamCookie,
  parseTeamCookie,
} from "./team-cookie"
import { assignTeam } from "./team-assignment"

/**
 * Get or assign team for the current user.
 * Reads team from cookie, or assigns a new team if none exists.
 */
export const getTeam = createServerFn({ method: `GET` }).handler(async () => {
  const secret = env.TEAM_COOKIE_SECRET || `dev-secret`
  const isProduction = env.NODE_ENV === `production`

  const cookieHeader = getRequestHeader(`cookie`)
  let teamId = await parseTeamCookie(cookieHeader, secret)

  if (teamId === null) {
    // Assign new team
    teamId = assignTeam()
    const cookieValue = await createTeamCookie(teamId, secret)
    setResponseHeader(
      `Set-Cookie`,
      buildSetCookieHeader(cookieValue, isProduction)
    )
  }

  return {
    team: teamIdToName(teamId),
    teamId,
  }
})

/**
 * Draw an edge on the game board.
 * Validates team from cookie and forwards request to GameWriterDO.
 */
export const drawEdge = createServerFn({ method: `POST` })
  .inputValidator(z.object({ edgeId: z.number().int().min(0) }))
  .handler(async ({ data }) => {
    const secret = env.TEAM_COOKIE_SECRET || `dev-secret`
    const cookieHeader = getRequestHeader(`cookie`)

    const teamId = await parseTeamCookie(cookieHeader, secret)

    if (teamId === null) {
      return { ok: false, code: `NO_TEAM` as const }
    }

    // Get DO stub for the single game instance
    const id = env.GAME_WRITER.idFromName(`game`)
    const stub = env.GAME_WRITER.get(id)

    // Forward request to DO
    const response = await stub.fetch(`http://do/draw`, {
      method: `POST`,
      headers: { "Content-Type": `application/json` },
      body: JSON.stringify({ edgeId: data.edgeId, teamId }),
    })

    return await response.json()
  })
