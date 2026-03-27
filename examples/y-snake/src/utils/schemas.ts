import { createStateSchema } from "@durable-streams/state"

// ============================================================================
// Room Registry
// ============================================================================

export interface RoomMetadata {
  roomId: string
  name: string
  boardSize: string
  createdAt: number
  expiresAt: number
  playerCount?: number
}

export const ROOM_TTL_SECONDS = 600 // 10 minutes
export const ROOM_TTL_RENEWAL_MS = (ROOM_TTL_SECONDS / 2) * 1000 // renew every 5 min
export const REGISTRY_TTL_SECONDS = 60 * 60 * 24 // 1 day

const roomMetadataSchema = {
  "~standard": {
    version: 1 as const,
    vendor: `durable-streams`,
    validate: (value: unknown) => {
      const data = value as Record<string, unknown>

      if (typeof data.roomId !== `string` || data.roomId.length === 0) {
        return { issues: [{ message: `roomId must be a non-empty string` }] }
      }
      if (typeof data.name !== `string` || data.name.length === 0) {
        return { issues: [{ message: `name must be a non-empty string` }] }
      }
      if (typeof data.boardSize !== `string`) {
        return { issues: [{ message: `boardSize must be a string` }] }
      }
      if (typeof data.createdAt !== `number`) {
        return { issues: [{ message: `createdAt must be a number` }] }
      }
      if (typeof data.expiresAt !== `number`) {
        return { issues: [{ message: `expiresAt must be a number` }] }
      }
      if (
        data.playerCount !== undefined &&
        typeof data.playerCount !== `number`
      ) {
        return { issues: [{ message: `playerCount must be a number` }] }
      }

      return { value: data as unknown as RoomMetadata }
    },
  },
}

export const registryStateSchema = createStateSchema({
  rooms: {
    schema: roomMetadataSchema,
    type: `stream`,
    primaryKey: `roomId`,
  },
})

// ============================================================================
// Room High Scores
// ============================================================================

export interface ScoreEntry {
  playerName: string
  score: number
  timestamp: number
}

const scoreEntrySchema = {
  "~standard": {
    version: 1 as const,
    vendor: `durable-streams`,
    validate: (value: unknown) => {
      const data = value as Record<string, unknown>

      if (typeof data.playerName !== `string` || data.playerName.length === 0) {
        return {
          issues: [{ message: `playerName must be a non-empty string` }],
        }
      }
      if (typeof data.score !== `number`) {
        return { issues: [{ message: `score must be a number` }] }
      }
      if (typeof data.timestamp !== `number`) {
        return { issues: [{ message: `timestamp must be a number` }] }
      }

      return { value: data as unknown as ScoreEntry }
    },
  },
}

export const scoresStateSchema = createStateSchema({
  scores: {
    schema: scoreEntrySchema,
    type: `stream`,
    primaryKey: `playerName`,
  },
})
