/**
 * Storage utilities for requestId mapping and session credentials.
 */

import type {
  DurableStorage,
  RequestIdMapping,
  SessionCredentials,
} from "./types"

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

export function getDefaultStorage(): DurableStorage {
  if (typeof localStorage !== `undefined`) {
    return localStorage
  }
  return new MemoryStorage()
}

export function createRequestIdStorageKey(
  prefix: string,
  proxyUrl: string,
  requestId: string,
  sessionId?: string
): string {
  if (sessionId) {
    return `${prefix}${proxyUrl}:${sessionId}:${requestId}`
  }
  return `${prefix}${proxyUrl}::${requestId}`
}

export function saveRequestIdMapping(
  storage: DurableStorage,
  prefix: string,
  proxyUrl: string,
  requestId: string,
  mapping: RequestIdMapping,
  sessionId?: string
): void {
  storage.setItem(
    createRequestIdStorageKey(prefix, proxyUrl, requestId, sessionId),
    JSON.stringify(mapping)
  )
}

export function loadRequestIdMapping(
  storage: DurableStorage,
  prefix: string,
  proxyUrl: string,
  requestId: string,
  sessionId?: string
): RequestIdMapping | null {
  const raw = storage.getItem(
    createRequestIdStorageKey(prefix, proxyUrl, requestId, sessionId)
  )
  if (!raw) return null
  try {
    return JSON.parse(raw) as RequestIdMapping
  } catch {
    return null
  }
}

export function removeRequestIdMapping(
  storage: DurableStorage,
  prefix: string,
  proxyUrl: string,
  requestId: string,
  sessionId?: string
): void {
  storage.removeItem(
    createRequestIdStorageKey(prefix, proxyUrl, requestId, sessionId)
  )
}

export function createSessionStorageKey(
  prefix: string,
  proxyUrl: string,
  sessionId: string
): string {
  return `${prefix}session:${proxyUrl}:${sessionId}`
}

export function saveSessionCredentials(
  storage: DurableStorage,
  prefix: string,
  proxyUrl: string,
  sessionId: string,
  credentials: SessionCredentials
): void {
  storage.setItem(
    createSessionStorageKey(prefix, proxyUrl, sessionId),
    JSON.stringify(credentials)
  )
}

export function loadSessionCredentials(
  storage: DurableStorage,
  prefix: string,
  proxyUrl: string,
  sessionId: string
): SessionCredentials | null {
  const raw = storage.getItem(
    createSessionStorageKey(prefix, proxyUrl, sessionId)
  )
  if (!raw) return null
  try {
    return JSON.parse(raw) as SessionCredentials
  } catch {
    return null
  }
}

export function removeSessionCredentials(
  storage: DurableStorage,
  prefix: string,
  proxyUrl: string,
  sessionId: string
): void {
  storage.removeItem(createSessionStorageKey(prefix, proxyUrl, sessionId))
}

export function extractStreamIdFromUrl(url: string): string {
  const parsed = new URL(url)
  const parts = parsed.pathname.split(`/`)
  const last = parts[parts.length - 1] || parts[parts.length - 2]
  if (!last) {
    throw new Error(`Cannot extract stream ID from URL: ${url}`)
  }
  return decodeURIComponent(last)
}

export function extractExpiresFromUrl(url: string): number {
  const parsed = new URL(url)
  const expires = parsed.searchParams.get(`expires`)
  if (!expires) {
    throw new Error(`Cannot extract expires from URL: ${url}`)
  }
  return parseInt(expires, 10)
}

// Legacy aliases retained to reduce breakage while tests migrate.
export const createStorageKey = (
  prefix: string,
  scope: string,
  requestId: string
): string => createRequestIdStorageKey(prefix, scope, requestId)

export const saveCredentials = (
  storage: DurableStorage,
  prefix: string,
  scope: string,
  requestId: string,
  credentials: RequestIdMapping
): void =>
  saveRequestIdMapping(storage, prefix, scope, requestId, {
    responseId: credentials.responseId,
    streamUrl: credentials.streamUrl,
  })

export const loadCredentials = (
  storage: DurableStorage,
  prefix: string,
  scope: string,
  requestId: string
): RequestIdMapping | null =>
  loadRequestIdMapping(storage, prefix, scope, requestId)

export const removeCredentials = (
  storage: DurableStorage,
  prefix: string,
  scope: string,
  requestId: string
): void => removeRequestIdMapping(storage, prefix, scope, requestId)

export function isUrlExpired(credentials: { streamUrl?: string }): boolean {
  if (!credentials.streamUrl) return false
  try {
    const expiresAtSecs = extractExpiresFromUrl(credentials.streamUrl)
    return Date.now() > expiresAtSecs * 1000
  } catch {
    return false
  }
}
