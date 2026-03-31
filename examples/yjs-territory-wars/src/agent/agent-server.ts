import { DurableStream } from "@durable-streams/client"
import { createStreamDB } from "@durable-streams/state"
import { REGISTRY_TTL_SECONDS, registryStateSchema } from "../utils/schemas"
import { BOT_NAMES } from "../utils/game-logic"
import { AIPlayer } from "./ai-player"
import { HaikuClient } from "./haiku-client"
import type { RoomMetadata } from "../utils/schemas"

const POLL_INTERVAL = 5_000
const NUM_BOTS = 3

interface RoomEntry {
  roomId: string
  players: Array<AIPlayer>
}

export class AgentServer {
  /** Currently active rooms with live bot players */
  private activeRooms = new Map<string, RoomEntry>()

  /** All room IDs we have ever seen — never join these again */
  private knownRoomIds = new Set<string>()

  private haikuClient: HaikuClient
  private yjsBaseUrl: string
  private yjsHeaders: Record<string, string>
  private dsUrl: string
  private dsHeaders: Record<string, string>
  private pollTimer: ReturnType<typeof setInterval> | null = null
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

    // Mark all existing rooms as known so we don't join old rooms on startup
    const allRooms = this.db.collections.rooms
      .toArray as unknown as Array<RoomMetadata>
    for (const room of allRooms) {
      this.knownRoomIds.add(room.roomId)
      console.log(`[AgentServer] Skipping existing room: ${room.roomId}`)
    }

    // Delete any already-expired rooms from the registry
    this.deleteExpiredRooms()

    console.log(
      `[AgentServer] Registry loaded (${this.knownRoomIds.size} existing rooms skipped), watching for new rooms...`
    )

    // Poll for room changes
    this.pollTimer = setInterval(() => {
      this.syncRooms()
    }, POLL_INTERVAL)
  }

  private getAllRooms(): Array<RoomMetadata> {
    if (!this.db) return []
    return this.db.collections.rooms.toArray as unknown as Array<RoomMetadata>
  }

  private syncRooms(): void {
    const now = Date.now()
    const allRooms = this.getAllRooms()

    // Spawn bots for genuinely new rooms (never seen before, not expired)
    for (const room of allRooms) {
      if (!this.knownRoomIds.has(room.roomId) && room.expiresAt > now) {
        this.knownRoomIds.add(room.roomId)
        this.spawnBotsForRoom(room.roomId)
      }
    }

    // Destroy bots for rooms that have expired
    for (const [roomId] of this.activeRooms) {
      const room = allRooms.find((r) => r.roomId === roomId)
      if (!room || room.expiresAt <= now) {
        this.destroyBotsForRoom(roomId)
      }
    }

    // Clean up expired rooms from registry
    this.deleteExpiredRooms()
  }

  private deleteExpiredRooms(): void {
    if (!this.db) return

    const now = Date.now()
    const allRooms = this.getAllRooms()

    for (const room of allRooms) {
      if (room.expiresAt <= now) {
        console.log(
          `[AgentServer] Deleting expired room from registry: ${room.roomId}`
        )
        void this.db.actions.deleteRoom(room.roomId)
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

    this.activeRooms.set(roomId, { roomId, players })
  }

  private destroyBotsForRoom(roomId: string): void {
    const entry = this.activeRooms.get(roomId)
    if (!entry) return

    console.log(`[AgentServer] Destroying bots for room: ${roomId}`)
    for (const player of entry.players) {
      player.destroy()
    }
    this.activeRooms.delete(roomId)
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)

    for (const [roomId] of this.activeRooms) {
      this.destroyBotsForRoom(roomId)
    }

    if (this.db) {
      this.db.close()
    }

    console.log(`[AgentServer] Stopped`)
  }
}
