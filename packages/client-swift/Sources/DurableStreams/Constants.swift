// SPDX-License-Identifier: MIT
// DurableStreams Swift Client - Protocol Constants

import Foundation

/// HTTP header names used by the Durable Streams protocol.
enum Headers {
    /// Response header containing the next offset to read from
    static let streamNextOffset = "Stream-Next-Offset"

    /// Response header indicating stream is up-to-date (caught up to head)
    static let streamUpToDate = "Stream-Up-To-Date"

    /// Response header with cursor for CDN collapsing
    static let streamCursor = "Stream-Cursor"

    /// Request header for writer coordination sequence
    static let streamSeq = "Stream-Seq"

    /// Request header for TTL in seconds
    static let streamTTL = "Stream-TTL"

    /// Request header for absolute expiry time
    static let streamExpiresAt = "Stream-Expires-At"

    /// Request header for producer ID (idempotent producer)
    static let producerId = "Producer-Id"

    /// Request/Response header for producer epoch
    static let producerEpoch = "Producer-Epoch"

    /// Request header for producer sequence number
    static let producerSeq = "Producer-Seq"

    /// Response header for expected sequence (on 409 conflict)
    static let producerExpectedSeq = "Producer-Expected-Seq"

    /// Response header for received sequence (on 409 conflict)
    static let producerReceivedSeq = "Producer-Received-Seq"

    /// Request/Response header indicating stream is closed (EOF)
    static let streamClosed = "Stream-Closed"

    /// Response header indicating SSE data encoding (e.g., "base64")
    static let streamSSEDataEncoding = "Stream-SSE-Data-Encoding"

    /// Request header for optimistic concurrency control (ETag)
    static let ifMatch = "If-Match"
}

/// Query parameter names used by the Durable Streams protocol.
enum QueryParams {
    /// Starting offset for reads
    static let offset = "offset"

    /// Live mode (long-poll, sse)
    static let live = "live"

    /// Cursor for CDN collapsing
    static let cursor = "cursor"
}

/// Default values for client configuration.
enum Defaults {
    /// Default request timeout in seconds
    static let timeout: TimeInterval = 30

    /// Default long-poll timeout in seconds
    static let longPollTimeout: TimeInterval = 55

    /// Default max batch bytes for idempotent producer
    static let maxBatchBytes = 1_048_576  // 1MB

    /// Default linger time for batching in milliseconds
    static let lingerMs = 5

    /// Default max in-flight batches for idempotent producer
    static let maxInFlight = 5
}

/// Client version information.
public enum ClientInfo {
    public static let name = "swift"
    public static let version = "0.1.0"
}
