import { useEffect, useState } from "react"
import { DurableStream } from "@durable-streams/client"
import { createStreamDB } from "@durable-streams/state"
import { metadataStateSchema } from "@durable-streams/stream-fs"

export type MetadataDB = ReturnType<typeof createMetadataStreamDB>

function createMetadataStreamDB(metadataStreamUrl: string) {
  return createStreamDB({
    streamOptions: {
      url: metadataStreamUrl,
      contentType: `application/json`,
    },
    state: metadataStateSchema,
  })
}

function buildUrl(baseUrl: string, streamPrefix: string): string {
  const prefix = streamPrefix.startsWith(`/`)
    ? streamPrefix
    : `/${streamPrefix}`
  return `${baseUrl.replace(/\/$/, ``)}${prefix}/_metadata`
}

// Singleton: one MetadataDB per URL, survives StrictMode remounts
const dbCache = new Map<string, Promise<MetadataDB>>()

function getOrCreateMetadataDB(url: string): Promise<MetadataDB> {
  let promise = dbCache.get(url)
  if (!promise) {
    promise = (async () => {
      const probe = new DurableStream({ url })
      const exists = await probe.head().catch(() => null)
      if (!exists) {
        await DurableStream.create({ url, contentType: `application/json` })
      }
      return createMetadataStreamDB(url)
    })()
    dbCache.set(url, promise)
  }
  return promise
}

/**
 * Returns a singleton MetadataDB for the metadata stream.
 *
 * Creates the stream if it doesn't exist (one HEAD + one CREATE at most).
 * Returns the DB before preloading — call `db.preload()` after
 * `useLiveQuery` subscribes to avoid the TanStack DB race condition.
 */
export function useMetadataDB(baseUrl: string, streamPrefix: string) {
  const [db, setDb] = useState<MetadataDB | null>(null)

  useEffect(() => {
    let cancelled = false
    const url = buildUrl(baseUrl, streamPrefix)

    getOrCreateMetadataDB(url)
      .then((instance) => {
        if (!cancelled) setDb(instance)
      })
      .catch((err) => {
        if (!cancelled) {
          console.error(`[useMetadataDB] Failed to connect:`, err)
        }
      })

    return () => {
      cancelled = true
    }
  }, [baseUrl, streamPrefix])

  return db
}
