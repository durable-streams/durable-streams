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
 * Keys are scoped by proxy base URL to prevent collisions between
 * different proxy instances using the same request ID.
 *
 * @param prefix - Storage key prefix
 * @param scope - Scope identifier (the normalized proxy base URL)
 * @param requestId - The request ID
 */
export function createStorageKey(
  prefix: string,
  scope: string,
  requestId: string
): string {
  return `${prefix}${scope}:${requestId}`
}

/**
 * Save stream credentials to storage.
 */
export function saveCredentials(
  storage: DurableStorage,
  prefix: string,
  scope: string,
  requestId: string,
  credentials: StreamCredentials
): void {
  const key = createStorageKey(prefix, scope, requestId)
  storage.setItem(key, JSON.stringify(credentials))
}

/**
 * Load stream credentials from storage.
 */
export function loadCredentials(
  storage: DurableStorage,
  prefix: string,
  scope: string,
  requestId: string
): StreamCredentials | null {
  const key = createStorageKey(prefix, scope, requestId)
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
  requestId: string
): void {
  const key = createStorageKey(prefix, scope, requestId)
  storage.removeItem(key)
}

/**
 * Check if a stream's pre-signed URL has expired.
 */
export function isUrlExpired(credentials: StreamCredentials): boolean {
  return Date.now() > credentials.expiresAtSecs * 1000
}

/**
 * Extract the stream ID from a pre-signed URL.
 *
 * Expected format: .../v1/proxy/{streamId}?expires=...&signature=...
 */
export function extractStreamIdFromUrl(url: string): string {
  const parsed = new URL(url)
  const match = parsed.pathname.match(/\/v1\/proxy\/([^/]+)\/?$/)
  if (!match) {
    throw new Error(`Cannot extract stream ID from URL: ${url}`)
  }
  return decodeURIComponent(match[1]!)
}

/**
 * Extract the expiration timestamp from a pre-signed URL.
 *
 * @returns Unix timestamp in seconds
 */
export function extractExpiresFromUrl(url: string): number {
  const parsed = new URL(url)
  const expires = parsed.searchParams.get(`expires`)
  if (!expires) {
    throw new Error(`Cannot extract expires from URL: ${url}`)
  }
  return parseInt(expires, 10)
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
