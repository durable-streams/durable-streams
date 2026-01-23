import { Hono } from "hono"
import { z } from "zod"
import { parseTeamCookie } from "../lib/team-cookie"
import { isValidEdgeId } from "../lib/edge-math"
import { encodeEvent } from "../lib/stream-parser"
import { GAME_STREAM_PATH } from "../lib/config"
import type { Bindings } from "../index"
import type { GameEvent } from "../lib/game-state"

export const drawRoutes = new Hono<{ Bindings: Bindings }>()

const drawSchema = z.object({
  edgeId: z.number().int().min(0),
})

/**
 * Write an edge directly to the Durable Streams server.
 * Used as fallback when DO binding is unavailable (local dev).
 */
async function writeEdgeDirectly(
  streamUrl: string,
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
drawRoutes.post(`/`, async (c) => {
  const secret = c.env.TEAM_COOKIE_SECRET || `dev-secret`
  const cookieHeader = c.req.header(`cookie`)

  const teamId = await parseTeamCookie(cookieHeader, secret)

  if (teamId === null) {
    return c.json({ ok: false, code: `NO_TEAM` }, 401)
  }

  // Parse and validate request body
  let body: { edgeId: number }
  try {
    body = await c.req.json()
    drawSchema.parse(body)
  } catch {
    return c.json({ ok: false, code: `INVALID_REQUEST` }, 400)
  }

  // Try to use the DO first (works in production)
  try {
    if (c.env.GAME_WRITER) {
      const id = c.env.GAME_WRITER.idFromName(`game`)
      const stub = c.env.GAME_WRITER.get(id)

      const response = await stub.fetch(`http://do/draw`, {
        method: `POST`,
        headers: { "Content-Type": `application/json` },
        body: JSON.stringify({ edgeId: body.edgeId, teamId }),
      })

      const result = await response.json()
      return c.json(
        result,
        response.status as 200 | 400 | 409 | 410 | 500 | 503
      )
    }
  } catch (err) {
    // DO binding failed - fall back to direct write
    console.warn(`DO binding unavailable, using direct stream write:`, err)
  }

  // Fallback: write directly to stream (development mode)
  const result = await writeEdgeDirectly(
    c.env.DURABLE_STREAMS_URL,
    body.edgeId,
    teamId
  )
  return c.json(result, result.ok ? 200 : 500)
})
