import { InvalidJsonError } from "./errors"

export type ExpirationInfo = {
  readonly ttlSeconds?: number
  readonly expiresAt?: string
  readonly createdAt?: number
}

export const isExpired = (info: ExpirationInfo): boolean => {
  const now = Date.now()

  if (info.expiresAt) {
    const expiresAtMs = new Date(info.expiresAt).getTime()
    if (!Number.isFinite(expiresAtMs) || now >= expiresAtMs) {
      return true
    }
  }

  if (info.ttlSeconds !== undefined && info.createdAt !== undefined) {
    const expiresAtMs = info.createdAt + info.ttlSeconds * 1000
    if (now >= expiresAtMs) {
      return true
    }
  }

  return false
}

const TTL_REGEX = /^[1-9][0-9]*$/
const EXPIRES_AT_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export const normalizeContentType = (
  contentType: string | undefined
): string => {
  if (!contentType) return ``
  const semicolonIndex = contentType.indexOf(`;`)
  if (semicolonIndex !== -1) {
    return contentType.slice(0, semicolonIndex).trim().toLowerCase()
  }
  return contentType.trim().toLowerCase()
}

export const isJsonContentType = (contentType: string): boolean => {
  const normalized = normalizeContentType(contentType)
  return normalized === `application/json` || normalized.endsWith(`+json`)
}

export const validateTTL = (ttl: string): number | null => {
  if (!TTL_REGEX.test(ttl)) return null
  const parsed = parseInt(ttl, 10)
  return isNaN(parsed) || parsed <= 0 ? null : parsed
}

export const validateExpiresAt = (value: string): Date | null => {
  if (!EXPIRES_AT_REGEX.test(value)) return null
  const date = new Date(value)
  return isNaN(date.getTime()) ? null : date
}

export const processJsonAppend = (
  data: Uint8Array,
  isInitialCreate = false
): Uint8Array => {
  const text = new TextDecoder().decode(data)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new InvalidJsonError(`Invalid JSON`)
  }

  let result: string
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      if (isInitialCreate) {
        return new Uint8Array(0)
      }
      throw new InvalidJsonError(`Empty arrays are not allowed`)
    }
    const elements = parsed.map((item) => JSON.stringify(item))
    result = elements.join(`,`) + `,`
  } else {
    result = JSON.stringify(parsed) + `,`
  }

  return new TextEncoder().encode(result)
}

export const formatJsonResponse = (data: Uint8Array): Uint8Array => {
  if (data.length === 0) {
    return new TextEncoder().encode(`[]`)
  }

  let text = new TextDecoder().decode(data)
  text = text.trimEnd()
  if (text.endsWith(`,`)) {
    text = text.slice(0, -1)
  }

  return new TextEncoder().encode(`[${text}]`)
}

export const generateETag = (
  path: string,
  startOffset: string,
  endOffset: string
): string => {
  const pathBase64 = btoa(path)
  return `"${pathBase64}:${startOffset}:${endOffset}"`
}

export const parseETag = (
  etag: string
): { path: string; startOffset: string; endOffset: string } | null => {
  const match = /^"([^:]+):([^:]+):([^"]+)"$/.exec(etag)
  if (!match || match.length < 4) return null

  const pathBase64 = match[1]
  const startOffset = match[2]
  const endOffset = match[3]

  if (!(pathBase64 && startOffset && endOffset)) return null

  try {
    return { path: atob(pathBase64), startOffset, endOffset }
  } catch {
    return null
  }
}
