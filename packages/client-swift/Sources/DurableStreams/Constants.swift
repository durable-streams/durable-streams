// SPDX-License-Identifier: Apache-2.0
// DurableStreams Swift Client - Protocol Constants

import Foundation

/// HTTP header names used by the Durable Streams protocol.
public enum Headers {
    /// Response header containing the next offset to read from
    public static let streamNextOffset = "Stream-Next-Offset"

    /// Response header indicating stream is up-to-date (caught up to head)
    public static let streamUpToDate = "Stream-Up-To-Date"

    /// Response header with cursor for CDN collapsing
    public static let streamCursor = "Stream-Cursor"

    /// Request header for writer coordination sequence
    public static let streamSeq = "Stream-Seq"

    /// Request header for TTL in seconds
    public static let streamTTL = "Stream-TTL"

    /// Request header for absolute expiry time
    public static let streamExpiresAt = "Stream-Expires-At"

    /// Request header for producer ID (idempotent producer)
    public static let producerId = "Producer-Id"

    /// Request/Response header for producer epoch
    public static let producerEpoch = "Producer-Epoch"

    /// Request header for producer sequence number
    public static let producerSeq = "Producer-Seq"

    /// Response header for expected sequence (on 409 conflict)
    public static let producerExpectedSeq = "Producer-Expected-Seq"

    /// Response header for received sequence (on 409 conflict)
    public static let producerReceivedSeq = "Producer-Received-Seq"
}

/// Query parameter names used by the Durable Streams protocol.
public enum QueryParams {
    /// Starting offset for reads
    public static let offset = "offset"

    /// Live mode (long-poll, sse)
    public static let live = "live"

    /// Cursor for CDN collapsing
    public static let cursor = "cursor"
}

/// Default values for client configuration.
public enum Defaults {
    /// Default request timeout in seconds
    public static let timeout: TimeInterval = 30

    /// Default long-poll timeout in seconds
    public static let longPollTimeout: TimeInterval = 55

    /// Default max batch bytes for idempotent producer
    public static let maxBatchBytes = 1_048_576  // 1MB

    /// Default linger time for batching in milliseconds
    public static let lingerMs = 5

    /// Default max in-flight batches for idempotent producer
    public static let maxInFlight = 5
}

/// Client version information.
public enum ClientInfo {
    public static let name = "swift"
    public static let version = "0.1.0"
}
