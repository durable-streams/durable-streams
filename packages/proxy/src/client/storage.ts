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
 * Create a scoped storage key for a stream.
 *
 * Keys are scoped by proxy URL to prevent collisions between
 * different services or proxy instances using the same stream key.
 *
 * @param prefix - Storage key prefix
 * @param scope - Scope identifier (typically derived from proxyUrl)
 * @param streamKey - The stream key
 */
export function createStorageKey(
  prefix: string,
  scope: string,
  streamKey: string
): string {
  return `${prefix}${scope}:${streamKey}`
}

/**
 * Create a scope identifier from a proxy URL.
 * Uses origin + pathname to uniquely identify the proxy service.
 */
export function createScopeFromUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl)
    // Use origin + pathname for uniqueness (e.g., "https://proxy.example.com/v1/proxy/chat")
    return `${url.origin}${url.pathname}`
  } catch {
    // Fallback to raw URL if parsing fails
    return proxyUrl
  }
}

/**
 * Save stream credentials to storage.
 */
export function saveCredentials(
  storage: DurableStorage,
  prefix: string,
  scope: string,
  streamKey: string,
  credentials: StreamCredentials
): void {
  const key = createStorageKey(prefix, scope, streamKey)
  storage.setItem(key, JSON.stringify(credentials))
}

/**
 * Load stream credentials from storage.
 */
export function loadCredentials(
  storage: DurableStorage,
  prefix: string,
  scope: string,
  streamKey: string
): StreamCredentials | null {
  const key = createStorageKey(prefix, scope, streamKey)
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
  scope: string,
  streamKey: string
): void {
  const key = createStorageKey(prefix, scope, streamKey)
  storage.removeItem(key)
}

/**
 * Update the offset in stored credentials.
 */
export function updateOffset(
  storage: DurableStorage,
  prefix: string,
  scope: string,
  streamKey: string,
  offset: string
): void {
  const credentials = loadCredentials(storage, prefix, scope, streamKey)

  if (credentials) {
    credentials.offset = offset
    saveCredentials(storage, prefix, scope, streamKey, credentials)
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
