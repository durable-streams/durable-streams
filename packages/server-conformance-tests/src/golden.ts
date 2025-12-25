/**
 * Golden/wire transcript testing for Durable Streams servers.
 *
 * Golden tests capture byte-for-byte HTTP exchanges and replay them
 * to verify wire-level protocol compliance. This catches subtle issues
 * like header casing, whitespace in JSON, chunking differences, etc.
 *
 * Inspired by:
 * - Protocol Buffers conformance suite (stdin/stdout, golden comparisons)
 * - ConnectRPC conformance (YAML test cases, reference implementations)
 *
 * @see https://github.com/protocolbuffers/protobuf/tree/main/conformance
 * @see https://github.com/connectrpc/conformance
 */

// =============================================================================
// Types
// =============================================================================

/**
 * HTTP headers as ordered [name, value] tuples.
 * Order matters for golden comparison. Names are normalized to lowercase.
 */
export type HeaderTuples = Array<[string, string]>

/**
 * Body encoding for the transcript.
 */
export type BodyEncoding = `utf8` | `base64`

/**
 * Captured HTTP request
 */
export interface CapturedRequest {
  /** HTTP method */
  method: string
  /** Request path including query string */
  path: string
  /** Request headers as ordered tuples (lowercase names) */
  headers: HeaderTuples
  /** Request body */
  body: string
  /** Body encoding */
  bodyEncoding: BodyEncoding
}

/**
 * Captured HTTP response
 */
export interface CapturedResponse {
  /** HTTP status code */
  status: number
  /** Response headers as ordered tuples (lowercase names) */
  headers: HeaderTuples
  /** Response body */
  body: string
  /** Body encoding */
  bodyEncoding: BodyEncoding
}

/**
 * A single golden transcript representing one HTTP exchange
 */
export interface GoldenTranscript {
  /** Unique identifier */
  id: string
  /** Human-readable description */
  description: string
  /** Category for grouping */
  category: `create` | `append` | `read` | `delete` | `head` | `error` | `sse`
  /** Tags for filtering */
  tags: Array<string>
  /** The captured request */
  request: CapturedRequest
  /** The expected response */
  response: CapturedResponse
  /**
   * Headers to ignore during comparison (dynamic values like Date).
   * Names should be lowercase.
   */
  ignoreHeaders: Array<string>
  /**
   * Headers where only presence is checked, not value.
   * Useful for ETag, Stream-Next-Offset where format may vary.
   */
  presenceOnlyHeaders: Array<string>
  /**
   * If true, compare response body as parsed JSON (ignores whitespace/ordering).
   */
  semanticBodyComparison?: boolean
  /** Transcript format version */
  version: 1
  /** When this transcript was captured (ISO 8601) */
  capturedAt: string
  /** Protocol version */
  protocolVersion?: string
}

/**
 * A collection of transcripts
 */
export interface TranscriptFile {
  meta: {
    name: string
    description: string
    protocolVersion?: string
  }
  transcripts: Array<GoldenTranscript>
}

/**
 * Result of comparing a response to a golden transcript
 */
export interface ComparisonResult {
  passed: boolean
  transcriptId: string
  differences: Array<Difference>
  /** Actual response received */
  actual?: {
    status: number
    headers: HeaderTuples
    body: string
  }
}

/**
 * A specific difference found during comparison
 */
export interface Difference {
  type: `status` | `header` | `header-missing` | `header-extra` | `body`
  path: string
  expected: string
  actual: string
}

// =============================================================================
// Headers to always normalize (dynamic values)
// =============================================================================

/**
 * Default headers to ignore during comparison.
 * These contain dynamic values that change between requests.
 */
export const DEFAULT_IGNORE_HEADERS: Array<string> = [
  `date`,
  `x-request-id`,
  `x-correlation-id`,
  `server`,
  `x-powered-by`,
]

/**
 * Headers where we only check presence, not exact value.
 * These have implementation-specific formats.
 */
export const DEFAULT_PRESENCE_ONLY_HEADERS: Array<string> = [
  `etag`,
  `stream-next-offset`,
  `stream-cursor`,
]

// =============================================================================
// Capture utilities
// =============================================================================

/**
 * Normalize headers for golden comparison.
 * - Lowercases header names
 * - Sorts by name for consistent ordering
 * - Filters out ignored headers
 */
export function normalizeHeaders(
  headers: Headers | HeaderTuples,
  ignoreHeaders: Array<string> = DEFAULT_IGNORE_HEADERS
): HeaderTuples {
  const ignoreSet = new Set(ignoreHeaders.map((h) => h.toLowerCase()))

  let tuples: HeaderTuples

  if (headers instanceof Headers) {
    tuples = []
    headers.forEach((value, key) => {
      tuples.push([key.toLowerCase(), value])
    })
  } else {
    tuples = headers.map(([k, v]) => [k.toLowerCase(), v] as [string, string])
  }

  return tuples
    .filter(([k]) => !ignoreSet.has(k))
    .sort((a, b) => a[0].localeCompare(b[0]))
}

/**
 * Encode a body for storage in a transcript.
 * Uses UTF-8 for text content, base64 for binary.
 */
export function encodeBody(
  body: Uint8Array | string,
  contentType?: string
): { body: string; encoding: BodyEncoding } {
  if (typeof body === `string`) {
    return { body, encoding: `utf8` }
  }

  // Try to decode as UTF-8 for text content types
  const isText =
    contentType &&
    (contentType.startsWith(`text/`) ||
      contentType.includes(`json`) ||
      contentType.includes(`xml`))

  if (isText) {
    try {
      const decoded = new TextDecoder(`utf-8`, { fatal: true }).decode(body)
      return { body: decoded, encoding: `utf8` }
    } catch {
      // Fall through to base64
    }
  }

  return { body: Buffer.from(body).toString(`base64`), encoding: `base64` }
}

/**
 * Decode a body from transcript storage.
 */
export function decodeBody(body: string, encoding: BodyEncoding): Uint8Array {
  if (encoding === `utf8`) {
    return new TextEncoder().encode(body)
  }
  return new Uint8Array(Buffer.from(body, `base64`))
}

/**
 * Capture an HTTP exchange as a golden transcript.
 */
export async function captureExchange(
  serverUrl: string,
  request: {
    method: string
    path: string
    headers?: Record<string, string>
    body?: string | Uint8Array
  },
  options: {
    id: string
    description: string
    category: GoldenTranscript[`category`]
    tags?: Array<string>
    ignoreHeaders?: Array<string>
    presenceOnlyHeaders?: Array<string>
    semanticBodyComparison?: boolean
  }
): Promise<GoldenTranscript> {
  const url = new URL(request.path, serverUrl)

  // Prepare request headers
  const reqHeaders: HeaderTuples = []
  if (request.headers) {
    for (const [k, v] of Object.entries(request.headers)) {
      reqHeaders.push([k.toLowerCase(), v])
    }
  }

  // Encode request body
  const reqBodyEncoded = request.body
    ? encodeBody(
        request.body,
        request.headers?.[`content-type`] || request.headers?.[`Content-Type`]
      )
    : { body: ``, encoding: `utf8` as BodyEncoding }

  // Make the request
  const fetchHeaders = new Headers()
  for (const [k, v] of reqHeaders) {
    fetchHeaders.set(k, v)
  }

  // Convert body to a format fetch accepts
  let bodyInit: BodyInit | undefined
  if (request.body) {
    if (typeof request.body === `string`) {
      bodyInit = request.body
    } else {
      // Copy to new ArrayBuffer for fetch compatibility
      bodyInit = request.body.buffer.slice(
        request.body.byteOffset,
        request.body.byteOffset + request.body.byteLength
      ) as ArrayBuffer
    }
  }

  const response = await fetch(url.toString(), {
    method: request.method,
    headers: fetchHeaders,
    body: bodyInit,
  })

  // Capture response
  const resBody = await response.arrayBuffer()
  const resBodyEncoded = encodeBody(
    new Uint8Array(resBody),
    response.headers.get(`content-type`) || undefined
  )

  const ignoreHeaders = options.ignoreHeaders ?? DEFAULT_IGNORE_HEADERS
  const presenceOnlyHeaders =
    options.presenceOnlyHeaders ?? DEFAULT_PRESENCE_ONLY_HEADERS

  return {
    id: options.id,
    description: options.description,
    category: options.category,
    tags: options.tags ?? [],
    request: {
      method: request.method,
      path: request.path,
      headers: normalizeHeaders(reqHeaders, []),
      body: reqBodyEncoded.body,
      bodyEncoding: reqBodyEncoded.encoding,
    },
    response: {
      status: response.status,
      headers: normalizeHeaders(response.headers, ignoreHeaders),
      body: resBodyEncoded.body,
      bodyEncoding: resBodyEncoded.encoding,
    },
    ignoreHeaders,
    presenceOnlyHeaders,
    semanticBodyComparison: options.semanticBodyComparison,
    version: 1,
    capturedAt: new Date().toISOString(),
  }
}

// =============================================================================
// Verification utilities
// =============================================================================

/**
 * Replay a golden transcript against a server and compare the response.
 */
export async function verifyTranscript(
  serverUrl: string,
  transcript: GoldenTranscript
): Promise<ComparisonResult> {
  const url = new URL(transcript.request.path, serverUrl)

  // Build request headers
  const headers = new Headers()
  for (const [k, v] of transcript.request.headers) {
    headers.set(k, v)
  }

  // Decode request body and convert to fetch-compatible format
  let fetchBody: BodyInit | undefined
  if (transcript.request.body.length > 0) {
    const decoded = decodeBody(
      transcript.request.body,
      transcript.request.bodyEncoding
    )
    if (decoded instanceof Uint8Array) {
      // Copy to new ArrayBuffer for fetch compatibility
      fetchBody = decoded.buffer.slice(
        decoded.byteOffset,
        decoded.byteOffset + decoded.byteLength
      ) as ArrayBuffer
    } else {
      fetchBody = decoded
    }
  }

  // Make the request
  const response = await fetch(url.toString(), {
    method: transcript.request.method,
    headers,
    body: fetchBody,
  })

  // Capture actual response
  const actualBody = await response.arrayBuffer()
  const actualBodyEncoded = encodeBody(
    new Uint8Array(actualBody),
    response.headers.get(`content-type`) || undefined
  )

  const actualHeaders = normalizeHeaders(
    response.headers,
    transcript.ignoreHeaders
  )

  // Compare
  const differences: Array<Difference> = []

  // Status code
  if (response.status !== transcript.response.status) {
    differences.push({
      type: `status`,
      path: `status`,
      expected: String(transcript.response.status),
      actual: String(response.status),
    })
  }

  // Headers
  const expectedHeaderMap = new Map(transcript.response.headers)
  const actualHeaderMap = new Map(actualHeaders)
  const presenceOnlySet = new Set(
    transcript.presenceOnlyHeaders.map((h) => h.toLowerCase())
  )

  // Check expected headers
  for (const [name, expectedValue] of expectedHeaderMap) {
    const actualValue = actualHeaderMap.get(name)

    if (actualValue === undefined) {
      differences.push({
        type: `header-missing`,
        path: `headers.${name}`,
        expected: expectedValue,
        actual: `(missing)`,
      })
    } else if (!presenceOnlySet.has(name) && actualValue !== expectedValue) {
      differences.push({
        type: `header`,
        path: `headers.${name}`,
        expected: expectedValue,
        actual: actualValue,
      })
    }
  }

  // Check for unexpected headers (optional - can be noisy)
  // for (const [name] of actualHeaderMap) {
  //   if (!expectedHeaderMap.has(name)) {
  //     differences.push({
  //       type: `header-extra`,
  //       path: `headers.${name}`,
  //       expected: `(not present)`,
  //       actual: actualHeaderMap.get(name)!,
  //     })
  //   }
  // }

  // Body comparison
  if (transcript.semanticBodyComparison) {
    // Parse as JSON and compare semantically
    try {
      const expectedJson = JSON.parse(transcript.response.body)
      const actualJson = JSON.parse(actualBodyEncoded.body)

      if (JSON.stringify(expectedJson) !== JSON.stringify(actualJson)) {
        differences.push({
          type: `body`,
          path: `body`,
          expected: JSON.stringify(expectedJson, null, 2),
          actual: JSON.stringify(actualJson, null, 2),
        })
      }
    } catch {
      // Fall back to string comparison
      if (transcript.response.body !== actualBodyEncoded.body) {
        differences.push({
          type: `body`,
          path: `body`,
          expected: transcript.response.body,
          actual: actualBodyEncoded.body,
        })
      }
    }
  } else {
    // Byte-exact comparison
    if (transcript.response.body !== actualBodyEncoded.body) {
      differences.push({
        type: `body`,
        path: `body`,
        expected: truncate(transcript.response.body, 200),
        actual: truncate(actualBodyEncoded.body, 200),
      })
    }
  }

  return {
    passed: differences.length === 0,
    transcriptId: transcript.id,
    differences,
    actual: {
      status: response.status,
      headers: actualHeaders,
      body: actualBodyEncoded.body,
    },
  }
}

/**
 * Verify multiple transcripts against a server.
 */
export async function verifyTranscripts(
  serverUrl: string,
  transcripts: Array<GoldenTranscript>,
  options: {
    failFast?: boolean
    tags?: Array<string>
    categories?: Array<GoldenTranscript[`category`]>
  } = {}
): Promise<{
  total: number
  passed: number
  failed: number
  skipped: number
  results: Array<ComparisonResult>
}> {
  const results: Array<ComparisonResult> = []
  let passed = 0
  let failed = 0
  let skipped = 0

  const tagSet = options.tags ? new Set(options.tags) : null
  const categorySet = options.categories ? new Set(options.categories) : null

  for (const transcript of transcripts) {
    // Filter by tags
    if (tagSet && !transcript.tags.some((t) => tagSet.has(t))) {
      skipped++
      continue
    }

    // Filter by category
    if (categorySet && !categorySet.has(transcript.category)) {
      skipped++
      continue
    }

    const result = await verifyTranscript(serverUrl, transcript)
    results.push(result)

    if (result.passed) {
      passed++
    } else {
      failed++
      if (options.failFast) {
        break
      }
    }
  }

  return {
    total: transcripts.length,
    passed,
    failed,
    skipped,
    results,
  }
}

// =============================================================================
// Utilities
// =============================================================================

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen) + `... (${s.length - maxLen} more chars)`
}

/**
 * Format a comparison result for display.
 */
export function formatResult(result: ComparisonResult): string {
  const lines: Array<string> = []

  if (result.passed) {
    lines.push(`PASS: ${result.transcriptId}`)
  } else {
    lines.push(`FAIL: ${result.transcriptId}`)
    for (const diff of result.differences) {
      lines.push(`  ${diff.type} at ${diff.path}:`)
      lines.push(`    expected: ${diff.expected}`)
      lines.push(`    actual:   ${diff.actual}`)
    }
  }

  return lines.join(`\n`)
}

/**
 * Save transcripts to a JSON file.
 */
export function serializeTranscripts(file: TranscriptFile): string {
  return JSON.stringify(file, null, 2)
}

/**
 * Load transcripts from JSON.
 */
export function parseTranscripts(json: string): TranscriptFile {
  return JSON.parse(json) as TranscriptFile
}
