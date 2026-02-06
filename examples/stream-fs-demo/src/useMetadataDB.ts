import { useEffect, useState } from "react"
import { getOrCreateMetadataDB } from "./metadataDB"
import type { MetadataDB } from "./metadataDB"

export type { MetadataDB } from "./metadataDB"

export function useMetadataDB(baseUrl: string, streamPrefix: string) {
  const [db, setDb] = useState<MetadataDB | null>(null)

  useEffect(() => {
    let cancelled = false

    getOrCreateMetadataDB(baseUrl, streamPrefix)
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
