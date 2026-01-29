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
 * Offsets are opaque tokens - clients MUST NOT interpret the format.
 */
export const STREAM_OFFSET_HEADER = `Stream-Next-Offset`

/**
 * Response header for cursor (used for CDN collapsing).
 * Echo this value in subsequent long-poll requests.
 */
export const STREAM_CURSOR_HEADER = `Stream-Cursor`

/**
 * Presence header indicating response ends at current end of stream.
 * When present (any value), indicates up-to-date.
 */
export const STREAM_UP_TO_DATE_HEADER = `Stream-Up-To-Date`

/**
 * Response/request header indicating stream is closed (EOF).
 * When present with value "true", the stream is permanently closed.
 */
export const STREAM_CLOSED_HEADER = `Stream-Closed`

// ============================================================================
// Request Headers
// ============================================================================

/**
 * Request header for writer coordination sequence.
 * Monotonic, lexicographic. If lower than last appended seq -> 409 Conflict.
 */
export const STREAM_SEQ_HEADER = `Stream-Seq`

/**
 * Request header for stream TTL in seconds (on create).
 */
export const STREAM_TTL_HEADER = `Stream-TTL`

/**
 * Request header for absolute stream expiry time (RFC3339, on create).
 */
export const STREAM_EXPIRES_AT_HEADER = `Stream-Expires-At`

// ============================================================================
// Idempotent Producer Headers
// ============================================================================

/**
 * Request header for producer ID (client-supplied stable identifier).
 */
export const PRODUCER_ID_HEADER = `Producer-Id`

/**
 * Request/response header for producer epoch.
 * Client-declared, server-validated monotonically increasing.
 */
export const PRODUCER_EPOCH_HEADER = `Producer-Epoch`

/**
 * Request header for producer sequence number.
 * Monotonically increasing per epoch, per-batch (not per-message).
 */
export const PRODUCER_SEQ_HEADER = `Producer-Seq`

/**
 * Response header indicating expected sequence number on 409 Conflict.
 */
export const PRODUCER_EXPECTED_SEQ_HEADER = `Producer-Expected-Seq`

/**
 * Response header indicating received sequence number on 409 Conflict.
 */
export const PRODUCER_RECEIVED_SEQ_HEADER = `Producer-Received-Seq`

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

/**
 * Response header indicating SSE data encoding (e.g., base64 for binary streams).
 */
export const STREAM_SSE_DATA_ENCODING_HEADER = `stream-sse-data-encoding`

// ============================================================================
// SSE Control Event Fields (camelCase per PROTOCOL.md Section 5.7)
// ============================================================================

/**
 * SSE control event field for the next offset.
 * Note: Different from HTTP header name (camelCase vs Header-Case).
 */
export const SSE_OFFSET_FIELD = `streamNextOffset`

/**
 * SSE control event field for cursor.
 * Note: Different from HTTP header name (camelCase vs Header-Case).
 */
export const SSE_CURSOR_FIELD = `streamCursor`

/**
 * SSE control event field for stream closed state.
 * Note: Different from HTTP header name (camelCase vs Header-Case).
 */
export const SSE_CLOSED_FIELD = `streamClosed`

// ============================================================================
// Internal Constants
// ============================================================================

/**
 * Content types that are natively compatible with SSE (UTF-8 text).
 * Binary content types are also supported via automatic base64 encoding.
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
