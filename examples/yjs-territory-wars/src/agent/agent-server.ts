import { DurableStream } from "@durable-streams/client"
import { createStreamDB } from "@durable-streams/state"
import { REGISTRY_TTL_SECONDS, registryStateSchema } from "../utils/schemas"
import { BOT_NAMES } from "../utils/game-logic"
import { AIPlayer } from "./ai-player"
import { HaikuClient } from "./haiku-client"
import type { RoomMetadata } from "../utils/schemas"

const NUM_BOTS = 3
const EXPIRY_CHECK_INTERVAL = 30_000

interface RoomEntry {
  roomId: string
  players: Array<AIPlayer>
}

export class AgentServer {
  /** Currently active rooms with live bot players */
  private activeRooms = new Map<string, RoomEntry>()

  /** All room IDs we have ever seen — never join these again */
  private knownRoomIds = new Set<string>()

  /** Whether initial state has been received (skip those rooms) */
  private initialized = false

  private haikuClient: HaikuClient
  private yjsBaseUrl: string
  private yjsHeaders: Record<string, string>
  private dsUrl: string
  private dsHeaders: Record<string, string>
  private expiryTimer: ReturnType<typeof setInterval> | null = null
  private db: Awaited<ReturnType<typeof createStreamDB>> | null = null
  private unsubscribe: (() => void) | null = null

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

    // Create StreamDB and preload to materialize state
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

    // Subscribe to room changes via live materialized view
    const subscription = this.db.collections.rooms.subscribeChanges(
      (changes) => {
        for (const change of changes) {
          const room = change.value as unknown as RoomMetadata | undefined
          if (change.type === `insert` && room) {
            this.onRoomInserted(room)
          } else if (change.type === `delete`) {
            const roomId = change.key as string
            this.onRoomDeleted(roomId)
          }
        }
      },
      { includeInitialState: true }
    )
    this.unsubscribe = () => subscription.unsubscribe()

    // Mark initial state as loaded — all rooms seen during initial state
    // are pre-existing and should not be joined
    this.initialized = true

    console.log(
      `[AgentServer] Registry materialized (${this.knownRoomIds.size} existing rooms skipped), watching for new rooms...`
    )

    // Periodically check for expired rooms and clean them up
    this.expiryTimer = setInterval(() => {
      this.cleanupExpiredRooms()
    }, EXPIRY_CHECK_INTERVAL)
  }

  private onRoomInserted(room: RoomMetadata): void {
    const now = Date.now()

    if (this.knownRoomIds.has(room.roomId)) {
      // Already seen (could be a TTL renewal update) — skip
      return
    }

    this.knownRoomIds.add(room.roomId)

    if (!this.initialized) {
      // Initial state from preload — don't join old rooms
      console.log(`[AgentServer] Skipping pre-existing room: ${room.roomId}`)
      return
    }

    if (room.expiresAt <= now) {
      console.log(`[AgentServer] Skipping expired room: ${room.roomId}`)
      return
    }

    this.spawnBotsForRoom(room.roomId)
  }

  private onRoomDeleted(roomId: string): void {
    this.destroyBotsForRoom(roomId)
  }

  private cleanupExpiredRooms(): void {
    if (!this.db) return
    const now = Date.now()

    // Destroy bots for expired rooms
    for (const [roomId] of this.activeRooms) {
      const allRooms = this.db.collections.rooms
        .toArray as unknown as Array<RoomMetadata>
      const room = allRooms.find((r) => r.roomId === roomId)
      if (!room || room.expiresAt <= now) {
        this.destroyBotsForRoom(roomId)
        // Delete from registry so it doesn't persist
        if (room) {
          console.log(
            `[AgentServer] Deleting expired room from registry: ${roomId}`
          )
          void this.db.actions.deleteRoom(roomId)
        }
      }
    }
  }

  private spawnBotsForRoom(roomId: string): void {
    if (this.activeRooms.has(roomId)) {
      console.log(
        `[AgentServer] Bots already active for room ${roomId}, skipping`
      )
      return
    }

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
    if (this.expiryTimer) clearInterval(this.expiryTimer)
    if (this.unsubscribe) this.unsubscribe()

    for (const [roomId] of this.activeRooms) {
      this.destroyBotsForRoom(roomId)
    }

    if (this.db) {
      this.db.close()
    }

    console.log(`[AgentServer] Stopped`)
  }
}
