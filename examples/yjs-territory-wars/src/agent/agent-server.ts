import { DurableStream } from "@durable-streams/client"
import { createStreamDB } from "@durable-streams/state"
import { REGISTRY_TTL_SECONDS, registryStateSchema } from "../utils/schemas"
import { BOT_NAMES } from "../utils/game-logic"
import { AIPlayer } from "./ai-player"
import { HaikuClient } from "./haiku-client"
import type { RoomMetadata } from "../utils/schemas"

const POLL_INTERVAL = 5_000
const EXPIRY_CHECK_INTERVAL = 30_000
const NUM_BOTS = 3

interface RoomEntry {
  roomId: string
  players: Array<AIPlayer>
}

export class AgentServer {
  private rooms = new Map<string, RoomEntry>()
  private haikuClient: HaikuClient
  private yjsBaseUrl: string
  private yjsHeaders: Record<string, string>
  private dsUrl: string
  private dsHeaders: Record<string, string>
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private expiryTimer: ReturnType<typeof setInterval> | null = null
  private db: Awaited<ReturnType<typeof createStreamDB>> | null = null

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

    // Create StreamDB and preload
    this.db = await createStreamDB({
      streamOptions: {
        url: registryUrl,
        headers: this.dsHeaders,
        contentType: `application/json`,
      },
      state: registryStateSchema,
      actions: ({ db, stream }) => ({
        addRoom: {
          onMutate: (metadata: RoomMetadata) => {
            db.collections.rooms.insert(metadata)
          },
          mutationFn: async (metadata: RoomMetadata) => {
            const txid = crypto.randomUUID()
            await stream.append(
              JSON.stringify(
                registryStateSchema.rooms.insert({
                  value: metadata,
                  headers: { txid },
                })
              )
            )
            await db.utils.awaitTxId(txid)
          },
        },
        deleteRoom: {
          onMutate: (roomId: string) => {
            db.collections.rooms.delete(roomId)
          },
          mutationFn: async (roomId: string) => {
            const txid = crypto.randomUUID()
            await stream.append(
              JSON.stringify(
                registryStateSchema.rooms.delete({
                  key: roomId,
                  headers: { txid },
                })
              )
            )
            await db.utils.awaitTxId(txid)
          },
        },
      }),
    })
    await this.db.preload()

    console.log(`[AgentServer] Registry loaded, watching for rooms...`)

    // Initial sync
    this.syncRooms()

    // Poll for room changes
    this.pollTimer = setInterval(() => {
      this.syncRooms()
    }, POLL_INTERVAL)

    // Periodically check for expired rooms
    this.expiryTimer = setInterval(() => {
      this.syncRooms()
    }, EXPIRY_CHECK_INTERVAL)
  }

  private getActiveRooms(): Array<RoomMetadata> {
    if (!this.db) return []

    const now = Date.now()
    const allRooms = this.db.collections.rooms
      .toArray as unknown as Array<RoomMetadata>
    return allRooms.filter((r) => r.expiresAt > now)
  }

  private syncRooms(): void {
    const activeRooms = this.getActiveRooms()

    // Spawn bots for new rooms
    for (const room of activeRooms) {
      if (!this.rooms.has(room.roomId)) {
        this.spawnBotsForRoom(room.roomId)
      }
    }

    // Clean up rooms that no longer exist
    const activeRoomIds = new Set(activeRooms.map((r) => r.roomId))
    for (const [roomId] of this.rooms) {
      if (!activeRoomIds.has(roomId)) {
        this.destroyBotsForRoom(roomId)
      }
    }
  }

  private spawnBotsForRoom(roomId: string): void {
    console.log(`[AgentServer] Spawning ${NUM_BOTS} bots for room: ${roomId}`)

    const players: Array<AIPlayer> = []
    for (let i = 0; i < NUM_BOTS; i++) {
      const name = BOT_NAMES[i]
      const player = new AIPlayer(
        name,
        roomId,
        this.yjsBaseUrl,
        this.yjsHeaders,
        this.haikuClient
      )
      players.push(player)
    }

    this.rooms.set(roomId, { roomId, players })
  }

  private destroyBotsForRoom(roomId: string): void {
    const entry = this.rooms.get(roomId)
    if (!entry) return

    console.log(`[AgentServer] Destroying bots for room: ${roomId}`)
    for (const player of entry.players) {
      player.destroy()
    }
    this.rooms.delete(roomId)
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.expiryTimer) clearInterval(this.expiryTimer)

    for (const [roomId] of this.rooms) {
      this.destroyBotsForRoom(roomId)
    }

    if (this.db) {
      this.db.close()
    }

    console.log(`[AgentServer] Stopped`)
  }
}
