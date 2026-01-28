/**
 * Upstream URL allowlist validation.
 *
 * The proxy only forwards requests to explicitly allowed upstream URLs.
 * Uses URLPattern-style matching with regex-based component matchers.
 */

/**
 * Parsed allowlist pattern with regex matchers for each URL component.
 */
interface AllowlistPattern {
  protocol: RegExp
  hostname: RegExp
  port: string | null // null = any port, empty string = default port
  pathname: RegExp
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`)
}

/**
 * Convert a glob pattern segment to a regex pattern.
 * Handles `*` as wildcard (matches any characters except path separators).
 */
function globSegmentToRegex(segment: string): string {
  // Handle ** (match anything) - not typically used in hostname but support it
  if (segment === `**`) {
    return `.*`
  }

  // Handle wildcards within segment
  const parts = segment.split(`*`)
  return parts.map(escapeRegExp).join(`[^/]*`)
}

/**
 * Parse an allowlist pattern into component matchers.
 *
 * Pattern syntax:
 * - `api.example.com` - match hostname, any protocol, any port, any path
 * - `https://api.example.com` - match https only
 * - `api.example.com:8080` - match specific port
 * - `api.example.com/v1/*` - match specific path prefix
 * - `*.example.com` - wildcard hostname
 *
 * @param pattern - The allowlist pattern string
 * @returns Parsed pattern with regex matchers
 */
function parseAllowlistPattern(pattern: string): AllowlistPattern {
  let protocol: RegExp
  let hostname: string
  let port: string | null = null // null means any port
  let pathname: string

  // Check if pattern has explicit protocol
  const protocolMatch = pattern.match(/^(https?):\/\/(.+)$/)
  if (protocolMatch) {
    protocol = new RegExp(`^${protocolMatch[1]}:$`, `i`)
    pattern = protocolMatch[2]!
  } else {
    // Match either http or https
    protocol = /^https?:$/i
  }

  // Split into host and path parts
  const pathIndex = pattern.indexOf(`/`)
  let hostPart: string
  if (pathIndex === -1) {
    hostPart = pattern
    pathname = `.*` // Match any path
  } else {
    hostPart = pattern.slice(0, pathIndex)
    const pathPart = pattern.slice(pathIndex)

    // Convert path glob to regex
    if (pathPart === `/*` || pathPart === `/**`) {
      pathname = `.*`
    } else if (pathPart.endsWith(`/*`)) {
      // /v1/* matches /v1 and /v1/anything
      const prefix = escapeRegExp(pathPart.slice(0, -2))
      pathname = `${prefix}(/.*)?`
    } else if (pathPart.endsWith(`/**`)) {
      // /v1/** matches /v1 and /v1/anything recursively
      const prefix = escapeRegExp(pathPart.slice(0, -3))
      pathname = `${prefix}(/.*)?`
    } else {
      // Exact path match
      pathname = escapeRegExp(pathPart)
    }
  }

  // Parse port from host (supports numeric ports and * wildcard)
  const portMatch = hostPart.match(/^(.+):(\d+|\*)$/)
  if (portMatch) {
    hostname = portMatch[1]!
    port = portMatch[2] === `*` ? null : portMatch[2]!
  } else {
    hostname = hostPart
    port = null // Any port
  }

  // Convert hostname glob to regex
  let hostnameRegex: string
  if (hostname.startsWith(`*.`)) {
    // *.example.com matches any subdomain
    const baseDomain = escapeRegExp(hostname.slice(2))
    hostnameRegex = `.*\\.${baseDomain}`
  } else if (hostname.includes(`*`)) {
    // General wildcard in hostname
    hostnameRegex = globSegmentToRegex(hostname)
  } else {
    // Exact hostname match
    hostnameRegex = escapeRegExp(hostname)
  }

  return {
    protocol,
    hostname: new RegExp(`^${hostnameRegex}$`, `i`),
    port,
    pathname: new RegExp(`^${pathname}$`),
  }
}

/**
 * Get the default port for a protocol.
 */
function getDefaultPort(protocol: string): string {
  if (protocol === `https:`) return `443`
  if (protocol === `http:`) return `80`
  return ``
}

/**
 * Normalize port for comparison.
 * Returns empty string for default ports.
 */
function normalizePort(port: string, protocol: string): string {
  if (!port) return ``
  if (port === getDefaultPort(protocol)) return ``
  return port
}

/**
 * Create an allowlist validator from a list of patterns.
 *
 * @param patterns - Array of URL patterns
 * @returns A function that validates URLs against the allowlist
 *
 * @example
 * ```typescript
 * const isAllowed = createAllowlistValidator([
 *   'https://api.openai.com/*',
 *   'https://api.anthropic.com/*',
 *   '*.example.com/api/*'
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

  const parsedPatterns = patterns.map(parseAllowlistPattern)

  return (url: string): boolean => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }

    // Only allow http/https
    if (parsed.protocol !== `http:` && parsed.protocol !== `https:`) {
      return false
    }

    // Must have hostname
    if (!parsed.hostname) {
      return false
    }

    // Normalize port (strip default ports)
    const normalizedPort = normalizePort(parsed.port, parsed.protocol)

    // Check each pattern
    for (const pattern of parsedPatterns) {
      // Protocol must match
      if (!pattern.protocol.test(parsed.protocol)) {
        continue
      }

      // Hostname must match
      if (!pattern.hostname.test(parsed.hostname)) {
        continue
      }

      // Port must match (pattern.port === null means any port is allowed)
      if (pattern.port !== null) {
        if (pattern.port !== normalizedPort) {
          continue
        }
      }

      // Pathname must match (ignoring query and fragment)
      if (!pattern.pathname.test(parsed.pathname)) {
        continue
      }

      return true
    }

    return false
  }
}

/**
 * Validate that a URL is well-formed and uses HTTP or HTTPS.
 *
 * @param url - The URL to validate
 * @returns The parsed URL if valid, null if invalid
 */
export function validateUpstreamUrl(url: string): URL | null {
  try {
    const parsed = new URL(url)

    // Only allow HTTP/HTTPS
    if (parsed.protocol !== `https:` && parsed.protocol !== `http:`) {
      return null
    }

    // Must have hostname
    if (!parsed.hostname) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

/**
 * Headers that should NOT be forwarded to upstream.
 * These are hop-by-hop headers or headers managed by the proxy.
 */
export const HOP_BY_HOP_HEADERS: Set<string> = new Set([
  `connection`,
  `keep-alive`,
  `proxy-authenticate`,
  `proxy-authorization`,
  `te`,
  `trailer`,
  `transfer-encoding`,
  `upgrade`,
  `host`,
  `authorization`,
  `accept-encoding`, // We handle compression ourselves
  `content-length`, // Will be set based on actual body
])

/**
 * Headers that are proxy-specific and should not be forwarded.
 */
const PROXY_HEADERS: Set<string> = new Set([
  `upstream-url`,
  `upstream-authorization`,
  `upstream-method`,
])

/**
 * Filter and transform headers for forwarding to upstream.
 *
 * @param headers - The incoming request headers
 * @param upstreamHostname - The hostname of the upstream server
 * @returns Headers safe to forward to upstream
 */
export function filterHeadersForUpstream(
  headers: Record<string, string | Array<string> | undefined>,
  upstreamHostname: string
): Record<string, string> {
  const filtered: Record<string, string> = {}

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase()

    // Skip hop-by-hop headers
    if (HOP_BY_HOP_HEADERS.has(lowerKey)) {
      continue
    }

    // Skip proxy-specific headers
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

  // Set Host header to upstream hostname
  filtered[`Host`] = upstreamHostname

  // Transform Upstream-Authorization to Authorization
  const upstreamAuth =
    headers[`upstream-authorization`] ?? headers[`Upstream-Authorization`]
  if (upstreamAuth !== undefined) {
    filtered[`Authorization`] = Array.isArray(upstreamAuth)
      ? upstreamAuth.join(`, `)
      : upstreamAuth
  }

  return filtered
}
