/**
 * Helper to create lifecycle hooks that maintain a __registry__ stream.
 * This stream records all create/delete events for observability.
 */

import { DurableStream } from "@durable-streams/client"
import { createStateSchema } from "@durable-streams/state"
import type { StreamLifecycleHook } from "./types"
import type { StreamManager } from "./stream-manager"

const REGISTRY_PATH = `/v1/stream/__registry__`

// Registry schema for the server
interface StreamMetadata {
  path: string
  contentType: string
  createdAt: number
}

const streamMetadataSchema = {
  "~standard": {
    version: 1 as const,
    vendor: `durable-streams`,
    validate: (value: unknown) => {
      if (typeof value !== `object` || value === null) {
        return { issues: [{ message: `value must be an object` }] }
      }
      const data = value as any
      if (typeof data.path !== `string` || data.path.length === 0) {
        return { issues: [{ message: `path must be a non-empty string` }] }
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
        return { issues: [{ message: `createdAt must be a number` }] }
      }
      return { value: data as StreamMetadata }
    },
  },
}

const registryStateSchema = createStateSchema({
  streams: {
    schema: streamMetadataSchema,
    type: `stream`,
    primaryKey: `path`,
  },
})

/**
 * Creates lifecycle hooks that write to a __registry__ stream.
 * Any client can read this stream to discover all streams and their lifecycle events.
 */
export function createRegistryHooks(
  store: StreamManager,
  serverUrl: string
): {
  onStreamCreated: StreamLifecycleHook
  onStreamDeleted: StreamLifecycleHook
} {
  const registryStream = new DurableStream({
    url: `${serverUrl}${REGISTRY_PATH}`,
    contentType: `application/json`,
  })

  const ensureRegistryExists = async () => {
    if (!(await store.has(REGISTRY_PATH))) {
      await DurableStream.create({
        url: `${serverUrl}${REGISTRY_PATH}`,
        contentType: `application/json`,
      })
    }
  }

  // Helper to extract stream name from full path
  const extractStreamName = (fullPath: string): string => {
    // Remove /v1/stream/ prefix if present
    return fullPath.replace(/^\/v1\/stream\//, ``)
  }

  return {
    onStreamCreated: async (event) => {
      await ensureRegistryExists()

      const streamName = extractStreamName(event.path)

      const changeEvent = registryStateSchema.streams.insert({
        key: streamName,
        value: {
          path: streamName,
          contentType: event.contentType || `application/octet-stream`,
          createdAt: event.timestamp,
        },
      })

      await registryStream.append(JSON.stringify(changeEvent))
    },

    onStreamDeleted: async (event) => {
      await ensureRegistryExists()

      const streamName = extractStreamName(event.path)

      const changeEvent = registryStateSchema.streams.delete({
        key: streamName,
      })

      await registryStream.append(JSON.stringify(changeEvent))
    },
  }
}
