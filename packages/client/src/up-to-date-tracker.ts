/**
 * Pluggable storage for tracking the cursor at each up-to-date transition.
 * Used by ReplayingState to suppress duplicate batches when CDN serves cached responses.
 */

import {
  CACHE_BUSTER_QUERY_PARAM,
  CURSOR_QUERY_PARAM,
  LIVE_QUERY_PARAM,
  OFFSET_QUERY_PARAM,
} from "./constants"

export interface UpToDateStorage {
  get: (key: string) => { cursor: string; timestamp: number } | null
  set: (key: string, value: { cursor: string; timestamp: number }) => void
  delete: (key: string) => void
}

export class InMemoryUpToDateStorage implements UpToDateStorage {
  readonly #map = new Map<string, { cursor: string; timestamp: number }>()
  get(key: string) {
    return this.#map.get(key) ?? null
  }
  set(key: string, value: { cursor: string; timestamp: number }) {
    this.#map.set(key, value)
  }
  delete(key: string) {
    this.#map.delete(key)
  }
}

export class LocalStorageUpToDateStorage implements UpToDateStorage {
  readonly #prefix: string
  constructor(prefix = `ds-utd-`) {
    this.#prefix = prefix
  }

  get(key: string): { cursor: string; timestamp: number } | null {
    try {
      const raw = localStorage.getItem(this.#prefix + key)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }

  set(key: string, value: { cursor: string; timestamp: number }): void {
    try {
      localStorage.setItem(this.#prefix + key, JSON.stringify(value))
    } catch {
      /* quota exceeded, private browsing, SSR */
    }
  }

  delete(key: string): void {
    try {
      localStorage.removeItem(this.#prefix + key)
    } catch {
      /* SSR */
    }
  }
}

const TTL_MS = 60_000
const MAX_ENTRIES = 250

export class UpToDateTracker {
  readonly #storage: UpToDateStorage
  readonly #keys: Array<string> = [] // for LRU eviction (in-memory only)

  constructor(storage?: UpToDateStorage) {
    this.#storage = storage ?? new InMemoryUpToDateStorage()
  }

  recordUpToDate(streamKey: string, cursor: string): void {
    this.#storage.set(streamKey, { cursor, timestamp: Date.now() })
    // LRU eviction
    const idx = this.#keys.indexOf(streamKey)
    if (idx !== -1) this.#keys.splice(idx, 1)
    this.#keys.push(streamKey)
    while (this.#keys.length > MAX_ENTRIES) {
      const evicted = this.#keys.shift()!
      this.#storage.delete(evicted)
    }
  }

  shouldEnterReplayMode(streamKey: string): string | null {
    const entry = this.#storage.get(streamKey)
    if (!entry) return null
    if (Date.now() - entry.timestamp > TTL_MS) {
      this.#storage.delete(streamKey)
      return null
    }
    return entry.cursor
  }

  delete(streamKey: string): void {
    this.#storage.delete(streamKey)
    const idx = this.#keys.indexOf(streamKey)
    if (idx !== -1) this.#keys.splice(idx, 1)
  }
}

/**
 * Strip all protocol-varying params so stale-retry URLs and normal URLs
 * produce the same canonical key.
 */
export function canonicalStreamKey(url: string | URL): string {
  const u = new URL(url.toString())
  u.searchParams.delete(OFFSET_QUERY_PARAM)
  u.searchParams.delete(CURSOR_QUERY_PARAM)
  u.searchParams.delete(LIVE_QUERY_PARAM)
  u.searchParams.delete(CACHE_BUSTER_QUERY_PARAM)
  return u.toString()
}
