/**
 * Validation utilities for CLI options with helpful error messages.
 */

export interface ValidationResult {
  valid: boolean
  error?: string
}

/**
 * Validate a URL string.
 * Must be a valid HTTP or HTTPS URL.
 */
export function validateUrl(url: string): ValidationResult {
  if (!url || !url.trim()) {
    return {
      valid: false,
      error: `URL cannot be empty`,
    }
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return {
      valid: false,
      error: `Invalid URL format: "${url}"\n  Expected format: http://host:port or https://host:port`,
    }
  }

  if (parsed.protocol !== `http:` && parsed.protocol !== `https:`) {
    return {
      valid: false,
      error: `Invalid URL protocol: "${parsed.protocol}"\n  Only http:// and https:// are supported`,
    }
  }

  if (!parsed.hostname) {
    return {
      valid: false,
      error: `URL must include a hostname: "${url}"`,
    }
  }

  return { valid: true }
}

/**
 * Validate an authorization header value.
 * Should be non-empty and ideally follow "Scheme value" format.
 */
export function validateAuth(auth: string): ValidationResult {
  if (!auth || !auth.trim()) {
    return {
      valid: false,
      error: `Authorization value cannot be empty`,
    }
  }

  const trimmed = auth.trim()

  // Check for common auth schemes (case-insensitive)
  const lowerTrimmed = trimmed.toLowerCase()
  const hasScheme = [`bearer `, `basic `, `apikey `, `token `].some((scheme) =>
    lowerTrimmed.startsWith(scheme)
  )

  if (!hasScheme && !trimmed.includes(` `)) {
    // Warn but don't fail - might be a raw token
    return {
      valid: true,
      error: `Warning: Authorization value doesn't match common formats.\n  Expected: "Bearer <token>", "Basic <credentials>", or "ApiKey <key>"`,
    }
  }

  return { valid: true }
}

/**
 * Validate a stream ID.
 * Must be non-empty and contain only valid characters.
 */
export function validateStreamId(streamId: string): ValidationResult {
  if (!streamId || !streamId.trim()) {
    return {
      valid: false,
      error: `Stream ID cannot be empty`,
    }
  }

  // Stream IDs should be URL-safe
  const validPattern = /^[a-zA-Z0-9_\-.:]+$/
  if (!validPattern.test(streamId)) {
    return {
      valid: false,
      error: `Invalid stream ID: "${streamId}"\n  Stream IDs can only contain letters, numbers, underscores, hyphens, dots, and colons`,
    }
  }

  if (streamId.length > 256) {
    return {
      valid: false,
      error: `Stream ID too long (${streamId.length} chars)\n  Maximum length is 256 characters`,
    }
  }

  return { valid: true }
}
