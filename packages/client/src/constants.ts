/**
 * Durable Streams Protocol Constants
 *
 * Header and query parameter names following the Electric Durable Stream Protocol.
 */

// ============================================================================
// Response Headers
// ============================================================================

/**
 * Response header containing the next offset to read from.
 * Format: "<read-seq>_<byte-offset>"
 */
export const STREAM_OFFSET_HEADER = `stream-offset`

/**
 * Response header for cursor (used for CDN collapsing).
 * Echo this value in subsequent long-poll requests.
 */
export const STREAM_CURSOR_HEADER = `stream-cursor`

/**
 * Presence header indicating response ends at current end of stream.
 * When present (any value), indicates up-to-date.
 */
export const STREAM_UP_TO_DATE_HEADER = `stream-up-to-date`

// ============================================================================
// Request Headers
// ============================================================================

/**
 * Request header for writer coordination sequence.
 * Monotonic, lexicographic. If lower than last appended seq -> 409 Conflict.
 */
export const STREAM_SEQ_HEADER = `stream-seq`

/**
 * Request header for stream TTL in seconds (on create).
 */
export const STREAM_TTL_HEADER = `stream-ttl`

/**
 * Request header for absolute stream expiry time (RFC3339, on create).
 */
export const STREAM_EXPIRES_AT_HEADER = `stream-expires-at`

// ============================================================================
// Query Parameters
// ============================================================================

/**
 * Query parameter for starting offset.
 */
export const OFFSET_QUERY_PARAM = `offset`

/**
 * Query parameter for live mode.
 * Values: "long-poll", "sse"
 */
export const LIVE_QUERY_PARAM = `live`

/**
 * Query parameter for echoing cursor (CDN collapsing).
 */
export const CURSOR_QUERY_PARAM = `cursor`

// ============================================================================
// Internal Constants
// ============================================================================

/**
 * Content types that support SSE mode.
 * SSE is only valid for text/* or application/json streams.
 */
export const SSE_COMPATIBLE_CONTENT_TYPES: ReadonlyArray<string> = [
  `text/`,
  `application/json`,
]

/**
 * Protocol query parameters that should not be set by users.
 */
export const DURABLE_STREAM_PROTOCOL_QUERY_PARAMS: Array<string> = [
  OFFSET_QUERY_PARAM,
  LIVE_QUERY_PARAM,
  CURSOR_QUERY_PARAM,
]
