import { createStateSchema } from "@durable-streams/state"

// ============================================================================
// Stream Metadata Schema
// ============================================================================

export interface StreamMetadata {
  path: string
  contentType: string
  createdAt: number
}

const streamMetadataSchema = {
  "~standard": {
    version: 1 as const,
    vendor: `durable-streams`,
    validate: (value: unknown) => {
      const data = value as any

      if (typeof data.path !== `string` || data.path.length === 0) {
        return {
          issues: [{ message: `path must be a non-empty string` }],
        }
      }

      if (
        typeof data.contentType !== `string` ||
        data.contentType.length === 0
      ) {
        return {
          issues: [{ message: `contentType must be a non-empty string` }],
        }
      }

      if (typeof data.createdAt !== `number`) {
        return {
          issues: [{ message: `createdAt must be a number` }],
        }
      }

      return { value: data as StreamMetadata }
    },
  },
}

// ============================================================================
// Presence Data Schema
// ============================================================================

export interface PresenceData {
  userId: string
  route: string
  streamPath?: string
  isTyping: boolean
  lastSeen: number
  color: string
  sessionId: string
}

const presenceSchema = {
  "~standard": {
    version: 1 as const,
    vendor: `durable-streams`,
    validate: (value: unknown) => {
      const data = value as any

      if (typeof data.userId !== `string` || data.userId.length === 0) {
        return {
          issues: [{ message: `userId must be a non-empty string` }],
        }
      }

      if (typeof data.route !== `string` || data.route.length === 0) {
        return {
          issues: [{ message: `route must be a non-empty string` }],
        }
      }

      if (
        data.streamPath !== undefined &&
        typeof data.streamPath !== `string`
      ) {
        return {
          issues: [{ message: `streamPath must be a string if provided` }],
        }
      }

      if (typeof data.isTyping !== `boolean`) {
        return {
          issues: [{ message: `isTyping must be a boolean` }],
        }
      }

      if (typeof data.lastSeen !== `number`) {
        return {
          issues: [{ message: `lastSeen must be a number` }],
        }
      }

      if (typeof data.color !== `string` || data.color.length === 0) {
        return {
          issues: [{ message: `color must be a non-empty string` }],
        }
      }

      if (typeof data.sessionId !== `string` || data.sessionId.length === 0) {
        return {
          issues: [{ message: `sessionId must be a non-empty string` }],
        }
      }

      return { value: data as PresenceData }
    },
  },
}

// ============================================================================
// State Schemas
// ============================================================================

export const registryStateSchema = createStateSchema({
  streams: {
    schema: streamMetadataSchema,
    type: `stream`,
    primaryKey: `path`,
  },
})

export const presenceStateSchema = createStateSchema({
  presence: {
    schema: presenceSchema,
    type: `presence`,
    primaryKey: `sessionId`,
  },
})
