import { GameState } from "../lib/game-state"
import { encodeEvent, parseStreamRecords } from "../lib/stream-parser"
import { isValidEdgeId } from "../lib/edge-math"
import { GAME_STREAM_PATH } from "../lib/config"
import type { GameEvent } from "../lib/game-state"

interface Env {
  DURABLE_STREAMS_URL: string
}

/**
 * Error codes returned by the draw endpoint.
 */
export type DrawErrorCode =
  | `WARMING_UP`
  | `INVALID_REQUEST`
  | `INVALID_EDGE`
  | `INVALID_TEAM`
  | `GAME_COMPLETE`
  | `EDGE_TAKEN`
  | `STREAM_ERROR`

export interface DrawResponse {
  ok: boolean
  code?: DrawErrorCode
}

/**
 * GameWriterDO is a Cloudflare Durable Object that manages the authoritative
 * game state and handles edge placement requests.
 *
 * It maintains an in-memory GameState that is lazily initialized by replaying
 * the event stream from the Durable Streams server.
 */
export class GameWriterDO {
  // Durable Object context - stored for future use (alarms, storage, etc.)
  // @ts-expect-error - ctx will be used in future enhancements
  private ctx: DurableObjectState
  private env: Env

  // In-memory game state
  private gameState: GameState | null = null
  private ready = false
  private initPromise: Promise<void> | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
  }

  /**
   * Lazy initialization - ensures the DO is ready before handling requests.
   */
  private async ensureReady(): Promise<void> {
    if (this.ready) return

    if (!this.initPromise) {
      this.initPromise = this.initialize()
    }

    await this.initPromise
  }

  /**
   * Initialize the game state by replaying events from the Durable Streams server.
   */
  private async initialize(): Promise<void> {
    this.gameState = new GameState()

    try {
      // Fetch entire stream from Durable Streams server
      const streamUrl = `${this.env.DURABLE_STREAMS_URL}${GAME_STREAM_PATH}`
      const response = await fetch(streamUrl)

      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer())
        const events = parseStreamRecords(bytes)

        for (const event of events) {
          this.gameState.applyEvent(event)
        }

        console.log(
          `GameWriterDO initialized: ${this.gameState.getEdgesPlacedCount()} edges`
        )
      } else if (response.status === 404) {
        // Stream doesn't exist yet - create it with PUT
        console.log(`Creating game stream...`)
        const createResponse = await fetch(streamUrl, {
          method: `PUT`,
          headers: { "Content-Type": `application/octet-stream` },
        })
        if (createResponse.ok) {
          console.log(`GameWriterDO initialized: new stream created`)
        } else {
          console.error(`Failed to create stream: ${createResponse.status}`)
        }
      } else {
        console.error(`Failed to fetch stream: ${response.status}`)
      }
    } catch (err) {
      console.error(`Failed to fetch stream during init:`, err)
      // Continue with empty state - stream might not exist yet
    }

    this.ready = true
  }

  /**
   * Fetch handler - routes requests to appropriate handlers.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // Health check / initialization endpoint
    if (url.pathname === `/init` && request.method === `POST`) {
      return this.handleInit()
    }

    if (url.pathname === `/draw` && request.method === `POST`) {
      return this.handleDraw(request)
    }

    return new Response(`Not found`, { status: 404 })
  }

  /**
   * Handle init request - ensures the stream exists.
   * Called on page load to create the stream if needed.
   */
  private async handleInit(): Promise<Response> {
    try {
      await this.ensureReady()
      return Response.json({
        ok: true,
        edgesPlaced: this.gameState?.getEdgesPlacedCount() ?? 0,
      })
    } catch {
      return Response.json({ ok: false, code: `INIT_FAILED` }, { status: 500 })
    }
  }

  /**
   * Handle a draw request - validate and append edge placement to stream.
   */
  private async handleDraw(request: Request): Promise<Response> {
    // Ensure we're initialized
    if (!this.ready) {
      try {
        await this.ensureReady()
      } catch {
        return Response.json(
          { ok: false, code: `WARMING_UP` } satisfies DrawResponse,
          { status: 503 }
        )
      }
    }

    // Parse request body
    let body: { edgeId: number; teamId: number }
    try {
      body = await request.json()
    } catch {
      return Response.json(
        { ok: false, code: `INVALID_REQUEST` } satisfies DrawResponse,
        { status: 400 }
      )
    }

    const { edgeId, teamId } = body

    // Validate edge ID
    if (!isValidEdgeId(edgeId)) {
      return Response.json(
        { ok: false, code: `INVALID_EDGE` } satisfies DrawResponse,
        { status: 400 }
      )
    }

    // Validate team ID
    if (typeof teamId !== `number` || teamId < 0 || teamId > 3) {
      return Response.json(
        { ok: false, code: `INVALID_TEAM` } satisfies DrawResponse,
        { status: 400 }
      )
    }

    // Check if game is complete
    if (this.gameState!.isComplete()) {
      return Response.json(
        { ok: false, code: `GAME_COMPLETE` } satisfies DrawResponse,
        { status: 410 }
      )
    }

    // Check if edge is already taken
    if (this.gameState!.isEdgeTaken(edgeId)) {
      return Response.json(
        { ok: false, code: `EDGE_TAKEN` } satisfies DrawResponse,
        { status: 409 }
      )
    }

    // Append to Durable Stream
    const event: GameEvent = { edgeId, teamId }
    const encoded = encodeEvent(event)

    try {
      // Convert Uint8Array to ArrayBuffer for Cloudflare Workers fetch compatibility
      const requestBody = encoded.buffer.slice(
        encoded.byteOffset,
        encoded.byteOffset + encoded.byteLength
      ) as ArrayBuffer

      // POST to the stream URL to append (per Durable Streams protocol)
      const appendResponse = await fetch(
        `${this.env.DURABLE_STREAMS_URL}${GAME_STREAM_PATH}`,
        {
          method: `POST`,
          headers: { "Content-Type": `application/octet-stream` },
          body: requestBody,
        }
      )

      if (!appendResponse.ok) {
        throw new Error(`Append failed: ${appendResponse.status}`)
      }
    } catch (err) {
      console.error(`Failed to append to stream:`, err)
      return Response.json(
        { ok: false, code: `STREAM_ERROR` } satisfies DrawResponse,
        { status: 500 }
      )
    }

    // Update local state
    this.gameState!.applyEvent(event)

    return Response.json({ ok: true } satisfies DrawResponse)
  }
}
