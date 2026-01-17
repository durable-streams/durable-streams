/**
 * Storage utilities for persisting stream credentials.
 */

import type { DurableStorage, StreamCredentials } from "./types"

/**
 * In-memory storage implementation.
 * Useful for server-side usage or testing.
 */
export class MemoryStorage implements DurableStorage {
  private store = new Map<string, string>()

  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }
}

/**
 * Create a storage key for a stream.
 */
export function createStorageKey(prefix: string, streamKey: string): string {
  return `${prefix}${streamKey}`
}

/**
 * Save stream credentials to storage.
 */
export function saveCredentials(
  storage: DurableStorage,
  prefix: string,
  streamKey: string,
  credentials: StreamCredentials
): void {
  const key = createStorageKey(prefix, streamKey)
  storage.setItem(key, JSON.stringify(credentials))
}

/**
 * Load stream credentials from storage.
 */
export function loadCredentials(
  storage: DurableStorage,
  prefix: string,
  streamKey: string
): StreamCredentials | null {
  const key = createStorageKey(prefix, streamKey)
  const data = storage.getItem(key)

  if (!data) {
    return null
  }

  try {
    return JSON.parse(data) as StreamCredentials
  } catch {
    return null
  }
}

/**
 * Remove stream credentials from storage.
 */
export function removeCredentials(
  storage: DurableStorage,
  prefix: string,
  streamKey: string
): void {
  const key = createStorageKey(prefix, streamKey)
  storage.removeItem(key)
}

/**
 * Update the offset in stored credentials.
 */
export function updateOffset(
  storage: DurableStorage,
  prefix: string,
  streamKey: string,
  offset: string
): void {
  const credentials = loadCredentials(storage, prefix, streamKey)

  if (credentials) {
    credentials.offset = offset
    saveCredentials(storage, prefix, streamKey, credentials)
  }
}

/**
 * Check if credentials have expired.
 * Credentials expire after 24 hours by default.
 */
export function isExpired(
  credentials: StreamCredentials,
  maxAgeMs: number = 24 * 60 * 60 * 1000
): boolean {
  return Date.now() - credentials.createdAt > maxAgeMs
}

/**
 * Get the default storage implementation.
 * Uses localStorage in browsers, MemoryStorage elsewhere.
 */
export function getDefaultStorage(): DurableStorage {
  if (typeof localStorage !== `undefined`) {
    return localStorage
  }
  return new MemoryStorage()
}
