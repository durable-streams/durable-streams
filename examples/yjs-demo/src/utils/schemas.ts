import { createStateSchema } from "@durable-streams/state"

// ============================================================================
// Room Metadata Schema
// ============================================================================

export interface RoomMetadata {
  roomId: string
  name: string
  createdAt: number
}

const roomMetadataSchema = {
  "~standard": {
    version: 1 as const,
    vendor: `durable-streams`,
    validate: (value: unknown) => {
      const data = value as Record<string, unknown>

      if (typeof data.roomId !== `string` || data.roomId.length === 0) {
        return {
          issues: [{ message: `roomId must be a non-empty string` }],
        }
      }

      if (typeof data.name !== `string` || data.name.length === 0) {
        return {
          issues: [{ message: `name must be a non-empty string` }],
        }
      }

      if (typeof data.createdAt !== `number`) {
        return {
          issues: [{ message: `createdAt must be a number` }],
        }
      }

      return { value: data as unknown as RoomMetadata }
    },
  },
}

// ============================================================================
// State Schema
// ============================================================================

export const registryStateSchema = createStateSchema({
  rooms: {
    schema: roomMetadataSchema,
    type: `stream`,
    primaryKey: `roomId`,
  },
})
