import { DurableStream } from "@durable-streams/client"
import { REGISTRY_TTL_SECONDS } from "../utils/schemas"
import { BOT_NAMES, PLAYER_COLORS } from "../utils/game-logic"
import { AIPlayer } from "./ai-player"
import { HaikuClient } from "./haiku-client"
import type { AgentPersonality } from "./haiku-client"
import type { RoomMetadata } from "../utils/schemas"

const NUM_BOTS = 4
const BOT_PERSONALITIES: Array<AgentPersonality> = [
  `destroyer`,
  `explorer`,
  `greedy`,
  `balanced`,
]

interface RoomEntry {
  roomId: string
  players: Array<AIPlayer>
}

interface StreamEvent {
  type: string
  key: string
  value?: RoomMetadata
  headers: Record<string, string>
}

export class AgentServer {
  /** Currently active rooms with live bot players */
  private activeRooms = new Map<string, RoomEntry>()

  /** Materialized room state from the stream */
  private rooms = new Map<string, RoomMetadata>()

  /** All room IDs known at startup — never join these */
  private startupRoomIds = new Set<string>()

  /** Whether initial stream load is done */
  private initialized = false

  private haikuClient: HaikuClient
  private yjsBaseUrl: string
  private yjsHeaders: Record<string, string>
  private dsUrl: string
  private dsHeaders: Record<string, string>
  private abortController: AbortController | null = null
  private expiryTimer: ReturnType<typeof setInterval> | null = null

  constructor(config: {
    yjsBaseUrl: string
    yjsHeaders: Record<string, string>
    dsUrl: string
    dsHeaders: Record<string, string>
    anthropicApiKey: string
  }) {
    this.yjsBaseUrl = config.yjsBaseUrl
    this.yjsHeaders = config.yjsHeaders
    this.dsUrl = config.dsUrl
    this.dsHeaders = config.dsHeaders
    this.haikuClient = new HaikuClient(config.anthropicApiKey)
  }

  async start(): Promise<void> {
    console.log(`[AgentServer] Starting...`)

    const registryUrl = `${this.dsUrl}/__snake_rooms`

    // Ensure the registry stream exists
    const registryStream = new DurableStream({
      url: registryUrl,
      headers: this.dsHeaders,
      contentType: `application/json`,
    })
    const headResult = await registryStream.head()
    if (!headResult.exists) {
      await DurableStream.create({
        url: registryUrl,
        headers: this.dsHeaders,
        contentType: `application/json`,
        ttlSeconds: REGISTRY_TTL_SECONDS,
      })
    }

    // Subscribe to raw stream — no TanStack DB needed
    this.abortController = new AbortController()
    const streamResponse = await registryStream.stream<StreamEvent>({
      live: true,
      signal: this.abortController.signal,
    })

    // Process stream events
    streamResponse.subscribeJson((batch) => {
      for (const event of batch.items) {
        this.handleStreamEvent(event)
      }

      // After first up-to-date, mark initialized
      if (batch.upToDate && !this.initialized) {
        this.initialized = true
        // All rooms seen so far are pre-existing
        for (const roomId of this.rooms.keys()) {
          this.startupRoomIds.add(roomId)
        }
        console.log(
          `[AgentServer] Ready. ${this.startupRoomIds.size} existing rooms skipped. Watching for new rooms...`
        )
      }

      return Promise.resolve()
    })

    // Wait for initial sync
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this.initialized) {
          clearInterval(check)
          resolve()
        }
      }, 100)
    })

    // Periodic expiry cleanup
    this.expiryTimer = setInterval(() => {
      this.cleanupExpiredRooms()
    }, 30_000)
  }

  private handleStreamEvent(event: StreamEvent): void {
    // The rooms collection uses type="stream" per the schema definition
    if (event.type !== `stream`) return

    const operation = event.headers.operation
    const roomId = event.key

    if (
      operation === `insert` ||
      operation === `upsert` ||
      operation === `update`
    ) {
      const room = event.value
      if (!room) return

      // Ensure roomId is set
      const metadata: RoomMetadata = { ...room, roomId }

      const isNew = !this.rooms.has(roomId)
      this.rooms.set(roomId, metadata)

      if (isNew && this.initialized && !this.startupRoomIds.has(roomId)) {
        const now = Date.now()
        if (metadata.expiresAt > now) {
          console.log(`[AgentServer] New room detected: ${roomId}`)
          this.spawnBotsForRoom(roomId)
        } else if (metadata.expiresAt <= now) {
          console.log(`[AgentServer] New room already expired: ${roomId}`)
        }
      }
    } else if (operation === `delete`) {
      this.rooms.delete(roomId)
      if (this.activeRooms.has(roomId)) {
        console.log(`[AgentServer] Room deleted: ${roomId}`)
        this.destroyBotsForRoom(roomId)
      }
    }
  }

  private cleanupExpiredRooms(): void {
    const now = Date.now()
    for (const [roomId, room] of this.rooms) {
      if (room.expiresAt <= now && this.activeRooms.has(roomId)) {
        console.log(`[AgentServer] Room expired: ${roomId}`)
        this.destroyBotsForRoom(roomId)
      }
    }
  }

  private spawnBotsForRoom(roomId: string): void {
    if (this.activeRooms.has(roomId)) {
      console.log(`[AgentServer] Bots already active for ${roomId}, skipping`)
      return
    }

    console.log(`[AgentServer] Spawning ${NUM_BOTS} bot(s) for: ${roomId}`)

    const players: Array<AIPlayer> = []
    for (let i = 0; i < NUM_BOTS; i++) {
      const name = BOT_NAMES[i]
      const color = PLAYER_COLORS[PLAYER_COLORS.length - 1 - i]
      const personality = BOT_PERSONALITIES[i % BOT_PERSONALITIES.length]
      const player = new AIPlayer(
        name,
        roomId,
        this.yjsBaseUrl,
        this.yjsHeaders,
        this.haikuClient,
        color,
        personality,
        i
      )
      players.push(player)
    }

    this.activeRooms.set(roomId, { roomId, players })
  }

  private destroyBotsForRoom(roomId: string): void {
    const entry = this.activeRooms.get(roomId)
    if (!entry) return

    console.log(`[AgentServer] Destroying bots for: ${roomId}`)
    for (const player of entry.players) {
      player.destroy()
    }
    this.activeRooms.delete(roomId)
  }

  stop(): void {
    if (this.expiryTimer) clearInterval(this.expiryTimer)
    if (this.abortController) this.abortController.abort()

    for (const [roomId] of this.activeRooms) {
      this.destroyBotsForRoom(roomId)
    }

    console.log(`[AgentServer] Stopped`)
  }
}
