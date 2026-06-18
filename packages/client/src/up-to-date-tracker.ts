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
  get(key: string): { cursor: string; timestamp: number } | null {
    return this.#map.get(key) ?? null
  }
  set(key: string, value: { cursor: string; timestamp: number }): void {
    this.#map.set(key, value)
  }
  delete(key: string): void {
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
const PERSIST_THROTTLE_MS = 60_000

interface TrackerSharedState {
  keys: Array<string>
  memory: Map<string, { cursor: string; timestamp: number }>
  lastPersistedAt: Map<string, number>
  pendingTimers: Map<string, ReturnType<typeof setTimeout>>
}

const sharedStates = new WeakMap<UpToDateStorage, TrackerSharedState>()

function getSharedState(storage: UpToDateStorage): TrackerSharedState {
  let state = sharedStates.get(storage)
  if (!state) {
    state = {
      keys: [],
      memory: new Map(),
      lastPersistedAt: new Map(),
      pendingTimers: new Map(),
    }
    sharedStates.set(storage, state)
  }
  return state
}

export class UpToDateTracker {
  readonly #storage: UpToDateStorage
  readonly #shared: TrackerSharedState

  constructor(storage?: UpToDateStorage) {
    this.#storage = storage ?? new InMemoryUpToDateStorage()
    this.#shared = getSharedState(this.#storage)
  }

  recordUpToDate(streamKey: string, cursor: string): void {
    const value = { cursor, timestamp: Date.now() }
    this.#shared.memory.set(streamKey, value)

    const lastPersistedAt =
      this.#shared.lastPersistedAt.get(streamKey) ?? -Infinity
    const elapsed = Date.now() - lastPersistedAt
    if (elapsed >= PERSIST_THROTTLE_MS) {
      this.#storage.set(streamKey, value)
      this.#shared.lastPersistedAt.set(streamKey, Date.now())
    } else if (!this.#shared.pendingTimers.has(streamKey)) {
      const timer = setTimeout(() => {
        this.#shared.pendingTimers.delete(streamKey)
        const latest = this.#shared.memory.get(streamKey)
        if (latest) {
          this.#storage.set(streamKey, latest)
          this.#shared.lastPersistedAt.set(streamKey, Date.now())
        }
      }, PERSIST_THROTTLE_MS - elapsed)
      this.#shared.pendingTimers.set(streamKey, timer)
    }

    // LRU eviction
    const idx = this.#shared.keys.indexOf(streamKey)
    if (idx !== -1) this.#shared.keys.splice(idx, 1)
    this.#shared.keys.push(streamKey)
    while (this.#shared.keys.length > MAX_ENTRIES) {
      const evicted = this.#shared.keys.shift()!
      this.#shared.memory.delete(evicted)
      this.#storage.delete(evicted)
      const timer = this.#shared.pendingTimers.get(evicted)
      if (timer) clearTimeout(timer)
      this.#shared.pendingTimers.delete(evicted)
      this.#shared.lastPersistedAt.delete(evicted)
    }
  }

  shouldEnterReplayMode(streamKey: string): string | null {
    const entry =
      this.#shared.memory.get(streamKey) ?? this.#storage.get(streamKey)
    if (!entry) return null
    if (Date.now() - entry.timestamp > TTL_MS) {
      this.delete(streamKey)
      return null
    }
    return entry.cursor
  }

  delete(streamKey: string): void {
    this.#storage.delete(streamKey)
    this.#shared.memory.delete(streamKey)
    const timer = this.#shared.pendingTimers.get(streamKey)
    if (timer) clearTimeout(timer)
    this.#shared.pendingTimers.delete(streamKey)
    this.#shared.lastPersistedAt.delete(streamKey)
    const idx = this.#shared.keys.indexOf(streamKey)
    if (idx !== -1) this.#shared.keys.splice(idx, 1)
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
