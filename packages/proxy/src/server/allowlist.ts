/**
 * Upstream URL allowlist validation.
 *
 * The proxy only forwards requests to explicitly allowed upstream URLs.
 * Patterns support glob-style wildcards for flexible configuration.
 */

/**
 * Check if a character is a special glob character.
 */
function isGlobSpecial(char: string): boolean {
  return char === `*` || char === `?` || char === `[` || char === `]`
}

/**
 * Convert a glob pattern to a regular expression.
 *
 * Supports:
 * - `*` - matches any characters (non-greedy)
 * - `?` - matches exactly one character
 * - `**` - matches any path segment(s)
 * - Character escaping with backslash
 *
 * @param pattern - The glob pattern
 * @returns A RegExp that matches the pattern
 */
function globToRegex(pattern: string): RegExp {
  let regex = `^`
  let i = 0

  while (i < pattern.length) {
    const char = pattern[i]
    const nextChar = pattern[i + 1]

    if (char === `\\`) {
      // Escape sequence - include next character literally
      if (nextChar !== undefined) {
        regex += escapeRegExp(nextChar)
        i += 2
      } else {
        regex += `\\\\`
        i++
      }
    } else if (char === `*` && nextChar === `*`) {
      // ** matches anything including path separators
      regex += `.*`
      i += 2
    } else if (char === `*`) {
      // * matches anything except path separators
      regex += `[^/]*`
      i++
    } else if (char === `?`) {
      // ? matches exactly one character (not /)
      regex += `[^/]`
      i++
    } else if (isGlobSpecial(char!)) {
      // Escape other glob characters
      regex += `\\` + char
      i++
    } else {
      // Regular character - escape if it's a regex special char
      regex += escapeRegExp(char!)
      i++
    }
  }

  regex += `$`
  return new RegExp(regex, `i`) // Case-insensitive matching
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`)
}

/**
 * Create an allowlist validator from a list of patterns.
 *
 * @param patterns - Array of URL patterns (glob-style wildcards supported)
 * @returns A function that validates URLs against the allowlist
 *
 * @example
 * ```typescript
 * const isAllowed = createAllowlistValidator([
 *   'https://api.openai.com/**',
 *   'https://api.anthropic.com/**',
 *   'https://*.example.com/api/*'
 * ])
 *
 * isAllowed('https://api.openai.com/v1/chat/completions') // true
 * isAllowed('https://evil.com/malicious') // false
 * ```
 */
export function createAllowlistValidator(
  patterns: Array<string>
): (url: string) => boolean {
  if (patterns.length === 0) {
    // Empty allowlist blocks all URLs
    return () => false
  }

  const regexes = patterns.map(globToRegex)

  return (url: string): boolean => {
    // Canonicalize URL to prevent bypass via alternate representations
    const normalized = normalizeUrlForAllowlist(url)
    if (!normalized) {
      return false
    }

    return regexes.some((regex) => regex.test(normalized))
  }
}

/**
 * Normalize a URL to canonical form for allowlist comparison.
 *
 * This prevents bypass via:
 * - Default ports (https://example.com:443 vs https://example.com)
 * - Case variations in hostname
 * - Trailing slashes
 * - URL encoding tricks
 *
 * @param url - The URL to normalize
 * @returns Normalized URL string, or null if invalid
 */
function normalizeUrlForAllowlist(url: string): string | null {
  try {
    const parsed = new URL(url)

    // Build canonical URL:
    // - Protocol is already lowercase from URL parser
    // - Host is already lowercase from URL parser
    // - Remove default ports (URL parser includes them in origin if explicit)
    let normalized = `${parsed.protocol}//${parsed.hostname}`

    // Only include port if non-default
    if (parsed.port) {
      const isDefaultPort =
        (parsed.protocol === `https:` && parsed.port === `443`) ||
        (parsed.protocol === `http:` && parsed.port === `80`)
      if (!isDefaultPort) {
        normalized += `:${parsed.port}`
      }
    }

    // Add pathname (URL parser normalizes .. and other path components)
    normalized += parsed.pathname

    // Remove trailing slashes for consistent matching
    normalized = normalized.replace(/\/+$/, ``)

    return normalized
  } catch {
    return null
  }
}

/**
 * Validate that a URL is well-formed and uses HTTPS.
 *
 * @param url - The URL to validate
 * @returns The parsed URL if valid, null if invalid
 */
export function validateUpstreamUrl(url: string): URL | null {
  try {
    const parsed = new URL(url)

    // Only allow HTTPS in production
    if (parsed.protocol !== `https:` && parsed.protocol !== `http:`) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

/**
 * Validate a path segment (service name or stream key) for safety.
 *
 * Rejects values that could enable path traversal attacks:
 * - Contains `/` or `\` (directory separators)
 * - Contains `..` (parent directory reference)
 * - Contains URL-encoded versions of the above
 * - Is empty or only whitespace
 *
 * @param segment - The path segment to validate
 * @returns True if safe, false if potentially malicious
 */
export function isValidPathSegment(segment: string): boolean {
  if (!segment || segment.trim().length === 0) {
    return false
  }

  // Decode any URL encoding to catch %2f, %2e%2e, etc.
  let decoded: string
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    // Invalid encoding - reject
    return false
  }

  // Check for path traversal patterns in both original and decoded form
  const dangerous = /[/\\]|\.\./.test(segment) || /[/\\]|\.\./.test(decoded)

  return !dangerous
}

/**
 * Headers that should NOT be forwarded to upstream.
 * These are hop-by-hop headers or headers that should be set by the proxy.
 */
export const HOP_BY_HOP_HEADERS: Set<string> = new Set([
  `connection`,
  `keep-alive`,
  `proxy-authenticate`,
  `proxy-authorization`,
  `te`,
  `trailers`,
  `transfer-encoding`,
  `upgrade`,
  `host`,
  `accept-encoding`, // We handle compression ourselves
  `content-length`, // Will be set based on actual body
])

/**
 * Headers that are proxy-specific and should NOT be forwarded to upstream.
 * These are used by the proxy for configuration.
 */
export const PROXY_HEADERS: Set<string> = new Set([
  `upstream-url`,
  `upstream-method`,
  `upstream-authorization`,
])

/**
 * Filter headers for forwarding to upstream.
 *
 * @param headers - The incoming request headers
 * @returns Headers safe to forward to upstream
 */
export function filterHeadersForUpstream(
  headers: Record<string, string | Array<string> | undefined>
): Record<string, string> {
  const filtered: Record<string, string> = {}

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase()

    // Skip hop-by-hop headers
    if (HOP_BY_HOP_HEADERS.has(lowerKey)) {
      continue
    }

    // Skip proxy-specific headers (these are for proxy configuration only)
    if (PROXY_HEADERS.has(lowerKey)) {
      continue
    }

    // Skip undefined values
    if (value === undefined) {
      continue
    }

    // Join array values with comma
    filtered[key] = Array.isArray(value) ? value.join(`, `) : value
  }

  return filtered
}
