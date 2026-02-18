import { DurableStream } from "@durable-streams/client"
import { createStreamDB } from "@durable-streams/state"
import { metadataStateSchema } from "@durable-streams/stream-fs"

export type MetadataDB = ReturnType<typeof createMetadataStreamDB>

function createMetadataStreamDB(url: string) {
  return createStreamDB({
    streamOptions: {
      url,
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

export function getOrCreateMetadataDB(
  baseUrl: string,
  streamPrefix: string
): Promise<MetadataDB> {
  const url = buildUrl(baseUrl, streamPrefix)
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
