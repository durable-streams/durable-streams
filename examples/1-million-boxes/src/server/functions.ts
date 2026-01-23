import { createServerFn } from "@tanstack/react-start"
import {
  getRequestHeader,
  setResponseHeader,
} from "@tanstack/react-start/server"
import { z } from "zod"
import { env } from "cloudflare:workers"
import { teamIdToName } from "../lib/teams"
import { isValidEdgeId } from "../lib/edge-math"
import { encodeEvent } from "../lib/stream-parser"
import { GAME_STREAM_PATH } from "../lib/config"
import {
  buildSetCookieHeader,
  createTeamCookie,
  parseTeamCookie,
} from "./team-cookie"
import { assignTeam } from "./team-assignment"
import type { GameEvent } from "../lib/game-state"

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
 * Write an edge directly to the Durable Streams server.
 * Used as fallback when DO binding is unavailable (local dev).
 */
async function writeEdgeDirectly(
  edgeId: number,
  teamId: number
): Promise<{ ok: boolean; code?: string }> {
  // Validate edge ID
  if (!isValidEdgeId(edgeId)) {
    return { ok: false, code: `INVALID_EDGE` }
  }

  // Validate team ID
  if (typeof teamId !== `number` || teamId < 0 || teamId > 3) {
    return { ok: false, code: `INVALID_TEAM` }
  }

  // Encode and write to stream
  const event: GameEvent = { edgeId, teamId }
  const encoded = encodeEvent(event)

  const streamUrl =
    env.DURABLE_STREAMS_URL || `http://localhost:4437/v1/stream`

  try {
    const requestBody = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength
    ) as ArrayBuffer

    const response = await fetch(`${streamUrl}${GAME_STREAM_PATH}`, {
      method: `POST`,
      headers: { "Content-Type": `application/octet-stream` },
      body: requestBody,
    })

    if (!response.ok) {
      // If stream doesn't exist, create it first
      if (response.status === 404) {
        const createResponse = await fetch(`${streamUrl}${GAME_STREAM_PATH}`, {
          method: `PUT`,
          headers: { "Content-Type": `application/octet-stream` },
        })
        if (createResponse.ok) {
          // Retry the POST
          const retryResponse = await fetch(`${streamUrl}${GAME_STREAM_PATH}`, {
            method: `POST`,
            headers: { "Content-Type": `application/octet-stream` },
            body: requestBody,
          })
          if (!retryResponse.ok) {
            return { ok: false, code: `STREAM_ERROR` }
          }
        } else {
          return { ok: false, code: `STREAM_ERROR` }
        }
      } else {
        return { ok: false, code: `STREAM_ERROR` }
      }
    }

    return { ok: true }
  } catch (err) {
    console.error(`Failed to write to stream:`, err)
    return { ok: false, code: `STREAM_ERROR` }
  }
}

/**
 * Draw an edge on the game board.
 * Validates team from cookie and forwards request to GameWriterDO.
 * Falls back to direct stream write in development when DO is unavailable.
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

    // Try to use the DO first (works in production)
    try {
      if (env.GAME_WRITER) {
        const id = env.GAME_WRITER.idFromName(`game`)
        const stub = env.GAME_WRITER.get(id)

        const response = await stub.fetch(`http://do/draw`, {
          method: `POST`,
          headers: { "Content-Type": `application/json` },
          body: JSON.stringify({ edgeId: data.edgeId, teamId }),
        })

        return (await response.json()) as { ok: boolean; code?: string }
      }
    } catch (err) {
      // DO binding failed - fall back to direct write
      console.warn(`DO binding unavailable, using direct stream write:`, err)
    }

    // Fallback: write directly to stream (development mode)
    return writeEdgeDirectly(data.edgeId, teamId)
  })
