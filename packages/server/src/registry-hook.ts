/**
 * Helper to create lifecycle hooks that maintain a __registry__ stream.
 * This stream records all create/delete events for observability.
 */

import { DurableStream } from "@durable-streams/client"
import type { StreamLifecycleHook } from "./types"
import type { StreamStore } from "./store"
import type { FileBackedStreamStore } from "./file-store"

const REGISTRY_PATH = `/v1/stream/__registry__`

/**
 * Creates lifecycle hooks that write to a __registry__ stream.
 * Any client can read this stream to discover all streams and their lifecycle events.
 */
export function createRegistryHooks(
  store: StreamStore | FileBackedStreamStore,
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
    if (!store.has(REGISTRY_PATH)) {
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

      await registryStream.append({
        type: event.type,
        path: streamName,
        contentType: event.contentType,
        timestamp: event.timestamp,
      })
    },

    onStreamDeleted: async (event) => {
      await ensureRegistryExists()

      const streamName = extractStreamName(event.path)

      await registryStream.append({
        type: event.type,
        path: streamName,
        timestamp: event.timestamp,
      })
    },
  }
}
