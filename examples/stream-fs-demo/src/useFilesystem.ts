import { useEffect, useState } from "react"
import { DurableFilesystem } from "@durable-streams/stream-fs"

// Singleton: one DurableFilesystem per (baseUrl, streamPrefix)
const fsCache = new Map<string, Promise<DurableFilesystem>>()

function getOrCreateFilesystem(
  baseUrl: string,
  streamPrefix: string
): Promise<DurableFilesystem> {
  const key = `${baseUrl}|${streamPrefix}`
  let promise = fsCache.get(key)
  if (!promise) {
    promise = (async () => {
      const fs = new DurableFilesystem({ baseUrl, streamPrefix })
      await fs.initialize()
      return fs
    })()
    fsCache.set(key, promise)
  }
  return promise
}

/**
 * Returns a singleton DurableFilesystem.
 * Only initializes after `metadataReady` is true — this ensures the
 * metadata stream already exists so initialize() connects (not creates).
 */
export function useSharedFilesystem(
  baseUrl: string,
  streamPrefix: string,
  metadataReady: boolean
): DurableFilesystem | null {
  const [fs, setFs] = useState<DurableFilesystem | null>(null)

  useEffect(() => {
    if (!metadataReady) return
    let cancelled = false

    getOrCreateFilesystem(baseUrl, streamPrefix)
      .then((instance) => {
        if (!cancelled) setFs(instance)
      })
      .catch((err) => {
        if (!cancelled) {
          console.error(`[useSharedFilesystem] Failed to init:`, err)
        }
      })

    return () => {
      cancelled = true
    }
  }, [baseUrl, streamPrefix, metadataReady])

  return fs
}
