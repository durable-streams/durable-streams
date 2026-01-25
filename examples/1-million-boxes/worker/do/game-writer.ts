import { DurableObject } from "cloudflare:workers"
import { GameState } from "../../shared/game-state"
import { encodeEvent, parseStreamRecords } from "../../shared/stream-parser"
import { isValidEdgeId } from "../../shared/edge-math"
import {
  GAME_STREAM_PATH,
  MAX_QUOTA,
  QUOTA_GC_INACTIVE_MS,
  QUOTA_REFILL_INTERVAL_MS,
} from "../lib/config"
import type { GameEvent } from "../../shared/game-state"

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
  | `INVALID_PLAYER`
  | `GAME_COMPLETE`
  | `EDGE_TAKEN`
  | `STREAM_ERROR`
  | `QUOTA_EXHAUSTED`

export interface DrawResponse {
  ok: boolean
  code?: DrawErrorCode
  /** Number of boxes claimed by this edge placement (0, 1, or 2) */
  boxesClaimed?: number
  /** Remaining quota tokens after this draw */
  quotaRemaining?: number
  /** Seconds until next quota refill (if quota is not full) */
  refillIn?: number
}

/**
 * GameWriterDO is a Cloudflare Durable Object that manages the authoritative
 * game state and handles edge placement requests.
 *
 * It maintains an in-memory GameState that is lazily initialized by replaying
 * the event stream from the Durable Streams server.
 *
 * Player quota is tracked in SQLite for server-side enforcement.
 */
export class GameWriterDO extends DurableObject<Env> {
  // SQL storage interface
  private sql: SqlStorage

  // In-memory game state
  private gameState: GameState | null = null
  private ready = false
  private initPromise: Promise<void> | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql

    // Initialize quota table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS player_quota (
        player_id TEXT PRIMARY KEY,
        tokens INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_last_active ON player_quota(last_active_at);
    `)
  }

  /**
   * Lazy initialization - ensures the DO is ready before handling requests.
   */
  private async ensureReady(): Promise<void> {
    if (this.ready) return

    if (!this.initPromise) {
      this.initPromise = this.initialize()
    }

    try {
      await this.initPromise
    } catch (err) {
      this.initPromise = null
      throw err
    }
  }

  /**
   * Initialize the game state by replaying events from the Durable Streams server.
   */
  private async initialize(): Promise<void> {
    this.gameState = new GameState()

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
        throw new Error(`Failed to create stream: ${createResponse.status}`)
      }
    } else {
      throw new Error(`Failed to fetch stream: ${response.status}`)
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

    // Get quota for a player (for UI display)
    if (url.pathname === `/quota` && request.method === `POST`) {
      return this.handleGetQuota(request)
    }

    return new Response(`Not found`, { status: 404 })
  }

  /**
   * Alarm handler - runs periodically to garbage collect inactive players.
   */
  async alarm(): Promise<void> {
    const cutoff = Date.now() - QUOTA_GC_INACTIVE_MS
    const result = this.sql.exec(
      `DELETE FROM player_quota WHERE last_active_at < ?`,
      cutoff
    )
    console.log(
      `GC: removed ${result.rowsWritten} inactive player quota records`
    )

    // Schedule next GC alarm (every 5 minutes)
    await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000)
  }

  /**
   * Get or create quota state for a player.
   * Returns current tokens after applying time-based refill.
   */
  private getPlayerQuota(
    playerId: string,
    allowPrune: boolean = false
  ): {
    tokens: number
    lastActiveAt: number
  } {
    const now = Date.now()

    const row = this.sql
      .exec(
        `SELECT tokens, last_active_at FROM player_quota WHERE player_id = ?`,
        playerId
      )
      .toArray()[0] as { tokens: number; last_active_at: number } | undefined

    if (!row) {
      // New player starts with full quota
      return { tokens: MAX_QUOTA, lastActiveAt: now }
    }

    // Calculate refilled tokens based on elapsed time
    const elapsed = now - row.last_active_at
    const refills = Math.floor(elapsed / QUOTA_REFILL_INTERVAL_MS)
    const baseTokens = Math.floor(row.tokens)
    const refilledTokens = Math.min(MAX_QUOTA, baseTokens + refills)

    if (allowPrune && refilledTokens >= MAX_QUOTA) {
      this.sql.exec(`DELETE FROM player_quota WHERE player_id = ?`, playerId)
      return { tokens: MAX_QUOTA, lastActiveAt: now }
    }

    return { tokens: refilledTokens, lastActiveAt: row.last_active_at }
  }

  /**
   * Consume a quota token for a player.
   * Returns the new token count, or null if no tokens available.
   */
  private consumeQuota(playerId: string): number | null {
    const now = Date.now()
    const quota = this.getPlayerQuota(playerId)

    if (quota.tokens < 1) {
      return null
    }

    const newTokens = quota.tokens - 1

    // Upsert the new quota state
    this.sql.exec(
      `INSERT INTO player_quota (player_id, tokens, last_active_at)
       VALUES (?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET tokens = ?, last_active_at = ?`,
      playerId,
      newTokens,
      now,
      newTokens,
      now
    )

    return newTokens
  }

  /**
   * Grant quota tokens to a player (for box completion refunds).
   * Returns the new token count.
   *
   * NOTE: This does NOT update last_active_at, so refunds don't reset the
   * refill timer. Only consumeQuota() updates last_active_at.
   */
  private grantQuota(playerId: string, amount: number): number {
    const quota = this.getPlayerQuota(playerId)
    const newTokens = Math.min(MAX_QUOTA, quota.tokens + amount)

    if (newTokens >= MAX_QUOTA) {
      this.sql.exec(`DELETE FROM player_quota WHERE player_id = ?`, playerId)
      return MAX_QUOTA
    }

    // Only update tokens, preserve last_active_at for refill timing
    this.sql.exec(
      `INSERT INTO player_quota (player_id, tokens, last_active_at)
       VALUES (?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET tokens = ?`,
      playerId,
      newTokens,
      quota.lastActiveAt,
      newTokens
    )

    return newTokens
  }

  /**
   * Calculate seconds until next quota refill.
   * Returns a value in range [0, QUOTA_REFILL_INTERVAL_MS/1000].
   */
  private getRefillIn(playerId: string): number {
    const now = Date.now()
    const row = this.sql
      .exec(
        `SELECT last_active_at FROM player_quota WHERE player_id = ?`,
        playerId
      )
      .toArray()[0] as { last_active_at: number } | undefined

    if (!row) return 0

    const elapsed = now - row.last_active_at
    const timeSinceLastRefill = elapsed % QUOTA_REFILL_INTERVAL_MS
    const timeUntilNext = QUOTA_REFILL_INTERVAL_MS - timeSinceLastRefill

    // Use floor to ensure value is <= interval (prevents client sync issues)
    return Math.floor(timeUntilNext / 1000)
  }

  /**
   * Handle get quota request - returns current quota state for a player.
   */
  private async handleGetQuota(request: Request): Promise<Response> {
    let body: { playerId: string }
    try {
      body = await request.json()
    } catch {
      return Response.json(
        { ok: false, code: `INVALID_REQUEST` },
        { status: 400 }
      )
    }

    const { playerId } = body
    if (!playerId || typeof playerId !== `string`) {
      return Response.json(
        { ok: false, code: `INVALID_PLAYER` },
        { status: 400 }
      )
    }

    const quota = this.getPlayerQuota(playerId, true)
    const refillIn = quota.tokens < MAX_QUOTA ? this.getRefillIn(playerId) : 0

    return Response.json({
      ok: true,
      quotaRemaining: Math.floor(quota.tokens),
      quotaMax: MAX_QUOTA,
      refillIn,
    })
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
    } catch (err) {
      console.error(`Init failed:`, err)
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
    let body: { edgeId: number; teamId: number; playerId: string }
    try {
      body = await request.json()
    } catch {
      return Response.json(
        { ok: false, code: `INVALID_REQUEST` } satisfies DrawResponse,
        { status: 400 }
      )
    }

    const { edgeId, teamId, playerId } = body

    // Validate player ID
    if (!playerId || typeof playerId !== `string`) {
      return Response.json(
        { ok: false, code: `INVALID_PLAYER` } satisfies DrawResponse,
        { status: 400 }
      )
    }

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

    // Check and consume quota
    const tokensAfterConsume = this.consumeQuota(playerId)
    if (tokensAfterConsume === null) {
      const quota = this.getPlayerQuota(playerId)
      return Response.json(
        {
          ok: false,
          code: `QUOTA_EXHAUSTED`,
          quotaRemaining: Math.floor(quota.tokens),
          refillIn: this.getRefillIn(playerId),
        } satisfies DrawResponse,
        { status: 429 }
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
      // Refund the consumed quota since the stream write failed
      this.grantQuota(playerId, 1)
      return Response.json(
        { ok: false, code: `STREAM_ERROR` } satisfies DrawResponse,
        { status: 500 }
      )
    }

    // Update local game state and check for box completions
    const { boxesClaimed } = this.gameState!.applyEvent(event)

    // Grant refund for completed boxes
    let finalQuota = tokensAfterConsume
    if (boxesClaimed.length > 0) {
      finalQuota = this.grantQuota(playerId, boxesClaimed.length)
    }

    // Ensure GC alarm is scheduled
    const alarm = await this.ctx.storage.getAlarm()
    if (!alarm) {
      await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000)
    }

    return Response.json({
      ok: true,
      boxesClaimed: boxesClaimed.length,
      quotaRemaining: Math.floor(finalQuota),
      refillIn: finalQuota < MAX_QUOTA ? this.getRefillIn(playerId) : 0,
    } satisfies DrawResponse)
  }
}
